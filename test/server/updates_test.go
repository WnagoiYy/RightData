package server_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"server/app"
)

func startUpdateTestServer(t *testing.T) (*app.App, string, *http.Client) {
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
	return a, fmt.Sprintf("http://127.0.0.1:%d", server.GetListenedPort()), &http.Client{Timeout: 10 * time.Second}
}

func storeOrdinaryFile(t *testing.T, a *app.App, ownerID, name string, contents []byte) string {
	t.Helper()
	id := app.NewID()
	directory := filepath.Join(a.Config.DataDir, "files")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, id+".bin")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	now := time.Now().UTC()
	if _, err := a.DB.ExecContext(testContext(t),
		`INSERT INTO files(id,name,path,owner_id,size,sha256,media_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
		id, name, path, ownerID, len(contents), hex.EncodeToString(digest[:]), "application/vnd.microsoft.portable-executable", now, now,
	); err != nil {
		t.Fatal(err)
	}
	return id
}

func replaceOrdinaryFile(t *testing.T, a *app.App, id string, contents []byte) {
	t.Helper()
	var path string
	if err := a.DB.QueryRowContext(testContext(t), `SELECT path FROM files WHERE id=?`, id).Scan(&path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	if _, err := a.DB.ExecContext(testContext(t), `UPDATE files SET size=?,sha256=?,updated_at=? WHERE id=?`, len(contents), hex.EncodeToString(digest[:]), time.Now().UTC(), id); err != nil {
		t.Fatal(err)
	}
}

func updateGET(t *testing.T, client *http.Client, target, token, byteRange string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if byteRange != "" {
		request.Header.Set("Range", byteRange)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return response, body
}

func TestClientUpdatesAreImmutableSemverOrderedAndRangeDownloadable(t *testing.T) {
	a, base, client := startUpdateTestServer(t)
	adminSession := loginHTTP(t, client, base, "admin", testAdminPassword)
	admin := adminSession.User

	oldInstaller := []byte("old-installer-1.9.0")
	sourceID := storeOrdinaryFile(t, a, admin.ID, "RightData-setup.exe", oldInstaller)
	release19, err := a.PublishClientUpdate(testContext(t), admin, sourceID, "1.9.0", "public-signature-1.9", "windows", "x64")
	if err != nil {
		t.Fatal(err)
	}
	newInstaller := []byte("new-installer-1.10.0-with-more-bytes")
	replaceOrdinaryFile(t, a, sourceID, newInstaller)
	publicSignature := "public-signature-1.10\nkept-verbatim"
	release110, err := a.PublishClientUpdate(testContext(t), admin, sourceID, "1.10.0", publicSignature, "WINDOWS", "X64")
	if err != nil {
		t.Fatal(err)
	}

	query := url.Values{"platform": {"windows"}, "arch": {"x64"}, "currentVersion": {"1.8.0"}}
	envelope := httpJSON(t, client, http.MethodGet, base+"/api/v1/client-updates/latest?"+query.Encode(), adminSession.AccessToken, nil, http.StatusOK)
	var latest app.ClientUpdate
	if err = json.Unmarshal(envelope.Data, &latest); err != nil {
		t.Fatal(err)
	}
	if latest.ID != release110.ID || latest.Version != "1.10.0" || latest.Signature != publicSignature {
		t.Fatalf("latest update was not selected by SemVer or changed its signature: %#v", latest)
	}

	noUpdateQuery := url.Values{"platform": {"windows"}, "arch": {"x64"}, "currentVersion": {"1.10.0"}}
	response, body := updateGET(t, client, base+"/api/v1/client-updates/latest?"+noUpdateQuery.Encode(), adminSession.AccessToken, "")
	if response.StatusCode != http.StatusNoContent || len(body) != 0 {
		t.Fatalf("no-update response = %d %q, want empty 204", response.StatusCode, body)
	}

	response, body = updateGET(t, client, base+release19.DownloadURL, adminSession.AccessToken, "")
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, oldInstaller) {
		t.Fatalf("published 1.9.0 changed after source replacement: status=%d body=%q", response.StatusCode, body)
	}
	if response.Header.Get("ETag") != `"`+release19.SHA256+`"` {
		t.Fatalf("unexpected ETag: %q", response.Header.Get("ETag"))
	}

	response, body = updateGET(t, client, base+release110.DownloadURL, adminSession.AccessToken, "bytes=4-12")
	if response.StatusCode != http.StatusPartialContent || !bytes.Equal(body, newInstaller[4:13]) {
		t.Fatalf("range response = %d %q, want %q", response.StatusCode, body, newInstaller[4:13])
	}
	if response.Header.Get("Content-Range") != fmt.Sprintf("bytes 4-12/%d", len(newInstaller)) || response.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("invalid range headers: Content-Range=%q Accept-Ranges=%q", response.Header.Get("Content-Range"), response.Header.Get("Accept-Ranges"))
	}

	if err = a.DisableClientUpdate(testContext(t), admin, release110.ID); err != nil {
		t.Fatal(err)
	}
	response, body = updateGET(t, client, base+release110.DownloadURL, adminSession.AccessToken, "")
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("disabled package remained downloadable: status=%d body=%s", response.StatusCode, body)
	}
	query.Set("currentVersion", "1.8.0")
	envelope = httpJSON(t, client, http.MethodGet, base+"/api/v1/client-updates/latest?"+query.Encode(), adminSession.AccessToken, nil, http.StatusOK)
	if err = json.Unmarshal(envelope.Data, &latest); err != nil || latest.ID != release19.ID {
		t.Fatalf("latest did not fall back to active 1.9.0: %#v err=%v", latest, err)
	}
}

func TestClientUpdateValidationOwnershipAndAuthentication(t *testing.T) {
	a, base, client := startUpdateTestServer(t)
	adminSession := loginHTTP(t, client, base, "admin", testAdminPassword)
	admin := adminSession.User
	fileID := storeOrdinaryFile(t, a, admin.ID, "setup.exe", []byte("installer"))
	created := httpJSON(t, client, http.MethodPost, base+"/api/v1/users", adminSession.AccessToken, map[string]any{
		"username": "update-reader", "password": "update-reader-password", "permissions": []string{},
	}, http.StatusOK)
	var reader app.User
	if err := json.Unmarshal(created.Data, &reader); err != nil || reader.ID == "" {
		t.Fatalf("invalid update reader: %s err=%v", created.Data, err)
	}
	readerSession := loginHTTP(t, client, base, "update-reader", "update-reader-password")

	for _, invalid := range []string{"1.0", "v1.0.0", "1.0.0-beta.1", "01.0.0", "1.0.0+build"} {
		_, err := a.PublishClientUpdate(testContext(t), admin, fileID, invalid, "signature", "windows", "x64")
		requireAPIError(t, err, 400, "invalid_version")
	}
	if _, err := a.PublishClientUpdate(testContext(t), admin, fileID, "1.0.0", "signature", "linux", "x64"); err == nil {
		t.Fatal("unsupported update target was published")
	} else {
		requireAPIError(t, err, 400, "unsupported_update_target")
	}

	release, err := a.PublishClientUpdate(testContext(t), admin, fileID, "1.0.0", "signature", "windows", "x64")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.PublishClientUpdate(testContext(t), admin, fileID, "1.0.0", "different-signature", "windows", "x64"); err == nil {
		t.Fatal("same platform version was overwritten")
	} else {
		requireAPIError(t, err, 409, "update_version_exists")
	}

	manager := persistedUser(t, a, "other-manager", "system.manage")
	if _, err = a.PublishClientUpdate(userContext(t, manager), manager, fileID, "2.0.0", "signature", "windows", "x64"); err == nil {
		t.Fatal("manager published another user's source file")
	} else {
		requireAPIError(t, err, 403, "forbidden")
	}
	plain := persistedUser(t, a, "plain-user")
	if _, err = a.PublishClientUpdate(userContext(t, plain), plain, storeOrdinaryFile(t, a, plain.ID, "plain.exe", []byte("plain")), "2.0.0", "signature", "windows", "x64"); err == nil {
		t.Fatal("user without system.manage published an update")
	} else {
		requireAPIError(t, err, 403, "forbidden")
	}

	query := url.Values{"platform": {"windows"}, "arch": {"x64"}, "currentVersion": {"0.0.0"}}
	if got := httpJSON(t, client, http.MethodGet, base+"/api/v1/client-updates/latest?"+query.Encode(), readerSession.AccessToken, nil, http.StatusOK); got.Code != "ok" {
		t.Fatalf("logged-in user without permissions could not read update manifest: %#v", got)
	}
	response, body := updateGET(t, client, base+release.DownloadURL, readerSession.AccessToken, "")
	if response.StatusCode != http.StatusOK || string(body) != "installer" {
		t.Fatalf("logged-in user without permissions could not download update: status=%d body=%q", response.StatusCode, body)
	}

	response, body = updateGET(t, client, base+"/api/v1/client-updates/latest?"+query.Encode(), "", "")
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated latest status=%d body=%s", response.StatusCode, body)
	}
	response, body = updateGET(t, client, base+release.DownloadURL, "", "")
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated download status=%d body=%s", response.StatusCode, body)
	}
}
