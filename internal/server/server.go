package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

const nativeCookie = "propresenter-native=1; Path=/; SameSite=Lax"

var hopByHopHeaders = []string{
	"Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"TE",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

type handler struct {
	worker       http.Handler
	propresenter http.Handler
}

// NewHandler creates the local reverse proxy for the Worker UI and
// ProPresenter's /v1 API. Only GET and HEAD requests are accepted.
//
// The URLs are validated when the handler is created. Since the public API
// returns an http.Handler rather than an error, invalid configuration is
// reported as a 500 response from the returned handler.
func NewHandler(workerURL, propresenterURL string, client *http.Client) http.Handler {
	workerTarget, err := parseUpstreamURL(workerURL)
	if err != nil {
		return configurationErrorHandler{label: "worker", err: err}
	}

	propresenterTarget, err := parseUpstreamURL(propresenterURL)
	if err != nil {
		return configurationErrorHandler{label: "propresenter", err: err}
	}

	return &handler{
		worker:       newReverseProxy(workerTarget, client, false),
		propresenter: newReverseProxy(propresenterTarget, client, true),
	}
}

func parseUpstreamURL(raw string) (*url.URL, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, fmt.Errorf("URL is required")
	}
	target, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}
	if !target.IsAbs() || target.Host == "" {
		return nil, fmt.Errorf("URL must be absolute and include a host")
	}
	if !strings.EqualFold(target.Scheme, "http") && !strings.EqualFold(target.Scheme, "https") {
		return nil, fmt.Errorf("URL scheme must be http or https")
	}
	target.Scheme = strings.ToLower(target.Scheme)
	if target.Fragment != "" {
		return nil, fmt.Errorf("URL must not contain a fragment")
	}
	return target, nil
}

func newReverseProxy(target *url.URL, client *http.Client, isProPresenter bool) http.Handler {
	proxy := &httputil.ReverseProxy{
		Director: func(request *http.Request) {
			removeHopByHopHeaders(request.Header)

			incomingPath := request.URL.EscapedPath()
			if incomingPath == "" {
				incomingPath = "/"
			}
			basePath := strings.TrimRight(target.EscapedPath(), "/")
			joinedPath := basePath + incomingPath
			if joinedPath == "" {
				joinedPath = "/"
			}

			decodedPath, err := url.PathUnescape(joinedPath)
			if err != nil {
				// Requests accepted by net/http have a valid escaped path. Keep a
				// safe fallback for manually constructed requests in tests.
				decodedPath = request.URL.Path
			}

			upstreamURL := *target
			upstreamURL.Path = decodedPath
			upstreamURL.RawPath = joinedPath
			upstreamURL.RawQuery = joinRawQuery(target.RawQuery, request.URL.RawQuery)
			upstreamURL.Fragment = ""
			request.URL = &upstreamURL
			request.Host = target.Host
		},
		Transport: proxyTransport(client),
		ErrorHandler: func(responseWriter http.ResponseWriter, _ *http.Request, err error) {
			label := "worker"
			if isProPresenter {
				label = "propresenter"
			}
			http.Error(responseWriter, fmt.Sprintf("%s upstream error: %v", label, err), http.StatusBadGateway)
		},
		ModifyResponse: func(response *http.Response) error {
			removeHopByHopHeaders(response.Header)
			if !isProPresenter && isHTMLResponse(response) {
				response.Header.Add("Set-Cookie", nativeCookie)
			}
			return nil
		},
	}
	return proxy
}

func proxyTransport(client *http.Client) http.RoundTripper {
	if client == nil {
		return http.DefaultTransport
	}

	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	if client.Timeout <= 0 {
		return transport
	}
	return timeoutTransport{base: transport, timeout: client.Timeout}
}

type timeoutTransport struct {
	base    http.RoundTripper
	timeout time.Duration
}

func (transport timeoutTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	contextWithTimeout, cancel := context.WithTimeout(request.Context(), transport.timeout)
	response, err := transport.base.RoundTrip(request.WithContext(contextWithTimeout))
	if err != nil {
		cancel()
		return nil, err
	}
	response.Body = &cancelReadCloser{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (body *cancelReadCloser) Close() error {
	err := body.ReadCloser.Close()
	body.cancel()
	return err
}

func joinRawQuery(base, incoming string) string {
	switch {
	case base == "":
		return incoming
	case incoming == "":
		return base
	default:
		return base + "&" + incoming
	}
}

func isHTMLResponse(response *http.Response) bool {
	contentType := response.Header.Get("Content-Type")
	mediaType := strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0])
	return strings.EqualFold(mediaType, "text/html")
}

func removeHopByHopHeaders(header http.Header) {
	for key, values := range header {
		if strings.EqualFold(key, "Connection") {
			for _, connection := range values {
				for _, name := range strings.Split(connection, ",") {
					deleteHeaderCaseInsensitive(header, strings.TrimSpace(name))
				}
			}
		}
	}
	for _, name := range hopByHopHeaders {
		deleteHeaderCaseInsensitive(header, name)
	}
}

func deleteHeaderCaseInsensitive(header http.Header, name string) {
	for key := range header {
		if strings.EqualFold(key, name) {
			delete(header, key)
		}
	}
}

func (proxy *handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		responseWriter.Header().Set("Allow", "GET, HEAD")
		http.Error(responseWriter, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var upstream http.Handler
	if request.URL.Path == "/v1" || strings.HasPrefix(request.URL.Path, "/v1/") {
		upstream = proxy.propresenter
	} else {
		upstream = proxy.worker
	}
	if request.Method == http.MethodHead {
		upstream.ServeHTTP(headResponseWriter{ResponseWriter: responseWriter}, request)
		return
	}
	upstream.ServeHTTP(responseWriter, request)
}

type headResponseWriter struct {
	http.ResponseWriter
}

func (writer headResponseWriter) Write(body []byte) (int, error) {
	return len(body), nil
}

type configurationErrorHandler struct {
	label string
	err   error
}

func (handler configurationErrorHandler) ServeHTTP(responseWriter http.ResponseWriter, _ *http.Request) {
	http.Error(responseWriter, fmt.Sprintf("invalid %s upstream configuration: %v", handler.label, handler.err), http.StatusInternalServerError)
}
