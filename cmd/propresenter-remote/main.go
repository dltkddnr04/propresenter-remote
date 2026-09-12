package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/dltkddnr04/propresenter-remote/internal/menubar"
	"github.com/dltkddnr04/propresenter-remote/internal/server"
)

const (
	outboundHTTPTimeout = 15 * time.Second
	defaultWorkerURL    = "https://propresenter-remote.alice-data-lab.workers.dev/"
)

type options struct {
	workerURL       string
	propresenterURL string
	listen          string
	open            bool
	readTimeout     time.Duration
	writeTimeout    time.Duration
}

type savedConfig struct {
	WorkerURL string `json:"workerURL"`
}

var openBrowser = func(target string) error {
	return exec.Command("open", target).Run()
}

func main() {
	// AppKit requires the status item to be created on the process's original
	// macOS main thread. Lock it before the HTTP server creates goroutines.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if runtime.GOOS != "darwin" {
		fmt.Fprintln(os.Stderr, "ProPresenter Remote is macOS-only and requires Darwin.")
		os.Exit(1)
	}
	if err := run(os.Args[1:]); err != nil {
		log.Printf("ProPresenter Remote stopped: %v", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	return runForOS(args, runtime.GOOS, openBrowser)
}

func runForOS(args []string, goos string, open func(string) error) error {
	if goos != "darwin" {
		return fmt.Errorf("ProPresenter Remote is macOS-only (current OS: %s)", goos)
	}

	config, err := parseOptions(args)
	if err != nil {
		return err
	}
	if err := validateURL(config.workerURL); err != nil {
		showAlert(fmt.Sprintf("Worker URL 설정이 올바르지 않습니다.\n%s", err))
		return fmt.Errorf("invalid worker URL: %w", err)
	}
	if err := validateURL(config.propresenterURL); err != nil {
		return fmt.Errorf("invalid ProPresenter URL: %w", err)
	}
	if err := validateListenAddress(config.listen); err != nil {
		return err
	}
	if config.readTimeout < 0 || config.writeTimeout < 0 {
		return fmt.Errorf("read and write timeouts must not be negative")
	}

	listener, err := net.Listen("tcp", config.listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", config.listen, err)
	}
	defer listener.Close()

	proxyHandler := server.NewHandler(config.workerURL, config.propresenterURL, &http.Client{Timeout: outboundHTTPTimeout})
	httpServer := &http.Server{
		Handler:      proxyHandler,
		ReadTimeout:  config.readTimeout,
		WriteTimeout: config.writeTimeout,
	}

	log.Printf("ProPresenter Remote listening on %s", listener.Addr().String())
	urlToOpen, browserErr := browserURL(listener.Addr().String())
	if browserErr != nil {
		return browserErr
	}
	accessURL, accessErr := lanAccessURL(listener.Addr().String())
	if accessErr != nil {
		return accessErr
	}
	log.Printf("Share this URL on the local network: %s", accessURL)
	if open == nil {
		open = func(string) error { return nil }
	}
	openLocalBrowser := func() {
		if openErr := open(urlToOpen); openErr != nil {
			log.Printf("could not open %s: %v", urlToOpen, openErr)
		}
	}
	if config.open {
		openLocalBrowser()
	}

	serveResult := make(chan error, 1)
	go func() {
		serveResult <- httpServer.Serve(listener)
	}()

	shutdownSignal, stopSignal := signalContext()
	defer stopSignal()
	shutdownRequest := make(chan struct{}, 1)
	finish := make(chan error, 1)
	go func() {
		var serveErr error
		shutdown := func() error {
			shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := httpServer.Shutdown(shutdownContext); err != nil {
				return fmt.Errorf("graceful shutdown: %w", err)
			}
			return <-serveResult
		}
		select {
		case serveErr = <-serveResult:
		case <-shutdownSignal.Done():
			serveErr = shutdown()
		case <-shutdownRequest:
			serveErr = shutdown()
		}

		menubar.Quit()
		if errors.Is(serveErr, http.ErrServerClosed) {
			finish <- nil
			return
		}
		finish <- serveErr
	}()

	menuErr := menubar.Run(accessURL, menubar.Callbacks{
		Open: openLocalBrowser,
		Configure: func() {
			configureWorkerURL(config.workerURL)
		},
		Quit: func() {
			select {
			case shutdownRequest <- struct{}{}:
			default:
			}
		},
	})
	if menuErr != nil {
		select {
		case shutdownRequest <- struct{}{}:
		default:
		}
		return menuErr
	}
	return <-finish
}

func signalContext() (context.Context, context.CancelFunc) {
	return signalNotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

var signalNotifyContext = func(parent context.Context, signals ...os.Signal) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(parent, signals...)
}

func configureWorkerURL(current string) {
	next, err := promptWorkerURL(current)
	if err != nil {
		log.Printf("Worker URL configuration cancelled or failed: %v", err)
		return
	}
	if err := validateURL(next); err != nil {
		showAlert(fmt.Sprintf("Worker URL이 올바르지 않습니다.\n%s", err))
		return
	}
	if err := saveWorkerURL(next); err != nil {
		showAlert(fmt.Sprintf("Worker URL 저장에 실패했습니다.\n%s", err))
		return
	}
	showAlert("Worker URL을 저장했습니다. 변경 사항은 다음 실행부터 적용됩니다.")
}

func promptWorkerURL(current string) (string, error) {
	script := fmt.Sprintf(`text returned of (display dialog "Worker URL" default answer "%s" buttons {"취소", "저장"} default button "저장")`, appleScriptString(current))
	output, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func showAlert(message string) {
	script := fmt.Sprintf(`display alert "ProPresenter Remote" message "%s"`, appleScriptString(message))
	_ = exec.Command("osascript", "-e", script).Run()
}

func appleScriptString(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return strings.ReplaceAll(value, "\n", `\n`)
}

func workerURLFromConfig() string {
	path, err := configFilePath()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var config savedConfig
	if json.Unmarshal(data, &config) != nil {
		return ""
	}
	return strings.TrimSpace(config.WorkerURL)
}

func saveWorkerURL(workerURL string) error {
	path, err := configFilePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(savedConfig{WorkerURL: strings.TrimSpace(workerURL)})
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func configFilePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "Application Support", "ProPresenter Remote", "config.json"), nil
}

func initialWorkerURL() string {
	if fromEnvironment := strings.TrimSpace(os.Getenv("PROPPRESENTER_WORKER_URL")); fromEnvironment != "" {
		return fromEnvironment
	}
	if fromConfig := workerURLFromConfig(); fromConfig != "" {
		return fromConfig
	}
	return defaultWorkerURL
}

func parseOptions(args []string) (options, error) {
	flags := flag.NewFlagSet("propresenter-remote", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	config := options{
		workerURL:       initialWorkerURL(),
		propresenterURL: "http://127.0.0.1:1025",
		listen:          "0.0.0.0:8787",
		readTimeout:     15 * time.Second,
		writeTimeout:    15 * time.Second,
	}
	flags.StringVar(&config.workerURL, "worker-url", config.workerURL, "Worker absolute URL (or PROPPRESENTER_WORKER_URL)")
	flags.StringVar(&config.propresenterURL, "propresenter-url", config.propresenterURL, "ProPresenter API absolute URL")
	flags.StringVar(&config.listen, "listen", config.listen, "listen address")
	flags.BoolVar(&config.open, "open", true, "open the local URL in the default browser")
	flags.DurationVar(&config.readTimeout, "read-timeout", config.readTimeout, "HTTP server read timeout")
	flags.DurationVar(&config.writeTimeout, "write-timeout", config.writeTimeout, "HTTP server write timeout")
	if err := flags.Parse(args); err != nil {
		return options{}, err
	}
	if flags.NArg() != 0 {
		return options{}, fmt.Errorf("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}
	return config, nil
}

func validateURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("URL is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("cannot parse URL: %w", err)
	}
	if !parsed.IsAbs() || parsed.Host == "" {
		return fmt.Errorf("URL must be absolute and include a host")
	}
	if !strings.EqualFold(parsed.Scheme, "http") && !strings.EqualFold(parsed.Scheme, "https") {
		return fmt.Errorf("URL scheme must be http or https")
	}
	if parsed.Fragment != "" {
		return fmt.Errorf("URL must not contain a fragment")
	}
	return nil
}

func validateListenAddress(address string) error {
	if strings.TrimSpace(address) == "" {
		return fmt.Errorf("listen address is required")
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: use host:port", address)
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 0 || portNumber > 65535 {
		return fmt.Errorf("invalid listen port %q: use a number from 0 to 65535", port)
	}
	return nil
}

func browserURL(listenAddress string) (string, error) {
	_, port, err := net.SplitHostPort(listenAddress)
	if err != nil {
		return "", fmt.Errorf("invalid listen address %q: %w", listenAddress, err)
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 0 || portNumber > 65535 {
		return "", fmt.Errorf("invalid listen port %q", port)
	}
	return fmt.Sprintf("http://127.0.0.1:%d", portNumber), nil
}

func lanAccessURL(listenAddress string) (string, error) {
	return accessURLForIPs(listenAddress, privateIPv4s())
}

func accessURLForIPs(listenAddress string, ips []net.IP) (string, error) {
	host, port, err := net.SplitHostPort(listenAddress)
	if err != nil {
		return "", fmt.Errorf("invalid listen address %q: %w", listenAddress, err)
	}
	if host != "" && host != "0.0.0.0" && host != "::" {
		return "http://" + net.JoinHostPort(host, port), nil
	}

	privateIPs := make([]string, 0, len(ips))
	for _, ip := range ips {
		if ipv4 := ip.To4(); ipv4 != nil && !ipv4.IsLoopback() && ipv4.IsPrivate() {
			privateIPs = append(privateIPs, ipv4.String())
		}
	}
	sort.Strings(privateIPs)
	if len(privateIPs) > 0 {
		return "http://" + net.JoinHostPort(privateIPs[0], port), nil
	}
	return "http://" + net.JoinHostPort("127.0.0.1", port), nil
}

func privateIPv4s() []net.IP {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}

	var ips []net.IP
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			var ip net.IP
			switch value := address.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if ipv4 := ip.To4(); ipv4 != nil && !ipv4.IsLoopback() && ipv4.IsPrivate() {
				ips = append(ips, ipv4)
			}
		}
	}
	return ips
}
