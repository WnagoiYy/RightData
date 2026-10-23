package server_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"server/app"
)

type screenVersionList struct {
	Items            []app.ScreenVersion `json:"items"`
	PublishedVersion *app.ScreenVersion  `json:"publishedVersion"`
	PublishRevision  int64               `json:"publishRevision"`
	PublishedAt      any                 `json:"publishedAt"`
}

type screenResourceView struct {
	app.SharedConfig
	PublishedVersion *app.ScreenVersion `json:"publishedVersion"`
	PublishRevision  int64              `json:"publishRevision"`
	PublishedAt      any                `json:"publishedAt"`
}

func TestScreenHTTPVersionLifecycleAuthorizationAndBinding(t *testing.T) {
	a, base, client := screenStartServer(t)
	admin := screenLogin(t, client, base, "admin", screenAdminPassword)
	writer, writerSession := screenCreateUser(t, client, base, admin.AccessToken, "screen-writer", "config.read", "config.write")
	reader, readerSession := screenCreateUser(t, client, base, admin.AccessToken, "screen-reader",
		"resources.read", "data.read", "resource.view", "definition.use", "menu.parent", "menu.child",
	)
	filesOnly, filesOnlySession := screenCreateUser(t, client, base, admin.AccessToken, "screen-files-only", "files.read", "files.write")
	screenAssertNoFilePermissions(t, writer)
	screenAssertNoFilePermissions(t, reader)
	if !screenContainsPermission(filesOnly.Permissions, "files.read") || screenContainsPermission(filesOnly.Permissions, "config.write") {
		t.Fatalf("invalid negative-control permissions: %#v", filesOnly.Permissions)
	}

	screenPrepareBusinessDataset(t, a, "screen-sales")
	screenGrantTable(t, a, reader.ID, "screen-sales", "sales", []string{"read"}, []string{"id", "region", "amount"}, app.Filter{
		Field: "region", Op: "eq", Value: "north",
	})
	screenInsertConfig(t, a, "screen-query", "query", "Screen query", map[string]any{
		"datasetId": "screen-sales",
		"query": app.QueryRequest{
			DatasetID: "screen-sales", Table: "sales", Fields: []string{"id", "region", "amount"},
			OrderBy: []app.Order{{Field: "id", Direction: "asc"}},
		},
		"permissions": []string{"definition.use"},
	})
	screenBody := map[string]any{
		"enabled": true, "permissions": []string{"resource.view"}, "definitionIds": []string{"screen-query"},
		"layout": map[string]any{"mode": "fixed"},
	}
	screenInsertConfig(t, a, "sales-screen", "screen", "Sales screen", screenBody)
	screenInsertConfig(t, a, "screen-parent", "menu", "Screens", map[string]any{
		"enabled": true, "permissions": []string{"menu.parent"}, "order": 1,
	})
	screenInsertConfig(t, a, "screen-entry", "menu", "Sales", map[string]any{
		"enabled": true, "permissions": []string{"menu.child"}, "parentId": "screen-parent", "order": 2,
		"resourceId": "sales-screen", "resourceKind": "screen",
	})

	bundle120, _ := screenValidBundle(t, "sales-screen", "1.2.0", []byte("<html>screen 1.2.0</html>"))
	bundle1100, _ := screenValidBundle(t, "sales-screen", "1.10.0", []byte("<html>screen 1.10.0</html>"))
	firstUpload := screenUpload(t, client, base, writerSession.AccessToken, "sales-screen", bundle120, http.StatusOK)
	var version120 app.ScreenVersion
	if err := json.Unmarshal(firstUpload.Data, &version120); err != nil {
		t.Fatal(err)
	}
	if version120.ScreenID != "sales-screen" || version120.Version != "1.2.0" || version120.SHA256 != screenSHA256(bundle120) || version120.SizeBytes != int64(len(bundle120)) {
		t.Fatalf("unexpected uploaded version: %#v", version120)
	}
	if version120.DownloadURL != "/api/v1/screens/sales-screen/versions/1.2.0/download" || version120.CreatedAt.IsZero() {
		t.Fatalf("incomplete uploaded version: %#v", version120)
	}
	replayedUpload := screenUpload(t, client, base, writerSession.AccessToken, "sales-screen", bundle120, http.StatusOK)
	if !bytes.Equal(firstUpload.Data, replayedUpload.Data) {
		t.Fatalf("identical immutable upload did not return its original record: %s != %s", firstUpload.Data, replayedUpload.Data)
	}
	conflicting120, _ := screenValidBundle(t, "sales-screen", "1.2.0", []byte("<html>changed bytes</html>"))
	conflict := screenUpload(t, client, base, writerSession.AccessToken, "sales-screen", conflicting120, http.StatusConflict)
	if conflict.Code != "screen_version_exists" {
		t.Fatalf("changed immutable version returned %q, want screen_version_exists", conflict.Code)
	}
	secondUpload := screenUpload(t, client, base, writerSession.AccessToken, "sales-screen", bundle1100, http.StatusOK)
	var version1100 app.ScreenVersion
	if err := json.Unmarshal(secondUpload.Data, &version1100); err != nil || version1100.Version != "1.10.0" {
		t.Fatalf("invalid second screen version: %s: %v", secondUpload.Data, err)
	}

	deniedBundle, _ := screenValidBundle(t, "sales-screen", "2.0.0", []byte("<html>files permission is insufficient</html>"))
	deniedUpload := screenUpload(t, client, base, filesOnlySession.AccessToken, "sales-screen", deniedBundle, http.StatusForbidden)
	if deniedUpload.Code != "forbidden" {
		t.Fatalf("files permissions authorized a screen upload: %#v", deniedUpload)
	}
	if denied := screenJSON(t, client, http.MethodGet, base+"/api/v1/screens/sales-screen/versions", filesOnlySession.AccessToken, nil, nil, http.StatusForbidden); denied.Code != "forbidden" {
		t.Fatalf("files permissions authorized version management: %#v", denied)
	}
	if denied := screenJSON(t, client, http.MethodPost, base+"/api/v1/screens/sales-screen/publish", filesOnlySession.AccessToken,
		map[string]string{"Idempotency-Key": "files-cannot-publish"}, map[string]any{"version": "1.2.0", "expectedRevision": 0}, http.StatusForbidden); denied.Code != "forbidden" {
		t.Fatalf("files permissions authorized publishing: %#v", denied)
	}

	listEnvelope := screenJSON(t, client, http.MethodGet, base+"/api/v1/screens/sales-screen/versions", writerSession.AccessToken, nil, nil, http.StatusOK)
	var versions screenVersionList
	if err := json.Unmarshal(listEnvelope.Data, &versions); err != nil {
		t.Fatal(err)
	}
	if len(versions.Items) != 2 || versions.Items[0].Version != "1.10.0" || versions.Items[1].Version != "1.2.0" {
		t.Fatalf("versions are not in descending SemVer order: %#v", versions.Items)
	}
	if versions.PublishedVersion != nil || versions.PublishRevision != 0 || versions.PublishedAt != nil {
		t.Fatalf("unpublished screen has publication state: %#v", versions)
	}
	invalidLimit := screenJSON(t, client, http.MethodGet, base+"/api/v1/screens/sales-screen/versions?limit=-1", writerSession.AccessToken, nil, nil, http.StatusBadRequest)
	if invalidLimit.Code != "invalid_page" {
		t.Fatalf("negative screen list limit returned %q", invalidLimit.Code)
	}
	pagedEnvelope := screenJSON(t, client, http.MethodGet, base+"/api/v1/screens/sales-screen/versions?limit=1&offset=1", writerSession.AccessToken, nil, nil, http.StatusOK)
	var paged screenVersionList
	if err := json.Unmarshal(pagedEnvelope.Data, &paged); err != nil {
		t.Fatal(err)
	}
	if len(paged.Items) != 1 || paged.Items[0].Version != "1.2.0" {
		t.Fatalf("screen version pagination did not preserve descending SemVer order: %#v", paged.Items)
	}

	unpublished := screenJSON(t, client, http.MethodGet, base+"/api/v1/resources/sales-screen", readerSession.AccessToken, nil, nil, http.StatusNotFound)
	if unpublished.Code != "screen_not_published" {
		t.Fatalf("unpublished screen returned %q, want screen_not_published", unpublished.Code)
	}
	screenAssertMenuAbsent(t, client, base, readerSession.AccessToken, "screen-entry")
	missingPublishKey := screenJSON(t, client, http.MethodPost, base+"/api/v1/screens/sales-screen/publish", writerSession.AccessToken,
		nil, map[string]any{"version": "1.2.0", "expectedRevision": 0}, http.StatusBadRequest)
	if missingPublishKey.Code != "idempotency_required" {
		t.Fatalf("publish without Idempotency-Key returned %q", missingPublishKey.Code)
	}

	publish120 := screenJSON(t, client, http.MethodPost, base+"/api/v1/screens/sales-screen/publish", writerSession.AccessToken,
		map[string]string{"Idempotency-Key": "publish-screen-120"}, map[string]any{"version": "1.2.0", "expectedRevision": 0}, http.StatusOK)
	var publication app.ScreenPublication
	if err := json.Unmarshal(publish120.Data, &publication); err != nil || publication.PublishedVersion == nil || publication.PublishedVersion.Version != "1.2.0" || publication.PublishRevision != 1 || publication.PublishedAt == nil {
		t.Fatalf("invalid first publication: %s: %v", publish120.Data, err)
	}
	publishReplay := screenJSON(t, client, http.MethodPost, base+"/api/v1/screens/sales-screen/publish", writerSession.AccessToken,
		map[string]string{"Idempotency-Key": "publish-screen-120"}, map[string]any{"version": "1.2.0", "expectedRevision": 0}, http.StatusOK)
	if !bytes.Equal(publish120.Data, publishReplay.Data) {
		t.Fatalf("publish retry did not return original receipt: %s != %s", publish120.Data, publishReplay.Data)
	}
	idempotencyConflict := screenJSON(t, client, http.MethodPost, base+"/api/v1/screens/sales-screen/publish", writerSession.AccessToken,
		map[string]string{"Idempotency-Key": "publish-screen-120"}, map[string]any{"version": "1.10.0", "expectedRevision": 1}, http.StatusConflict)
	if idempotencyConflict.Code != "idempotency_conflict" {
		t.Fatalf("changed publish under reused key returned %q", idempotencyConflict.Code)
	}
	stalePublish := screenJSON(t, client, http.MethodPost, base+"/api/v1/screens/sales-screen/publish", writerSession.AccessToken,
		map[string]string{"Idempotency-Key": "publish-screen-stale"}, map[string]any{"version": "1.10.0", "expectedRevision": 0}, http.StatusConflict)
	if stalePublish.Code != "version_conflict" {
		t.Fatalf("stale publish returned %q", stalePublish.Code)
	}

	screenAssertMenuPresent(t, client, base, readerSession.AccessToken, "screen-parent", "screen-entry")
	viewEnvelope := screenJSON(t, client, http.MethodGet, base+"/api/v1/resources/sales-screen", readerSession.AccessToken, nil, nil, http.StatusOK)
	var view screenResourceView
	if err := json.Unmarshal(viewEnvelope.Data, &view); err != nil || view.Kind != "screen" || view.PublishedVersion == nil || view.PublishedVersion.Version != "1.2.0" || view.PublishRevision != 1 || view.PublishedAt == nil {
		t.Fatalf("invalid published resource view: %s: %v", viewEnvelope.Data, err)
	}
	execute := screenJSON(t, client, http.MethodPost, base+"/api/v1/resources/sales-screen/execute", readerSession.AccessToken, nil,
		map[string]any{"definitionId": "screen-query", "params": map[string]any{}}, http.StatusOK)
	var query app.QueryResult
	if err := json.Unmarshal(execute.Data, &query); err != nil {
		t.Fatal(err)
	}
	if query.Total != 1 || len(query.Rows) != 1 || query.Rows[0]["region"] != "north" {
		t.Fatalf("screen binding did not enforce row policy: %#v", query)
	}
	if _, exposed := query.Rows[0]["secret"]; exposed {
		t.Fatalf("screen binding exposed an unauthorized column: %#v", query.Rows[0])
	}

	publish1100 := screenJSON(t, client, http.MethodPost, base+"/api/v1/screens/sales-screen/publish", writerSession.AccessToken,
		map[string]string{"Idempotency-Key": "publish-screen-1100"}, map[string]any{"version": "1.10.0", "expectedRevision": 1}, http.StatusOK)
	if err := json.Unmarshal(publish1100.Data, &publication); err != nil || publication.PublishRevision != 2 || publication.PublishedVersion.Version != "1.10.0" {
		t.Fatalf("invalid second publication: %s: %v", publish1100.Data, err)
	}
	screenAssertDownloadDenied(t, client, base, readerSession.AccessToken, "sales-screen", "1.2.0")
	current1100 := screenDownload(t, client, base, readerSession.AccessToken, "sales-screen", "1.10.0", nil, http.StatusOK)
	if !bytes.Equal(current1100.Body, bundle1100) {
		t.Fatal("ordinary reader did not receive the current immutable ZIP")
	}

	rollback := screenJSON(t, client, http.MethodPost, base+"/api/v1/screens/sales-screen/publish", writerSession.AccessToken,
		map[string]string{"Idempotency-Key": "rollback-screen-120"}, map[string]any{"version": "1.2.0", "expectedRevision": 2}, http.StatusOK)
	if err := json.Unmarshal(rollback.Data, &publication); err != nil || publication.PublishRevision != 3 || publication.PublishedVersion.Version != "1.2.0" {
		t.Fatalf("invalid rollback publication: %s: %v", rollback.Data, err)
	}
	screenAssertDownloadDenied(t, client, base, readerSession.AccessToken, "sales-screen", "1.10.0")
	historyPreview := screenDownload(t, client, base, writerSession.AccessToken, "sales-screen", "1.10.0", nil, http.StatusOK)
	if !bytes.Equal(historyPreview.Body, bundle1100) {
		t.Fatal("config writer could not preview an uploaded historical version")
	}

	current120 := screenDownload(t, client, base, readerSession.AccessToken, "sales-screen", "1.2.0", nil, http.StatusOK)
	if current120.Header.Get("Content-Type") != "application/zip" {
		t.Fatalf("unexpected download media type: %q", current120.Header.Get("Content-Type"))
	}
	if current120.Header.Get("Content-Length") != strconv.Itoa(len(bundle120)) || !bytes.Equal(current120.Body, bundle120) {
		t.Fatalf("full download mismatch: length=%q bytes=%d", current120.Header.Get("Content-Length"), len(current120.Body))
	}
	etag := current120.Header.Get("ETag")
	if screenTrimETag(etag) != screenSHA256(bundle120) {
		t.Fatalf("download ETag %q does not contain ZIP digest %s", etag, screenSHA256(bundle120))
	}
	partial := screenDownload(t, client, base, readerSession.AccessToken, "sales-screen", "1.2.0", map[string]string{
		"Range": "bytes=0-15", "If-Range": etag,
	}, http.StatusPartialContent)
	if partial.Header.Get("Content-Range") != fmt.Sprintf("bytes 0-15/%d", len(bundle120)) || !bytes.Equal(partial.Body, bundle120[:16]) {
		t.Fatalf("invalid ranged download: range=%q bytes=%x", partial.Header.Get("Content-Range"), partial.Body)
	}
	if partial.Header.Get("ETag") != etag {
		t.Fatalf("range response changed ETag: %q != %q", partial.Header.Get("ETag"), etag)
	}
	ifRangeMiss := screenDownload(t, client, base, readerSession.AccessToken, "sales-screen", "1.2.0", map[string]string{
		"Range": "bytes=0-15", "If-Range": `"different-digest"`,
	}, http.StatusOK)
	if !bytes.Equal(ifRangeMiss.Body, bundle120) {
		t.Fatal("If-Range mismatch did not return the complete current ZIP")
	}

	disabledBody := map[string]any{
		"enabled": false, "permissions": []string{"resource.view"}, "definitionIds": []string{"screen-query"},
	}
	disabled := screenJSON(t, client, http.MethodPut, base+"/api/v1/configs/sales-screen", writerSession.AccessToken,
		map[string]string{"Idempotency-Key": "disable-sales-screen"}, map[string]any{
			"kind": "screen", "name": "Sales screen", "version": 1, "body": disabledBody,
		}, http.StatusOK)
	var disabledConfig app.SharedConfig
	if err := json.Unmarshal(disabled.Data, &disabledConfig); err != nil || disabledConfig.Version != 2 {
		t.Fatalf("invalid disabled config: %s: %v", disabled.Data, err)
	}
	screenAssertMenuAbsent(t, client, base, readerSession.AccessToken, "screen-entry")
	screenAssertResourceDenied(t, client, base, readerSession.AccessToken, "sales-screen")
	screenAssertDownloadDenied(t, client, base, readerSession.AccessToken, "sales-screen", "1.2.0")
	screenAssertExecuteDenied(t, client, base, readerSession.AccessToken, "sales-screen", "screen-query")

	reenabled := screenJSON(t, client, http.MethodPut, base+"/api/v1/configs/sales-screen", writerSession.AccessToken,
		map[string]string{"Idempotency-Key": "reenable-sales-screen"}, map[string]any{
			"kind": "screen", "name": "Sales screen", "version": 2, "body": screenBody,
		}, http.StatusOK)
	var enabledConfig app.SharedConfig
	if err := json.Unmarshal(reenabled.Data, &enabledConfig); err != nil || enabledConfig.Version != 3 {
		t.Fatalf("invalid re-enabled config: %s: %v", reenabled.Data, err)
	}
	if response := screenDownload(t, client, base, readerSession.AccessToken, "sales-screen", "1.2.0", nil, http.StatusOK); !bytes.Equal(response.Body, bundle120) {
		t.Fatal("re-enabled resource did not restore its unchanged published ZIP")
	}

	revokedPermissions := []string{"resources.read", "data.read", "resource.view", "definition.use", "menu.parent"}
	revoked := screenJSON(t, client, http.MethodPut, base+"/api/v1/users/"+reader.ID, admin.AccessToken, nil, map[string]any{
		"permissions": revokedPermissions, "disabled": false,
	}, http.StatusOK)
	if revoked.Code != "ok" {
		t.Fatalf("permission revoke failed: %#v", revoked)
	}
	screenAssertMenuAbsent(t, client, base, readerSession.AccessToken, "screen-entry")
	screenAssertResourceDenied(t, client, base, readerSession.AccessToken, "sales-screen")
	screenAssertDownloadDenied(t, client, base, readerSession.AccessToken, "sales-screen", "1.2.0")
	screenAssertExecuteDenied(t, client, base, readerSession.AccessToken, "sales-screen", "screen-query")

	removed := screenJSON(t, client, http.MethodDelete, base+"/api/v1/configs/sales-screen?version=3", writerSession.AccessToken, nil, nil, http.StatusOK)
	if removed.Code != "ok" {
		t.Fatalf("screen removal failed: %#v", removed)
	}
	screenAssertDownloadDenied(t, client, base, writerSession.AccessToken, "sales-screen", "1.2.0")
	screenAssertCleanup(t, a)
}

