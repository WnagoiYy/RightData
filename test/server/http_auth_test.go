package server_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"testing"
	"time"

	"server/app"
)

type httpEnvelope struct {
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	Data      json.RawMessage `json:"data"`
	RequestID string          `json:"requestId"`
}

func startTestServer(t *testing.T) (string, *http.Client) {
	t.Helper()
	a, err := app.Open(testContext(t), app.Config{
		Address: "127.0.0.1:0", DataDir: runtimeTempDir(t),
		AdminUsername: "admin", AdminPassword: testAdminPassword, CookieSecure: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := app.NewServer(a)
	if err = server.Start(); err != nil {
		_ = a.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = server.Shutdown()
		_ = a.Close()
	})
	deadline := time.Now().Add(5 * time.Second)
	for server.GetListenedPort() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if server.GetListenedPort() == 0 {
		t.Fatal("HTTP server did not start listening")
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("http://127.0.0.1:%d", server.GetListenedPort()), &http.Client{Jar: jar, Timeout: 10 * time.Second}
}

func httpJSON(t *testing.T, client *http.Client, method, url, token string, body any, wantStatus int) httpEnvelope {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != wantStatus {
		t.Fatalf("%s %s returned %d, want %d: %s", method, url, response.StatusCode, wantStatus, raw)
	}
	var envelope httpEnvelope
	if err = json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("response is not one valid JSON envelope: %q: %v", raw, err)
	}
	if envelope.RequestID == "" || response.Header.Get("X-Request-ID") != envelope.RequestID {
		t.Fatalf("request ID mismatch: header=%q body=%q", response.Header.Get("X-Request-ID"), envelope.RequestID)
	}
	return envelope
}

func loginHTTP(t *testing.T, client *http.Client, base, username, password string) app.SessionResult {
	t.Helper()
	envelope := httpJSON(t, client, http.MethodPost, base+"/api/v1/auth/login", "", map[string]any{
		"username": username, "password": password,
	}, http.StatusOK)
	if envelope.Code != "ok" {
		t.Fatalf("login failed: %#v", envelope)
	}
	var result app.SessionResult
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		t.Fatal(err)
	}
	if result.AccessToken == "" || result.RefreshToken == "" || result.User == nil {
		t.Fatalf("incomplete login response: %#v", result)
	}
	return result
}

