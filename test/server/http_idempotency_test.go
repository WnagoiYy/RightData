package server_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"testing"
	"time"

	"server/app"
)

func TestHTTPHeaderIdempotencyAndAuthorizationRevision(t *testing.T) {
	base, client := startTestServer(t)
	client.Timeout = time.Minute
	session := loginHTTP(t, client, base, "admin", testAdminPassword)
	request := func(method, path, key string, body any, wantStatus int) httpEnvelope {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest(method, base+path, bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+session.AccessToken)
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != wantStatus {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, res.StatusCode, wantStatus, raw)
		}
		var result httpEnvelope
		if err = json.Unmarshal(raw, &result); err != nil {
			t.Fatalf("invalid JSON response: %s: %v", raw, err)
		}
		return result
	}
	created := request(http.MethodPost, "/api/v1/data-files", "", map[string]any{
		"name": "header-idempotency.duckdb", "password": "Header-test-database-key-2026",
	}, http.StatusOK)
	var dataFile app.DataFile
	if err := json.Unmarshal(created.Data, &dataFile); err != nil || dataFile.ID == "" {
		t.Fatalf("invalid created database: %s: %v", created.Data, err)
	}
	datasetPath := "/api/v1/datasets/" + dataFile.ID
	schema := map[string]any{
		"action": "create_table", "table": "header_rows",
		"fields": []app.FieldDefinition{{Name: "id", DataType: "BIGINT", PrimaryKey: true}, {Name: "name", DataType: "VARCHAR"}},
	}
	missing := request(http.MethodPost, datasetPath+"/schema:mutate", "", schema, http.StatusBadRequest)
	if missing.Code != "idempotency_required" {
		t.Fatalf("missing header returned unexpected error: %#v", missing)
	}
	firstSchema := request(http.MethodPost, datasetPath+"/schema:mutate", "schema-header-1", schema, http.StatusOK)
	secondSchema := request(http.MethodPost, datasetPath+"/schema:mutate", "schema-header-1", schema, http.StatusOK)
	if !bytes.Equal(firstSchema.Data, secondSchema.Data) {
		t.Fatalf("schema retry did not return original result: %s != %s", firstSchema.Data, secondSchema.Data)
	}
	mutation := map[string]any{"operations": []app.RecordMutation{{Action: "insert", Values: map[string]any{"id": "1", "name": "once"}}}}
	mutationPath := datasetPath + "/tables/header_rows/records:mutate"
	firstWrite := request(http.MethodPost, mutationPath, "write-header-1", mutation, http.StatusOK)
	secondWrite := request(http.MethodPost, mutationPath, "write-header-1", mutation, http.StatusOK)
	if !bytes.Equal(firstWrite.Data, secondWrite.Data) {
		t.Fatalf("write retry did not return original result: %s != %s", firstWrite.Data, secondWrite.Data)
	}
	conflicting := map[string]any{"operations": []app.RecordMutation{{Action: "insert", Values: map[string]any{"id": "2", "name": "twice"}}}}
	conflict := request(http.MethodPost, mutationPath, "write-header-1", conflicting, http.StatusConflict)
	if conflict.Code != "idempotency_conflict" {
		t.Fatalf("reused key returned unexpected error: %#v", conflict)
	}
	queried := request(http.MethodPost, datasetPath+"/tables/header_rows/query", "", map[string]any{}, http.StatusOK)
	var result app.QueryResult
	if err := json.Unmarshal(queried.Data, &result); err != nil {
		t.Fatal(err)
	}
	if result.Total != 1 || len(result.Rows) != 1 || result.Rows[0]["name"] != "once" {
		t.Fatalf("header retries changed stored data: %#v", result)
	}
	config := map[string]any{"kind": "settings", "name": "Header settings", "version": 0, "body": map[string]any{"theme": "light"}}
	firstConfig := request(http.MethodPut, "/api/v1/configs/header-settings", "config-header-1", config, http.StatusOK)
	secondConfig := request(http.MethodPut, "/api/v1/configs/header-settings", "config-header-1", config, http.StatusOK)
	if !bytes.Equal(firstConfig.Data, secondConfig.Data) {
		t.Fatalf("config retry did not return original version: %s != %s", firstConfig.Data, secondConfig.Data)
	}
	var saved app.SharedConfig
	if err := json.Unmarshal(secondConfig.Data, &saved); err != nil || saved.Version != 1 {
		t.Fatalf("invalid replayed config version: %s: %v", secondConfig.Data, err)
	}
	createdViewer := request(http.MethodPost, "/api/v1/users", "", map[string]any{
		"username": "revision-viewer", "password": testAdminPassword, "permissions": []string{"data.read"},
	}, http.StatusOK)
	var viewer app.User
	if err := json.Unmarshal(createdViewer.Data, &viewer); err != nil || viewer.ID == "" {
		t.Fatalf("invalid viewer: %s: %v", createdViewer.Data, err)
	}
	viewerSession := loginHTTP(t, client, base, viewer.Username, testAdminPassword)
	readMe := func() app.MeRes {
		t.Helper()
		envelope := httpJSON(t, client, http.MethodGet, base+"/api/v1/auth/me", viewerSession.AccessToken, nil, http.StatusOK)
		var me app.MeRes
		if err := json.Unmarshal(envelope.Data, &me); err != nil || me.User == nil || me.ID != viewer.ID || me.Username != viewer.Username || me.Disabled || me.AuthzRevision == "" {
			t.Fatalf("incompatible or incomplete me response: %s: %v", envelope.Data, err)
		}
		return me
	}
	beforeGrant := readMe()
	grant := map[string]any{"datasetId": dataFile.ID, "table": "header_rows", "operations": []string{"read"}, "columns": []string{"id"}}
	request(http.MethodPut, "/api/v1/users/"+viewer.ID+"/grants", "", grant, http.StatusOK)
	afterGrant := readMe()
	if afterGrant.AuthzRevision == beforeGrant.AuthzRevision || !slices.Equal(afterGrant.Permissions, beforeGrant.Permissions) {
		t.Fatalf("table grant must change revision while preserving global permissions: before=%#v after=%#v", beforeGrant, afterGrant)
	}
	readRows := func() int64 {
		t.Helper()
		envelope := httpJSON(t, client, http.MethodPost, base+datasetPath+"/tables/header_rows/query", viewerSession.AccessToken, map[string]any{}, http.StatusOK)
		var query app.QueryResult
		if err := json.Unmarshal(envelope.Data, &query); err != nil {
			t.Fatal(err)
		}
		return query.Total
	}
	if readRows() != 1 {
		t.Fatal("viewer did not receive the granted row")
	}
	grant["rowFilter"] = app.Filter{Field: "id", Op: "eq", Value: "2"}
	request(http.MethodPut, "/api/v1/users/"+viewer.ID+"/grants", "", grant, http.StatusOK)
	afterRestriction := readMe()
	if afterRestriction.AuthzRevision == afterGrant.AuthzRevision || !slices.Equal(afterRestriction.Permissions, afterGrant.Permissions) || readRows() != 0 {
		t.Fatal("row restriction did not update the revision and effective data access")
	}
}