func screenAssertCleanup(t *testing.T, a *app.App) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	old := now.Add(-25 * time.Hour)
	directory := filepath.Join(a.Config.DataDir, "screens")
	rows, err := a.DB.QueryContext(screenTestContext(t), `SELECT path FROM screen_versions WHERE screen_id=? ORDER BY version`, "sales-screen")
	if err != nil {
		t.Fatal(err)
	}
	var referenced []string
	for rows.Next() {
		var path string
		if err = rows.Scan(&path); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		referenced = append(referenced, path)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	if err = rows.Close(); err != nil {
		t.Fatal(err)
	}
	if len(referenced) != 2 {
		t.Fatalf("expected two immutable screen files before cleanup, got %v", referenced)
	}
	for _, path := range referenced {
		if err = os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}

	oldOrphan := filepath.Join(directory, strings.Repeat("a", 48)+".zip")
	oldUpload := filepath.Join(directory, ".upload-123456789.zip")
	newOrphan := filepath.Join(directory, strings.Repeat("b", 48)+".zip")
	unknown := filepath.Join(directory, "manual-screen-package.zip")
	oldDirectory := filepath.Join(directory, strings.Repeat("c", 48)+".zip")
	for _, path := range []string{oldOrphan, oldUpload, newOrphan, unknown} {
		if err = os.WriteFile(path, []byte("screen cleanup fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{oldOrphan, oldUpload, unknown} {
		if err = os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.Chtimes(newOrphan, now, now); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(oldDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(oldDirectory, old, old); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, strings.Repeat("d", 48)+".zip")
	linkCreated := os.Symlink(unknown, link) == nil

	if err = a.CleanupScreenFiles(screenTestContext(t), now); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{oldOrphan, oldUpload} {
		if _, statErr := os.Lstat(path); !os.IsNotExist(statErr) {
			t.Fatalf("old unreferenced screen file was not removed: %s: %v", path, statErr)
		}
	}
	for _, path := range append(referenced, newOrphan, unknown, oldDirectory) {
		if _, statErr := os.Lstat(path); statErr != nil {
			t.Fatalf("cleanup removed a retained path %s: %v", path, statErr)
		}
	}
	if linkCreated {
		if _, err = os.Lstat(link); err != nil {
			t.Fatalf("cleanup removed or followed a symbolic link: %s: %v", link, err)
		}
	}
}

func screenDownload(t *testing.T, client *http.Client, base, token, screenID, version string, headers map[string]string, wantStatus int) screenHTTPResponse {
	t.Helper()
	path := base + "/api/v1/screens/" + url.PathEscape(screenID) + "/versions/" + url.PathEscape(version) + "/download"
	response := screenDo(t, client, http.MethodGet, path, token, headers, nil)
	if response.Status != wantStatus {
		t.Fatalf("GET %s returned %d, want %d: %s", path, response.Status, wantStatus, response.Body)
	}
	return response
}

func screenAssertDownloadDenied(t *testing.T, client *http.Client, base, token, screenID, version string) {
	t.Helper()
	path := base + "/api/v1/screens/" + url.PathEscape(screenID) + "/versions/" + url.PathEscape(version) + "/download"
	response := screenDo(t, client, http.MethodGet, path, token, nil, nil)
	if response.Status != http.StatusForbidden && response.Status != http.StatusNotFound {
		t.Fatalf("denied screen download returned %d: %s", response.Status, response.Body)
	}
	var envelope screenEnvelope
	if json.Unmarshal(response.Body, &envelope) != nil || envelope.Code == "" || envelope.Code == "ok" {
		t.Fatalf("denied screen download returned invalid error envelope: %s", response.Body)
	}
}

func screenAssertResourceDenied(t *testing.T, client *http.Client, base, token, screenID string) {
	t.Helper()
	response := screenDo(t, client, http.MethodGet, base+"/api/v1/resources/"+url.PathEscape(screenID), token, nil, nil)
	if response.Status != http.StatusForbidden && response.Status != http.StatusNotFound {
		t.Fatalf("denied resource view returned %d: %s", response.Status, response.Body)
	}
}

func screenAssertExecuteDenied(t *testing.T, client *http.Client, base, token, screenID, definitionID string) {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"definitionId": definitionID, "params": map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	response := screenDo(t, client, http.MethodPost, base+"/api/v1/resources/"+url.PathEscape(screenID)+"/execute", token,
		map[string]string{"Content-Type": "application/json"}, bytes.NewReader(encoded))
	if response.Status != http.StatusForbidden && response.Status != http.StatusNotFound {
		t.Fatalf("denied resource execution returned %d: %s", response.Status, response.Body)
	}
}

func screenAssertMenuPresent(t *testing.T, client *http.Client, base, token string, expected ...string) {
	t.Helper()
	envelope := screenJSON(t, client, http.MethodGet, base+"/api/v1/menus", token, nil, nil, http.StatusOK)
	var result struct {
		Items []struct {
			ID           string `json:"id"`
			ResourceKind string `json:"resourceKind"`
		} `json:"items"`
	}
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, item := range result.Items {
		ids = append(ids, item.ID)
		if item.ID == "screen-entry" && item.ResourceKind != "screen" {
			t.Fatalf("screen menu has resourceKind %q", item.ResourceKind)
		}
	}
	for _, id := range expected {
		if !slices.Contains(ids, id) {
			t.Fatalf("menu %q is missing from %#v", id, result.Items)
		}
	}
}

func screenAssertMenuAbsent(t *testing.T, client *http.Client, base, token, forbiddenID string) {
	t.Helper()
	envelope := screenJSON(t, client, http.MethodGet, base+"/api/v1/menus", token, nil, nil, http.StatusOK)
	var result struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		t.Fatal(err)
	}
	for _, item := range result.Items {
		if item.ID == forbiddenID {
			t.Fatalf("inaccessible or unpublished menu %q was returned: %#v", forbiddenID, result.Items)
		}
	}
}
