package server

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestNewHandlerRoutesAPIAndWorkerPaths(t *testing.T) {
	var requests []*http.Request
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request)
		body := "worker"
		contentType := "text/html; charset=utf-8"
		header := http.Header{"Cache-Control": {"public, max-age=60"}, "Content-Type": {contentType}}
		if request.URL.Host == "127.0.0.1:1025" {
			body = "propresenter"
			contentType = "application/json"
			header = http.Header{"Cache-Control": {"public, max-age=60"}, "Content-Type": {contentType}}
		} else {
			header["Connection"] = []string{"X-Worker-Hop"}
			header["X-Worker-Hop"] = []string{"should-not-copy"}
		}
		return response(request, http.StatusAccepted, header, body), nil
	})
	handler := NewHandler("http://127.0.0.1:8788/", "http://127.0.0.1:1025", &http.Client{Transport: transport})

	workerRequest := httptest.NewRequest(http.MethodGet, "http://proxy.local/remote?view=live", nil)
	workerRecorder := httptest.NewRecorder()
	handler.ServeHTTP(workerRecorder, workerRequest)
	if workerRecorder.Code != http.StatusAccepted {
		t.Fatalf("worker status = %d, want %d", workerRecorder.Code, http.StatusAccepted)
	}
	if workerRecorder.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("worker content type = %q", workerRecorder.Header().Get("Content-Type"))
	}
	if workerRecorder.Header().Get("Cache-Control") != "public, max-age=60" {
		t.Fatalf("cache control = %q", workerRecorder.Header().Get("Cache-Control"))
	}
	if workerRecorder.Body.String() != "worker" {
		t.Fatalf("worker body = %q", workerRecorder.Body.String())
	}
	if workerRecorder.Header().Get("Connection") != "" || workerRecorder.Header().Get("X-Worker-Hop") != "" {
		t.Fatalf("hop-by-hop headers were copied: %#v", workerRecorder.Header())
	}

	apiRequest := httptest.NewRequest(http.MethodHead, "http://proxy.local/v1/presentation/active?chunked=false", nil)
	apiRecorder := httptest.NewRecorder()
	handler.ServeHTTP(apiRecorder, apiRequest)
	if apiRecorder.Code != http.StatusAccepted {
		t.Fatalf("API status = %d, want %d", apiRecorder.Code, http.StatusAccepted)
	}
	if apiRecorder.Body.Len() != 0 {
		t.Fatalf("HEAD response body length = %d, want 0", apiRecorder.Body.Len())
	}

	if len(requests) != 2 {
		t.Fatalf("upstream request count = %d, want 2", len(requests))
	}
	if requests[0].URL.String() != "http://127.0.0.1:8788/remote?view=live" {
		t.Fatalf("worker upstream URL = %q", requests[0].URL.String())
	}
	if requests[0].Method != http.MethodGet || requests[0].Host != "127.0.0.1:8788" {
		t.Fatalf("worker method/host = %s/%q", requests[0].Method, requests[0].Host)
	}
	if requests[1].URL.String() != "http://127.0.0.1:1025/v1/presentation/active?chunked=false" {
		t.Fatalf("API upstream URL = %q", requests[1].URL.String())
	}
	if requests[1].Method != http.MethodHead || requests[1].Host != "127.0.0.1:1025" {
		t.Fatalf("API method/host = %s/%q", requests[1].Method, requests[1].Host)
	}
}

func TestNewHandlerPreservesWorkerPathTraversalAndConfiguredPrefix(t *testing.T) {
	var gotURL *url.URL
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		copy := *request.URL
		gotURL = &copy
		return response(request, http.StatusOK, http.Header{"Content-Type": {"text/plain"}}, "ok"), nil
	})
	handler := NewHandler("http://127.0.0.1:8788/static/", "http://127.0.0.1:1025", &http.Client{Transport: transport})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "http://proxy.local/../remote/%2Fslide?x=1", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if gotURL == nil {
		t.Fatal("upstream request was not captured")
	}
	if gotURL.Host != "127.0.0.1:8788" {
		t.Fatalf("upstream host = %q", gotURL.Host)
	}
	if gotURL.EscapedPath() != "/static/../remote/%2Fslide" {
		t.Fatalf("upstream escaped path = %q", gotURL.EscapedPath())
	}
	if gotURL.RawQuery != "x=1" {
		t.Fatalf("upstream query = %q", gotURL.RawQuery)
	}
}

