package providers

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	got := Parse([]string{
		"PATH=/usr/bin",
		EnvPrefix + "CHROME=Chrome ports|http://chrome-front:8090/",
		EnvPrefix + "ROBLOX_STUDIO=Studio|https://roblox_studio/ui/",
		EnvPrefix + "BY_IP=By IP|http://172.30.0.5:81",
		EnvPrefix + "V6=v6|http://[fd00::1]:8080/",
		EnvPrefix + "OFF=",
		EnvPrefix + "NOPIPE=Just a title",
		EnvPrefix + "NOTITLE=|http://x/",
		EnvPrefix + "DOTTED=Evil|https://example.com/",
		EnvPrefix + "LOCALDOT=Evil|http://chrome-front.internal/",
		EnvPrefix + "SCHEME=Evil|file:///etc/passwd",
		EnvPrefix + "JS=Evil|javascript:alert(1)",
		EnvPrefix + "NOHOST=Broken|http://",
		EnvPrefix + "CREDS=Creds|http://u:p@chrome-front/",
		EnvPrefix + "lower=Lower|http://x/",
		EnvPrefix + "DASH-ID=Dash|http://x/",
		EnvPrefix + "=Nameless|http://x/",
	})

	want := map[string]string{
		"by-ip":         "http://172.30.0.5:81",
		"chrome":        "http://chrome-front:8090/",
		"roblox-studio": "https://roblox_studio/ui/",
		"v6":            "http://[fd00::1]:8080/",
	}
	if len(got) != len(want) {
		t.Fatalf("expected %d providers, got %d: %+v", len(want), len(got), got)
	}
	for i, id := range []string{"by-ip", "chrome", "roblox-studio", "v6"} {
		if got[i].ID != id {
			t.Fatalf("entry %d: id %q, want %q (sorted by id)", i, got[i].ID, id)
		}
		if got[i].Target.String() != want[id] {
			t.Errorf("%s target = %q, want %q", id, got[i].Target, want[id])
		}
	}
	if got[1].Title != "Chrome ports" {
		t.Errorf("title = %q", got[1].Title)
	}
}

func TestListNeverNil(t *testing.T) {
	b, err := json.Marshal(New(nil).List())
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "[]" {
		t.Fatalf("empty list must marshal as [], got %s", b)
	}
}

func newTestRegistry(t *testing.T, upstream *httptest.Server, targetPath string) *Registry {
	t.Helper()
	allowLoopbackTargets = true
	t.Cleanup(func() { allowLoopbackTargets = false })
	target, err := ValidateTarget(upstream.URL + targetPath)
	if err != nil {
		t.Fatal(err)
	}
	return New([]Provider{{ID: "chrome", Title: "Chrome ports", Target: target}})
}

func TestProxyStripsPrefixAndCredentials(t *testing.T) {
	var seen *http.Request
	var seenBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r
		b, _ := io.ReadAll(r.Body)
		seenBody = string(b)
		http.SetCookie(w, &http.Cookie{Name: "webmanager_unlock", Value: "evil"})
		w.Write([]byte("ok"))
	}))
	defer upstream.Close()
	reg := newTestRegistry(t, upstream, "/base/")

	req := httptest.NewRequest(http.MethodPost, "/providers/chrome/api/forwards?x=1", strings.NewReader(`{"port":9222}`))
	req.Host = "code.example.com"
	req.RemoteAddr = "127.0.0.1:5555"
	req.Header.Set("X-Real-IP", "203.0.113.7")
	req.Header.Set("Cookie", "webmanager_unlock=secret")
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	reg.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
	if seen.URL.Path != "/base/api/forwards" || seen.URL.RawQuery != "x=1" {
		t.Errorf("upstream saw %s?%s, want /base/api/forwards?x=1", seen.URL.Path, seen.URL.RawQuery)
	}
	if seen.Method != http.MethodPost || seenBody != `{"port":9222}` {
		t.Errorf("upstream saw %s %q", seen.Method, seenBody)
	}
	for _, h := range []string{"Cookie", "Authorization", "X-Real-IP"} {
		if v := seen.Header.Get(h); v != "" {
			t.Errorf("%s leaked to the provider: %q", h, v)
		}
	}
	if v := seen.Header.Get("X-Forwarded-Prefix"); v != "/manager/providers/chrome/" {
		t.Errorf("X-Forwarded-Prefix = %q", v)
	}
	if v := seen.Header.Get("X-Forwarded-Host"); v != "code.example.com" {
		t.Errorf("X-Forwarded-Host = %q", v)
	}
	if v := seen.Header.Get("X-Forwarded-For"); v != "203.0.113.7" {
		t.Errorf("X-Forwarded-For = %q", v)
	}
	if v := rec.Header().Get("Set-Cookie"); v != "" {
		t.Errorf("provider Set-Cookie reached the browser: %q", v)
	}
}

