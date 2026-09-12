package main

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidateURL(t *testing.T) {
	valid := []string{
		"http://127.0.0.1:8788/",
		"https://worker.example.com/app",
		"HTTPS://worker.example.com/app",
	}
	for _, value := range valid {
		if err := validateURL(value); err != nil {
			t.Errorf("validateURL(%q) = %v, want nil", value, err)
		}
	}

	invalid := []string{
		"",
		"worker.example.com",
		"ftp://worker.example.com",
		"http:///missing-host",
		"http://worker.example.com/#fragment",
	}
	for _, value := range invalid {
		if err := validateURL(value); err == nil {
			t.Errorf("validateURL(%q) = nil, want error", value)
		}
	}
}

func TestParseOptionsUsesEnvironmentAndDefaults(t *testing.T) {
	t.Setenv("PROPPRESENTER_WORKER_URL", "https://worker.example.com/")
	config, err := parseOptions(nil)
	if err != nil {
		t.Fatalf("parseOptions() error = %v", err)
	}
	if config.workerURL != "https://worker.example.com/" {
		t.Fatalf("workerURL = %q", config.workerURL)
	}
	if config.propresenterURL != "http://127.0.0.1:1025" {
		t.Fatalf("propresenterURL = %q", config.propresenterURL)
	}
	if config.listen != "0.0.0.0:8787" {
		t.Fatalf("listen = %q", config.listen)
	}
	if !config.open {
		t.Fatal("open default = false, want true")
	}
	if config.readTimeout <= 0 || config.writeTimeout <= 0 {
		t.Fatalf("timeouts = %s/%s, want positive defaults", config.readTimeout, config.writeTimeout)
	}
}

func TestParseOptionsUsesDefaultWorkerURL(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PROPPRESENTER_WORKER_URL", "")
	config, err := parseOptions(nil)
	if err != nil {
		t.Fatalf("parseOptions() error = %v", err)
	}
	if config.workerURL != defaultWorkerURL {
		t.Fatalf("workerURL = %q, want default %q", config.workerURL, defaultWorkerURL)
	}
}

func TestInitialWorkerURLUsesConfigThenEnvironmentThenDefault(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PROPPRESENTER_WORKER_URL", "")
	if got := initialWorkerURL(); got != defaultWorkerURL {
		t.Fatalf("initialWorkerURL() = %q, want default %q", got, defaultWorkerURL)
	}

	path, err := configFilePath()
	if err != nil {
		t.Fatalf("configFilePath() error = %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(path, []byte(`{"workerURL":"https://saved.example.com/"}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if got := initialWorkerURL(); got != "https://saved.example.com/" {
		t.Fatalf("initialWorkerURL() = %q, want saved URL", got)
	}

	t.Setenv("PROPPRESENTER_WORKER_URL", "https://environment.example.com/")
	if got := initialWorkerURL(); got != "https://environment.example.com/" {
		t.Fatalf("initialWorkerURL() = %q, want environment URL", got)
	}
}

func TestParseOptionsFlagOverridesEnvironment(t *testing.T) {
	t.Setenv("PROPPRESENTER_WORKER_URL", "https://environment.example.com")
	config, err := parseOptions([]string{
		"-worker-url", "http://127.0.0.1:8788/",
		"-propresenter-url", "https://127.0.0.1:1025/base",
		"-listen", "127.0.0.1:9000",
		"-open=false",
		"-read-timeout", "2s",
		"-write-timeout", "3s",
	})
	if err != nil {
		t.Fatalf("parseOptions() error = %v", err)
	}
	if config.workerURL != "http://127.0.0.1:8788/" || config.propresenterURL != "https://127.0.0.1:1025/base" {
		t.Fatalf("URLs = %q/%q", config.workerURL, config.propresenterURL)
	}
	if config.listen != "127.0.0.1:9000" || config.open {
		t.Fatalf("listen/open = %q/%t", config.listen, config.open)
	}
	if config.readTimeout != 2*time.Second || config.writeTimeout != 3*time.Second {
		t.Fatalf("timeouts = %s/%s", config.readTimeout, config.writeTimeout)
	}
}

func TestBrowserURL(t *testing.T) {
	got, err := browserURL("0.0.0.0:8787")
	if err != nil {
		t.Fatalf("browserURL() error = %v", err)
	}
	if got != "http://127.0.0.1:8787" {
		t.Fatalf("browserURL() = %q", got)
	}

	if _, err := browserURL("8787"); err == nil {
		t.Fatal("browserURL(8787) = nil error")
	}
}

func TestAccessURLForIPs(t *testing.T) {
	lanURL, err := accessURLForIPs("0.0.0.0:8787", []net.IP{
		net.ParseIP("127.0.0.1"),
		net.ParseIP("192.168.0.42"),
		net.ParseIP("10.0.0.9"),
	})
	if err != nil {
		t.Fatalf("accessURLForIPs() error = %v", err)
	}
	if lanURL != "http://10.0.0.9:8787" {
		t.Fatalf("LAN URL = %q", lanURL)
	}

	localhostURL, err := accessURLForIPs("127.0.0.1:9000", nil)
	if err != nil {
		t.Fatalf("accessURLForIPs() error = %v", err)
	}
	if localhostURL != "http://127.0.0.1:9000" {
		t.Fatalf("localhost URL = %q", localhostURL)
	}

	fallbackURL, err := accessURLForIPs("[::]:8787", nil)
	if err != nil {
		t.Fatalf("accessURLForIPs() error = %v", err)
	}
	if fallbackURL != "http://127.0.0.1:8787" {
		t.Fatalf("fallback URL = %q", fallbackURL)
	}
}

func TestRunForOSRejectsNonDarwin(t *testing.T) {
	err := runForOS(nil, "linux", nil)
	if err == nil || !strings.Contains(err.Error(), "macOS-only") {
		t.Fatalf("runForOS() error = %v, want macOS-only error", err)
	}
}