func TestNewHandlerAddsNativeCookieOnlyToHTMLWithoutCookie(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/with-cookie" {
			return response(request, http.StatusOK, http.Header{
				"Content-Type": {"text/html"},
				"Set-Cookie":   {"existing=1; Path=/"},
			}, "existing"), nil
		}
		if request.URL.Path == "/text" {
			return response(request, http.StatusOK, http.Header{"Content-Type": {"text/plain"}}, "text"), nil
		}
		return response(request, http.StatusOK, http.Header{"Content-Type": {"text/html; charset=utf-8"}}, "html"), nil
	})
	handler := NewHandler("http://127.0.0.1:8788", "http://127.0.0.1:1025", &http.Client{Transport: transport})

	withoutCookie := httptest.NewRecorder()
	handler.ServeHTTP(withoutCookie, httptest.NewRequest(http.MethodGet, "http://proxy.local/", nil))
	if got := withoutCookie.Header().Values("Set-Cookie"); len(got) != 1 || got[0] != nativeCookie {
		t.Fatalf("native cookie = %#v", got)
	}

	withCookie := httptest.NewRecorder()
	handler.ServeHTTP(withCookie, httptest.NewRequest(http.MethodGet, "http://proxy.local/with-cookie", nil))
	if got := withCookie.Header().Values("Set-Cookie"); len(got) != 2 || got[0] != "existing=1; Path=/" || got[1] != nativeCookie {
		t.Fatalf("existing cookie = %#v", got)
	}

	text := httptest.NewRecorder()
	handler.ServeHTTP(text, httptest.NewRequest(http.MethodGet, "http://proxy.local/text", nil))
	if got := text.Header().Values("Set-Cookie"); len(got) != 0 {
		t.Fatalf("text response cookies = %#v", got)
	}
}

func TestNewHandlerRejectsDisallowedMethods(t *testing.T) {
	called := false
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		called = true
		return response(request, http.StatusOK, nil, "unexpected"), nil
	})
	handler := NewHandler("http://127.0.0.1:8788", "http://127.0.0.1:1025", &http.Client{Transport: transport})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "http://proxy.local/v1/trigger/next", strings.NewReader("body")))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
	if recorder.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("Allow = %q", recorder.Header().Get("Allow"))
	}
	if called {
		t.Fatal("disallowed request reached upstream")
	}
}

func TestNewHandlerReturnsBadGatewayForUpstreamError(t *testing.T) {
	transport := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection refused")
	})
	handler := NewHandler("http://127.0.0.1:8788", "http://127.0.0.1:1025", &http.Client{Transport: transport})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "http://proxy.local/v1", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadGateway)
	}
	if !strings.Contains(recorder.Body.String(), "upstream error") {
		t.Fatalf("error body = %q", recorder.Body.String())
	}
}

func TestNewHandlerReportsInvalidConfiguration(t *testing.T) {
	handler := NewHandler("worker-relative", "http://127.0.0.1:1025", http.DefaultClient)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "http://proxy.local/", nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
	if !strings.Contains(recorder.Body.String(), "invalid worker upstream configuration") {
		t.Fatalf("error body = %q", recorder.Body.String())
	}
}

func response(request *http.Request, status int, header http.Header, body string) *http.Response {
	if header == nil {
		header = make(http.Header)
	}
	return &http.Response{
		StatusCode:    status,
		Status:        http.StatusText(status),
		Header:        header,
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
		Request:       request,
	}
}
