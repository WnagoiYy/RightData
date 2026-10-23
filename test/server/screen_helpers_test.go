package server_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gogf/gf/v2/net/ghttp"

	"server/app"
)

const screenAdminPassword = "screen-test-password-at-least-12"

type screenEnvelope struct {
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	Data      json.RawMessage `json:"data"`
	RequestID string          `json:"requestId"`
}

type screenHTTPResponse struct {
	Status int
	Header http.Header
	Body   []byte
}

type screenZipEntry struct {
	Name   string
	Data   []byte
	Method uint16
	Mode   os.FileMode
}

func screenTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

func screenRuntimeTempDir(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "runtime"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(root, "screen-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func screenSetDuckDBExtension(t *testing.T) {
	t.Helper()
	if configured := os.Getenv("RIGHTDATA_DUCKDB_EXTENSION"); configured != "" {
		absolute, err := filepath.Abs(configured)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = os.Stat(absolute); err != nil {
			t.Fatalf("configured DuckDB extension is unavailable: %s: %v", absolute, err)
		}
		t.Setenv("RIGHTDATA_DUCKDB_EXTENSION", absolute)
		return
	}
	root, err := filepath.Abs(filepath.Join("..", "..", "server", "resource", "duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	var matches []string
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() && entry.Name() == "httpfs.duckdb_extension" {
			matches = append(matches, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 {
		t.Fatalf("expected one bundled DuckDB extension below %s, found %d: %v", root, len(matches), matches)
	}
	t.Setenv("RIGHTDATA_DUCKDB_EXTENSION", matches[0])
}

func screenStartServer(t *testing.T, configure ...func(*ghttp.Server)) (*app.App, string, *http.Client) {
	t.Helper()
	screenSetDuckDBExtension(t)
	a, err := app.Open(screenTestContext(t), app.Config{
		Address: "127.0.0.1:0", DataDir: screenRuntimeTempDir(t),
		AdminUsername: "admin", AdminPassword: screenAdminPassword, CookieSecure: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := app.NewServer(a)
	for _, setup := range configure {
		setup(server)
	}
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
		t.Fatal("screen HTTP server did not start listening")
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return a, fmt.Sprintf("http://127.0.0.1:%d", server.GetListenedPort()), &http.Client{Jar: jar, Timeout: time.Minute}
}

func screenDo(t *testing.T, client *http.Client, method, url, token string, headers map[string]string, body io.Reader) screenHTTPResponse {
	t.Helper()
	request, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
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
	return screenHTTPResponse{Status: response.StatusCode, Header: response.Header.Clone(), Body: raw}
}

func screenJSON(t *testing.T, client *http.Client, method, url, token string, headers map[string]string, body any, wantStatus int) screenEnvelope {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
		if headers == nil {
			headers = map[string]string{}
		}
		headers["Content-Type"] = "application/json"
	}
	response := screenDo(t, client, method, url, token, headers, reader)
	if response.Status != wantStatus {
		t.Fatalf("%s %s returned %d, want %d: %s", method, url, response.Status, wantStatus, response.Body)
	}
	var envelope screenEnvelope
	if err := json.Unmarshal(response.Body, &envelope); err != nil {
		t.Fatalf("response is not a JSON envelope: %q: %v", response.Body, err)
	}
	if envelope.RequestID == "" || response.Header.Get("X-Request-ID") != envelope.RequestID {
		t.Fatalf("request ID mismatch: header=%q body=%q", response.Header.Get("X-Request-ID"), envelope.RequestID)
	}
	return envelope
}

func screenLogin(t *testing.T, client *http.Client, base, username, password string) app.SessionResult {
	t.Helper()
	envelope := screenJSON(t, client, http.MethodPost, base+"/api/v1/auth/login", "", nil, map[string]string{
		"username": username, "password": password,
	}, http.StatusOK)
	var result app.SessionResult
	if envelope.Code != "ok" || json.Unmarshal(envelope.Data, &result) != nil || result.AccessToken == "" || result.User == nil {
		t.Fatalf("invalid login response for %s: %#v", username, envelope)
	}
	return result
}

func screenCreateUser(t *testing.T, client *http.Client, base, adminToken, username string, permissions ...string) (app.User, app.SessionResult) {
	t.Helper()
	envelope := screenJSON(t, client, http.MethodPost, base+"/api/v1/users", adminToken, nil, map[string]any{
		"username": username, "password": screenAdminPassword, "permissions": permissions,
	}, http.StatusOK)
	var user app.User
	if err := json.Unmarshal(envelope.Data, &user); err != nil || user.ID == "" {
		t.Fatalf("invalid created user: %s: %v", envelope.Data, err)
	}
	return user, screenLogin(t, client, base, username, screenAdminPassword)
}

func screenInsertConfig(t *testing.T, a *app.App, id, kind, name string, body any) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.ExecContext(screenTestContext(t),
		`INSERT INTO configs(id,kind,name,body,owner_id,version,updated_at) VALUES(?,?,?,?,?,?,?)`,
		id, kind, name, string(encoded), "screen-fixture-owner", 1, time.Now().UTC(),
	); err != nil {
		t.Fatal(err)
	}
}

func screenGrantTable(t *testing.T, a *app.App, userID, datasetID, table string, operations, columns []string, row any) {
	t.Helper()
	opsJSON, _ := json.Marshal(operations)
	columnsJSON, _ := json.Marshal(columns)
	rowJSON, _ := json.Marshal(row)
	if _, err := a.DB.ExecContext(screenTestContext(t),
		`INSERT INTO grants(user_id,dataset_id,table_name,operations,columns_json,row_filter) VALUES(?,?,?,?,?,?)`,
		userID, datasetID, table, string(opsJSON), string(columnsJSON), string(rowJSON),
	); err != nil {
		t.Fatal(err)
	}
}

func screenPrepareBusinessDataset(t *testing.T, a *app.App, id string) {
	t.Helper()
	databaseDir := filepath.Join(a.Config.DataDir, "databases")
	if err := os.MkdirAll(databaseDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(databaseDir, id+".duckdb")
	password := "screen-business-password-at-least-12"
	db, err := app.OpenEncrypted(screenTestContext(t), path, password)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(screenTestContext(t), `
		CREATE TABLE sales(id BIGINT PRIMARY KEY, region VARCHAR NOT NULL, amount DECIMAL(20,2) NOT NULL, secret VARCHAR NOT NULL);
		INSERT INTO sales VALUES (1, 'north', 10.25, 'north-secret'), (2, 'south', 20.50, 'south-secret');
	`)
	if closeErr := db.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.ExecContext(screenTestContext(t),
		`INSERT INTO data_files(id,name,kind,source_id,path,password,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?)`,
		id, id+".duckdb", "business", "", path, password, "screen-fixture-owner", time.Now().UTC(),
	); err != nil {
		t.Fatal(err)
	}
}

func screenSHA256(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func screenManifest(screenID, version, entry string, files map[string][]byte) app.ScreenManifest {
	manifest := app.ScreenManifest{ScreenID: screenID, Version: version, Entry: entry, ContainerAPIVersion: app.ScreenContainerAPIVersion}
	for path, data := range files {
		manifest.Files = append(manifest.Files, app.ScreenManifestFile{Path: path, Size: int64(len(data)), SHA256: screenSHA256(data)})
	}
	return manifest
}

func screenBuildZIP(t *testing.T, manifest any, entries []screenZipEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	if manifest != nil {
		encoded, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		entries = append([]screenZipEntry{{Name: "manifest.json", Data: encoded, Method: zip.Store}}, entries...)
	}
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.Name, Method: entry.Method}
		if header.Method == 0 {
			header.Method = zip.Deflate
		}
		if entry.Mode != 0 {
			header.SetMode(entry.Mode)
		}
		part, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(entry.Data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func screenValidBundle(t *testing.T, screenID, version string, content []byte) ([]byte, app.ScreenManifest) {
	t.Helper()
	files := map[string][]byte{"index.html": content, "assets/app.js": []byte("window.screenReady = true;")}
	manifest := screenManifest(screenID, version, "index.html", files)
	entries := []screenZipEntry{
		{Name: "empty/", Method: zip.Store, Mode: os.ModeDir | 0o755},
		{Name: "index.html", Data: files["index.html"]},
		{Name: "assets/app.js", Data: files["assets/app.js"]},
	}
	return screenBuildZIP(t, manifest, entries), manifest
}

func screenUpload(t *testing.T, client *http.Client, base, token, screenID string, bundle []byte, wantStatus int) screenEnvelope {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "screen.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(bundle); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	response := screenDo(t, client, http.MethodPost, base+"/api/v1/screens/"+screenID+"/versions", token, map[string]string{
		"Content-Type": writer.FormDataContentType(),
	}, &body)
	if response.Status != wantStatus {
		t.Fatalf("screen upload returned %d, want %d: %s", response.Status, wantStatus, response.Body)
	}
	var envelope screenEnvelope
	if err = json.Unmarshal(response.Body, &envelope); err != nil {
		t.Fatalf("upload response is not a JSON envelope: %q: %v", response.Body, err)
	}
	return envelope
}

func screenWriteZIP(t *testing.T, raw []byte) string {
	t.Helper()
	dir := screenRuntimeTempDir(t)
	path := filepath.Join(dir, "bundle.zip")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func screenRequireError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("dangerous screen bundle was accepted")
	}
	var apiErr *app.APIError
	if errors.As(err, &apiErr) && apiErr.Status < 400 {
		t.Fatalf("invalid API error status: %#v", apiErr)
	}
}

func screenContainsPermission(permissions []string, candidate string) bool {
	for _, permission := range permissions {
		if permission == candidate {
			return true
		}
	}
	return false
}

func screenAssertNoFilePermissions(t *testing.T, user app.User) {
	t.Helper()
	for _, permission := range []string{"files.read", "files.write"} {
		if screenContainsPermission(user.Permissions, permission) {
			t.Fatalf("screen test user unexpectedly has %s: %#v", permission, user.Permissions)
		}
	}
}

func screenPatchAll16(raw []byte, signature []byte, offset int, value uint16) []byte {
	patched := append([]byte(nil), raw...)
	for start := 0; ; {
		index := bytes.Index(patched[start:], signature)
		if index < 0 {
			break
		}
		index += start
		if index+offset+2 <= len(patched) {
			patched[index+offset] = byte(value)
			patched[index+offset+1] = byte(value >> 8)
		}
		start = index + len(signature)
	}
	return patched
}

func screenReplaceOnce(raw, old, replacement []byte) []byte {
	index := bytes.Index(raw, old)
	if index < 0 || len(old) != len(replacement) {
		return raw
	}
	result := append([]byte(nil), raw...)
	copy(result[index:index+len(old)], replacement)
	return result
}

func screenWriteLargeEntry(t *testing.T, writer *zip.Writer, name string, size int64, fill byte) {
	t.Helper()
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	part, err := writer.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte{fill}, 32<<10)
	for remaining := size; remaining > 0; {
		current := int64(len(chunk))
		if current > remaining {
			current = remaining
		}
		if _, err = part.Write(chunk[:current]); err != nil {
			t.Fatal(err)
		}
		remaining -= current
	}
}

func screenTrimETag(value string) string {
	return strings.Trim(value, `"`)
}