func TestUnknownIDAndBareRedirect(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	reg := newTestRegistry(t, upstream, "/")

	rec := httptest.NewRecorder()
	reg.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/providers/nope/", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown id: got %d, want 404", rec.Code)
	}

	rec = httptest.NewRecorder()
	reg.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/providers/chrome?a=b", nil))
	if rec.Code != http.StatusMovedPermanently || rec.Header().Get("Location") != "chrome/?a=b" {
		t.Errorf("bare id: got %d Location %q, want 301 chrome/?a=b", rec.Code, rec.Header().Get("Location"))
	}
}

func TestBodyLimitIs413(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
	}))
	defer upstream.Close()
	reg := newTestRegistry(t, upstream, "/")

	req := httptest.NewRequest(http.MethodPost, "/providers/chrome/api", strings.NewReader(strings.Repeat("x", 100)))
	rec := httptest.NewRecorder()
	req.Body = http.MaxBytesReader(rec, req.Body, 10)
	reg.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("got %d, want 413", rec.Code)
	}
}

func TestUnreachableIs502(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	reg := newTestRegistry(t, upstream, "/")
	upstream.Close()

	rec := httptest.NewRecorder()
	reg.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/providers/chrome/", nil))
	if rec.Code != http.StatusBadGateway {
		t.Errorf("got %d, want 502", rec.Code)
	}
}

// A WebSocket handshake has to survive the hop: the upgrade response and
// then raw bytes in both directions.
func TestProxyUpgrade(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws" || r.Header.Get("Upgrade") != "websocket" {
			http.Error(w, "not an upgrade to /ws", http.StatusBadRequest)
			return
		}
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		buf.Flush()
		line, _ := buf.ReadString('\n')
		buf.WriteString("echo:" + line)
		buf.Flush()
	}))
	defer upstream.Close()
	front := httptest.NewServer(newTestRegistry(t, upstream, "/"))
	defer front.Close()

	conn, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.Write([]byte("GET /providers/chrome/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"))
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("got %d, want 101", resp.StatusCode)
	}
	conn.Write([]byte("ping\n"))
	line, err := br.ReadString('\n')
	if err != nil || line != "echo:ping\n" {
		t.Fatalf("after upgrade got %q, %v", line, err)
	}
}

// A provider is a container on code-docker-internal; nothing else can be
// one, and the Docker API never can.
func TestValidateTargetRefusesNonProviders(t *testing.T) {
	for _, raw := range []string{
		"http://example.com/",
		"http://93.184.216.34/",
		"http://8.8.8.8:8080/",
		"http://127.0.0.1:8080/",
		"http://localhost:8090/",
		"http://0.0.0.0/",
		"http://dind:2375/",
		"http://172.21.0.6:2376/",
	} {
		if _, err := ValidateTarget(raw); err == nil {
			t.Errorf("ValidateTarget(%q) accepted", raw)
		}
	}
	for _, raw := range []string{"http://chrome-front:8090/", "http://172.30.0.5:81", "https://10.0.0.2/", "http://[fd00::5]:8080/"} {
		if _, err := ValidateTarget(raw); err != nil {
			t.Errorf("ValidateTarget(%q) = %v", raw, err)
		}
	}
}

// A single-label name is checked again on the address it resolves to.
func TestDialRefusesANameThatResolvesOutside(t *testing.T) {
	if _, err := dialTarget(t.Context(), "tcp", "127.0.0.1:1"); err == nil || !strings.Contains(err.Error(), "not a private address") {
		t.Fatalf("dial to loopback = %v, want refused before connecting", err)
	}
}