func TestHTTPAuthenticationAuthorizationAndDocumentSession(t *testing.T) {
	base, client := startTestServer(t)

	unauthenticated := httpJSON(t, client, http.MethodGet, base+"/api/v1/health", "", nil, http.StatusUnauthorized)
	if unauthenticated.Code != "unauthenticated" {
		t.Fatalf("unexpected unauthenticated code: %q", unauthenticated.Code)
	}
	invalid := httpJSON(t, client, http.MethodPost, base+"/api/v1/auth/login", "", map[string]string{
		"username": "admin", "password": "wrong-password",
	}, http.StatusUnauthorized)
	if invalid.Code != "invalid_credentials" {
		t.Fatalf("unexpected invalid login code: %q", invalid.Code)
	}

	admin := loginHTTP(t, client, base, "admin", testAdminPassword)
	if got := httpJSON(t, client, http.MethodGet, base+"/api/v1/health", admin.AccessToken, nil, http.StatusOK); got.Code != "ok" {
		t.Fatalf("authenticated health failed: %#v", got)
	}

	created := httpJSON(t, client, http.MethodPost, base+"/api/v1/users", admin.AccessToken, map[string]any{
		"username": "docs-only", "password": "docs-password-at-least-12", "permissions": []string{"docs.read"},
	}, http.StatusOK)
	if created.Code != "ok" {
		t.Fatalf("create user failed: %#v", created)
	}
	var docsUser app.User
	if err := json.Unmarshal(created.Data, &docsUser); err != nil || docsUser.ID == "" {
		t.Fatalf("invalid created user: %s err=%v", created.Data, err)
	}
	docsOnly := loginHTTP(t, client, base, "docs-only", "docs-password-at-least-12")
	forbidden := httpJSON(t, client, http.MethodGet, base+"/api/v1/health", docsOnly.AccessToken, nil, http.StatusForbidden)
	if forbidden.Code != "forbidden" {
		t.Fatalf("unexpected forbidden code: %q", forbidden.Code)
	}

	noDocSession := httpJSON(t, client, http.MethodGet, base+"/api/api.json", "", nil, http.StatusUnauthorized)
	if noDocSession.Code != "unauthenticated" {
		t.Fatalf("OpenAPI was not protected: %#v", noDocSession)
	}
	for _, path := range []string{"/api/swagger/", "/api/swagger/assets/swagger-ui-bundle.js", "/api/swagger/assets/swagger-ui.css"} {
		request, err := http.NewRequest(http.MethodGet, base+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+docsOnly.AccessToken)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK || len(body) < 100 {
			t.Fatalf("protected local docs asset %s unavailable: status=%d bytes=%d", path, response.StatusCode, len(body))
		}
	}
	ticketEnvelope := httpJSON(t, client, http.MethodPost, base+"/api/v1/auth/document-ticket", docsOnly.AccessToken, map[string]any{}, http.StatusOK)
	var ticket app.DocTicketRes
	if err := json.Unmarshal(ticketEnvelope.Data, &ticket); err != nil || ticket.Ticket == "" {
		t.Fatalf("invalid document ticket: %#v err=%v", ticket, err)
	}
	if got := httpJSON(t, client, http.MethodPost, base+"/api/docs/session", "", map[string]string{"ticket": ticket.Ticket}, http.StatusOK); got.Code != "ok" {
		t.Fatalf("document session failed: %#v", got)
	}
	response, err := client.Get(base + "/api/api.json")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("X-Request-ID") == "" {
		t.Fatalf("document cookie did not authorize OpenAPI: status=%d", response.StatusCode)
	}
	if got := httpJSON(t, client, http.MethodGet, base+"/api/v1/auth/me", "", nil, http.StatusUnauthorized); got.Code != "unauthenticated" {
		t.Fatalf("document cookie authorized a business endpoint: %#v", got)
	}
	reused := httpJSON(t, client, http.MethodPost, base+"/api/docs/session", "", map[string]string{"ticket": ticket.Ticket}, http.StatusUnauthorized)
	if reused.Code != "invalid_ticket" {
		t.Fatalf("document ticket was reusable: %#v", reused)
	}
	if got := httpJSON(t, client, http.MethodPut, base+"/api/v1/users/"+docsUser.ID, admin.AccessToken, map[string]any{
		"permissions": []string{}, "disabled": false,
	}, http.StatusOK); got.Code != "ok" {
		t.Fatalf("permission revoke failed: %#v", got)
	}
	if got := httpJSON(t, client, http.MethodGet, base+"/api/api.json", "", nil, http.StatusForbidden); got.Code != "forbidden" {
		t.Fatalf("document cookie survived permission revoke: %#v", got)
	}
	if got := httpJSON(t, client, http.MethodPut, base+"/api/v1/users/"+docsUser.ID, admin.AccessToken, map[string]any{
		"permissions": []string{"docs.read"}, "disabled": false,
	}, http.StatusOK); got.Code != "ok" {
		t.Fatalf("permission restore failed: %#v", got)
	}
	if got := httpJSON(t, client, http.MethodPost, base+"/api/v1/auth/logout", docsOnly.AccessToken, map[string]any{}, http.StatusOK); got.Code != "ok" {
		t.Fatalf("docs user logout failed: %#v", got)
	}
	if got := httpJSON(t, client, http.MethodGet, base+"/api/api.json", "", nil, http.StatusUnauthorized); got.Code != "unauthenticated" {
		t.Fatalf("document cookie survived business-session logout: %#v", got)
	}

	refreshedEnvelope := httpJSON(t, client, http.MethodPost, base+"/api/v1/auth/refresh", "", map[string]string{
		"refreshToken": admin.RefreshToken,
	}, http.StatusOK)
	var refreshed app.SessionResult
	if err = json.Unmarshal(refreshedEnvelope.Data, &refreshed); err != nil {
		t.Fatal(err)
	}
	if refreshed.AccessToken == admin.AccessToken || refreshed.RefreshToken == admin.RefreshToken {
		t.Fatal("refresh did not rotate both credentials")
	}
	oldRefresh := httpJSON(t, client, http.MethodPost, base+"/api/v1/auth/refresh", "", map[string]string{
		"refreshToken": admin.RefreshToken,
	}, http.StatusUnauthorized)
	if oldRefresh.Code != "unauthenticated" {
		t.Fatalf("rotated refresh token remained valid: %#v", oldRefresh)
	}
	if got := httpJSON(t, client, http.MethodPost, base+"/api/v1/auth/logout", refreshed.AccessToken, map[string]any{}, http.StatusOK); got.Code != "ok" {
		t.Fatalf("logout failed: %#v", got)
	}
	loggedOut := httpJSON(t, client, http.MethodGet, base+"/api/v1/auth/me", refreshed.AccessToken, nil, http.StatusUnauthorized)
	if loggedOut.Code != "unauthenticated" {
		t.Fatalf("logged-out access token remained valid: %#v", loggedOut)
	}
}
