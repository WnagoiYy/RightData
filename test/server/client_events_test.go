package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"server/app"
)

func startClientEventServer(t *testing.T) (*app.App, string, *http.Client) {
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

func createClientEventUser(t *testing.T, client *http.Client, base, adminToken, username string, permissions ...string) app.SessionResult {
	t.Helper()
	password := username + "-password-at-least-12"
	created := httpJSON(t, client, http.MethodPost, base+"/api/v1/users", adminToken, map[string]any{
		"username": username, "password": password, "permissions": permissions,
	}, http.StatusOK)
	var user app.User
	if err := json.Unmarshal(created.Data, &user); err != nil || user.ID == "" {
		t.Fatalf("invalid created user: %s err=%v", created.Data, err)
	}
	return loginHTTP(t, client, base, username, password)
}

func seedClientEventJob(t *testing.T, a *app.App, id, actorID, kind, state string) {
	t.Helper()
	now := time.Now().UTC()
	payload := `{}`
	if kind == "export" {
		payload = `{"export":{"datasetId":"seed","table":"rows","fields":["id"]}}`
	}
	if _, err := a.DB.ExecContext(testContext(t),
		`INSERT INTO jobs(id,actor_id,kind,dataset_id,state,progress,fingerprint,idempotency_key,payload,result,error,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)`,
		id, actorID, kind, "seed", state, `{}`, "seed-fingerprint-"+id, "seed-key-"+id, payload, now, now, now.Add(time.Hour),
	); err != nil {
		t.Fatal(err)
	}
}

func probeInstanceID(t *testing.T, client *http.Client, base string) string {
	t.Helper()
	envelope := httpJSON(t, client, http.MethodGet, base+"/api/probe", "", nil, http.StatusOK)
	var probe app.ProbeRes
	if err := json.Unmarshal(envelope.Data, &probe); err != nil || probe.InstanceID == "" {
		t.Fatalf("invalid probe: %s err=%v", envelope.Data, err)
	}
	return probe.InstanceID
}

func postClientEvent(t *testing.T, client *http.Client, base, token string, body map[string]any, wantStatus int) (httpEnvelope, *app.ClientEventReceipt) {
	t.Helper()
	envelope := httpJSON(t, client, http.MethodPost, base+"/api/v1/client-events", token, body, wantStatus)
	if wantStatus != http.StatusOK {
		return envelope, nil
	}
	var receipt app.ClientEventReceipt
	if err := json.Unmarshal(envelope.Data, &receipt); err != nil || receipt.EventID == "" || receipt.ReceivedAt.IsZero() {
		t.Fatalf("invalid client event receipt: %s err=%v", envelope.Data, err)
	}
	return envelope, &receipt
}

func readHTTPJob(t *testing.T, client *http.Client, base, token, jobID string) app.GetJobRes {
	t.Helper()
	envelope := httpJSON(t, client, http.MethodGet, base+"/api/v1/jobs/"+jobID, token, nil, http.StatusOK)
	var result app.GetJobRes
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestClientEventHTTPIdempotencyIdentityAndOwnership(t *testing.T) {
	a, base, client := startClientEventServer(t)
	admin := loginHTTP(t, client, base, "admin", testAdminPassword)
	owner := createClientEventUser(t, client, base, admin.AccessToken, "event-owner", "jobs.read")
	instanceID := probeInstanceID(t, client, base)
	seedClientEventJob(t, a, "owner-export", owner.User.ID, "export", "succeeded")
	seedClientEventJob(t, a, "owner-import", owner.User.ID, "import", "succeeded")
	seedClientEventJob(t, a, "admin-export", admin.User.ID, "export", "succeeded")

	before := readHTTPJob(t, client, base, owner.AccessToken, "owner-export")
	if before.State != "succeeded" || before.ClientReport == nil || before.ClientReport.Outcome != "unknown" {
		t.Fatalf("unreported export did not expose unknown client stage: %#v", before)
	}
	if got := httpJSON(t, client, http.MethodPut, base+"/api/v1/users/"+owner.User.ID, admin.AccessToken, map[string]any{
		"permissions": []string{}, "disabled": false,
	}, http.StatusOK); got.Code != "ok" {
		t.Fatalf("could not revoke owner permissions before offline report: %#v", got)
	}

	body := map[string]any{
		"eventId": "018f47d2-bb75-7b64-8f12-7bb36b975b60", "instanceId": instanceID,
		"occurredAt": "2026-10-23T02:30:00.123456+08:00", "category": "client_export",
		"action": "file_generation", "targetId": "owner-export", "outcome": "success",
	}
	if envelope, _ := postClientEvent(t, client, base, "", body, http.StatusUnauthorized); envelope.Code != "unauthenticated" {
		t.Fatalf("unexpected anonymous response: %#v", envelope)
	}
	_, first := postClientEvent(t, client, base, owner.AccessToken, body, http.StatusOK)
	_, retry := postClientEvent(t, client, base, owner.AccessToken, body, http.StatusOK)
	if *retry != *first || !first.Applied {
		t.Fatalf("idempotent retry changed receipt: first=%#v retry=%#v", first, retry)
	}
	var auditCount int
	if err := a.DB.QueryRowContext(testContext(t), `SELECT count(*) FROM audit WHERE category='client_export' AND target='owner-export'`).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("same event wrote %d audit rows: %v", auditCount, err)
	}

	conflict := map[string]any{}
	for key, value := range body {
		conflict[key] = value
	}
	conflict["outcome"] = "failed"
	if envelope, _ := postClientEvent(t, client, base, owner.AccessToken, conflict, http.StatusConflict); envelope.Code != "event_id_conflict" {
		t.Fatalf("unexpected conflict response: %#v", envelope)
	}

	wrongInstance := map[string]any{}
	for key, value := range body {
		wrongInstance[key] = value
	}
	wrongInstance["eventId"] = "018f47d2-bb75-7b64-8f12-7bb36b975b61"
	wrongInstance["instanceId"] = "another-instance"
	if envelope, _ := postClientEvent(t, client, base, owner.AccessToken, wrongInstance, http.StatusConflict); envelope.Code != "instance_mismatch" {
		t.Fatalf("unexpected instance response: %#v", envelope)
	}

	foreign := map[string]any{}
	for key, value := range body {
		foreign[key] = value
	}
	foreign["eventId"] = "018f47d2-bb75-7b64-8f12-7bb36b975b62"
	foreign["targetId"] = "admin-export"
	if envelope, _ := postClientEvent(t, client, base, owner.AccessToken, foreign, http.StatusForbidden); envelope.Code != "forbidden" {
		t.Fatalf("unexpected foreign-job response: %#v", envelope)
	}

	wrongKind := map[string]any{}
	for key, value := range body {
		wrongKind[key] = value
	}
	wrongKind["eventId"] = "018f47d2-bb75-7b64-8f12-7bb36b975b63"
	wrongKind["targetId"] = "owner-import"
	if envelope, _ := postClientEvent(t, client, base, owner.AccessToken, wrongKind, http.StatusConflict); envelope.Code != "invalid_event_target" {
		t.Fatalf("unexpected non-export response: %#v", envelope)
	}
	wrongAction := map[string]any{}
	for key, value := range body {
		wrongAction[key] = value
	}
	wrongAction["eventId"] = "018f47d2-bb75-7b64-8f12-7bb36b975b65"
	wrongAction["action"] = "connect"
	if envelope, _ := postClientEvent(t, client, base, owner.AccessToken, wrongAction, http.StatusBadRequest); envelope.Code != "invalid_client_event" {
		t.Fatalf("unexpected client-export action response: %#v", envelope)
	}

	invalidID := map[string]any{}
	for key, value := range body {
		invalidID[key] = value
	}
	invalidID["eventId"] = "not-a-uuid"
	if envelope, _ := postClientEvent(t, client, base, owner.AccessToken, invalidID, http.StatusBadRequest); envelope.Code != "invalid_event_id" {
		t.Fatalf("unexpected UUID response: %#v", envelope)
	}
	invalidTime := map[string]any{}
	for key, value := range body {
		invalidTime[key] = value
	}
	invalidTime["eventId"] = "018f47d2-bb75-7b64-8f12-7bb36b975b67"
	invalidTime["occurredAt"] = "not-rfc3339"
	if envelope, _ := postClientEvent(t, client, base, owner.AccessToken, invalidTime, http.StatusBadRequest); envelope.Code != "invalid_occurred_at" {
		t.Fatalf("unexpected occurredAt response: %#v", envelope)
	}

	relay := map[string]any{
		"eventId": "018f47d2-bb75-7b64-8f12-7bb36b975b64", "instanceId": instanceID,
		"occurredAt": "2026-10-23T02:31:00Z", "category": "relay", "action": "connect",
		"targetId": "relay-node", "outcome": "success",
	}
	if _, receipt := postClientEvent(t, client, base, owner.AccessToken, relay, http.StatusOK); !receipt.Applied {
		t.Fatal("relay event was not accepted")
	}
	adminEvent := map[string]any{
		"eventId": "018f47d2-bb75-7b64-8f12-7bb36b975b66", "instanceId": instanceID,
		"occurredAt": "2026-10-23T02:32:00Z", "category": "client_export", "action": "file_generation",
		"targetId": "admin-export", "outcome": "success",
	}
	postClientEvent(t, client, base, admin.AccessToken, adminEvent, http.StatusOK)
	if envelope, _ := postClientEvent(t, client, base, owner.AccessToken, adminEvent, http.StatusForbidden); envelope.Code != "forbidden" {
		t.Fatalf("another user's receipt leaked through actor-scoped eventId: %#v", envelope)
	}
	if got := httpJSON(t, client, http.MethodPut, base+"/api/v1/users/"+owner.User.ID, admin.AccessToken, map[string]any{
		"permissions": []string{"jobs.read"}, "disabled": false,
	}, http.StatusOK); got.Code != "ok" {
		t.Fatalf("could not restore jobs.read for report query: %#v", got)
	}

	after := readHTTPJob(t, client, base, owner.AccessToken, "owner-export")
	if after.State != "succeeded" || after.ClientReport == nil || after.ClientReport.EventID != first.EventID || after.ClientReport.Outcome != "success" {
		t.Fatalf("client report missing or server job state changed: %#v", after)
	}
	listed := httpJSON(t, client, http.MethodGet, base+"/api/v1/client-events?category=client_export&targetId=owner-export", admin.AccessToken, nil, http.StatusOK)
	var events app.ListClientEventsRes
	if err := json.Unmarshal(listed.Data, &events); err != nil || len(events.Items) != 1 || events.Items[0].EventID != first.EventID || events.Items[0].OccurredAt.IsZero() {
		t.Fatalf("client event log is not searchable: %s err=%v", listed.Data, err)
	}
	if _, err := a.DB.ExecContext(testContext(t), `DELETE FROM audit WHERE category='client_export' AND target='owner-export'`); err != nil {
		t.Fatal(err)
	}
	_, afterAuditCleanup := postClientEvent(t, client, base, owner.AccessToken, body, http.StatusOK)
	if *afterAuditCleanup != *first {
		t.Fatalf("audit cleanup removed stable receipt: first=%#v retry=%#v", first, afterAuditCleanup)
	}
	if err := a.DB.QueryRowContext(testContext(t), `SELECT count(*) FROM audit WHERE category='client_export' AND target='owner-export'`).Scan(&auditCount); err != nil || auditCount != 0 {
		t.Fatalf("retry recreated cleaned audit row: count=%d err=%v", auditCount, err)
	}

	t.Run("migrates legacy timestamp event columns", func(t *testing.T) {
		dataDir := runtimeTempDir(t)
		legacy, err := app.Open(testContext(t), app.Config{
			DataDir: dataDir, AdminUsername: "admin", AdminPassword: testAdminPassword, CookieSecure: false,
		})
		if err != nil {
			t.Fatal(err)
		}
		statements := []string{
			`DROP TABLE client_event_latest`,
			`DROP TABLE client_events`,
			`CREATE TABLE client_events (actor_id VARCHAR NOT NULL,event_id VARCHAR NOT NULL,fingerprint VARCHAR NOT NULL,instance_id VARCHAR NOT NULL,category VARCHAR NOT NULL,action VARCHAR NOT NULL,target_id VARCHAR NOT NULL,outcome VARCHAR NOT NULL,occurred_at TIMESTAMP NOT NULL,received_at TIMESTAMP NOT NULL,applied BOOLEAN NOT NULL,audit_id VARCHAR NOT NULL,PRIMARY KEY(actor_id,event_id))`,
			`CREATE TABLE client_event_latest (actor_id VARCHAR NOT NULL,target_id VARCHAR NOT NULL,stage VARCHAR NOT NULL,event_id VARCHAR NOT NULL,occurred_at TIMESTAMP NOT NULL,PRIMARY KEY(actor_id,target_id,stage))`,
			`INSERT INTO client_events VALUES ('legacy-user','018f47d2-bb75-7b64-8f12-7bb36b975b68','fingerprint','instance','client_export','file_generation','legacy-job','success',TIMESTAMP '2026-10-22 18:00:00.123456',TIMESTAMP '2026-10-22 18:01:00.000000',true,'audit')`,
			`INSERT INTO client_event_latest VALUES ('legacy-user','legacy-job','file_generation','018f47d2-bb75-7b64-8f12-7bb36b975b68',TIMESTAMP '2026-10-22 18:00:00.123456')`,
		}
		for _, statement := range statements {
			if _, err = legacy.DB.ExecContext(testContext(t), statement); err != nil {
				_ = legacy.Close()
				t.Fatal(err)
			}
		}
		if err = legacy.Close(); err != nil {
			t.Fatal(err)
		}
		migrated, err := app.Open(testContext(t), app.Config{
			DataDir: dataDir, AdminUsername: "admin", AdminPassword: testAdminPassword, CookieSecure: false,
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = migrated.Close() })
		for _, table := range []string{"client_events", "client_event_latest"} {
			var dataType, occurredAt string
			if err = migrated.DB.QueryRowContext(testContext(t), `SELECT data_type FROM information_schema.columns WHERE table_schema='main' AND table_name=? AND column_name='occurred_at'`, table).Scan(&dataType); err != nil {
				t.Fatal(err)
			}
			if dataType != "VARCHAR" {
				t.Fatalf("%s occurred_at type = %q, want VARCHAR", table, dataType)
			}
			if err = migrated.DB.QueryRowContext(testContext(t), `SELECT occurred_at FROM `+table+` LIMIT 1`).Scan(&occurredAt); err != nil {
				t.Fatal(err)
			}
			if occurredAt != "2026-10-22T18:00:00.123456Z" {
				t.Fatalf("%s migrated occurred_at = %q", table, occurredAt)
			}
			if _, err = time.Parse(time.RFC3339Nano, occurredAt); err != nil {
				t.Fatalf("%s migrated occurred_at is not RFC3339: %v", table, err)
			}
		}
	})
}

func TestClientEventLatestReportIsDeterministicForOutOfOrderDelivery(t *testing.T) {
	a, base, client := startClientEventServer(t)
	admin := loginHTTP(t, client, base, "admin", testAdminPassword)
	owner := createClientEventUser(t, client, base, admin.AccessToken, "ordered-owner", "jobs.read")
	instanceID := probeInstanceID(t, client, base)
	seedClientEventJob(t, a, "ordered-export", owner.User.ID, "export", "succeeded")

	post := func(eventID, occurredAt, outcome string) *app.ClientEventReceipt {
		t.Helper()
		_, receipt := postClientEvent(t, client, base, owner.AccessToken, map[string]any{
			"eventId": eventID, "instanceId": instanceID, "occurredAt": occurredAt,
			"category": "client_export", "action": "file_generation", "targetId": "ordered-export", "outcome": outcome,
		}, http.StatusOK)
		return receipt
	}
	newest := post("018f47d2-bb75-7b64-8f12-7bb36b975b62", "2026-10-23T03:00:00Z", "success")
	older := post("018f47d2-bb75-7b64-8f12-7bb36b975b64", "2026-10-23T02:00:00Z", "failed")
	equalButLower := post("018f47d2-bb75-7b64-8f12-7bb36b975b61", "2026-10-23T03:00:00Z", "failed")
	equalButHigher := post("018f47d2-bb75-7b64-8f12-7bb36b975b63", "2026-10-23T03:00:00Z", "canceled")
	if !newest.Applied || older.Applied || equalButLower.Applied || !equalButHigher.Applied {
		t.Fatalf("unexpected applied decisions: newest=%v older=%v lower=%v higher=%v", newest.Applied, older.Applied, equalButLower.Applied, equalButHigher.Applied)
	}
	result := readHTTPJob(t, client, base, owner.AccessToken, "ordered-export")
	if result.State != "succeeded" || result.ClientReport == nil || result.ClientReport.EventID != equalButHigher.EventID || result.ClientReport.Outcome != "canceled" {
		t.Fatalf("out-of-order report replaced wrong state: %#v", result)
	}
	var state string
	if err := a.DB.QueryRowContext(testContext(t), `SELECT state FROM jobs WHERE id='ordered-export'`).Scan(&state); err != nil || state != "succeeded" {
		t.Fatalf("client report changed server job state to %q: %v", state, err)
	}
	_, olderRetry := postClientEvent(t, client, base, owner.AccessToken, map[string]any{
		"eventId": older.EventID, "instanceId": instanceID, "occurredAt": "2026-10-23T02:00:00Z",
		"category": "client_export", "action": "file_generation", "targetId": "ordered-export", "outcome": "failed",
	}, http.StatusOK)
	if *olderRetry != *older {
		t.Fatalf("late-event retry did not retain original ack: first=%#v retry=%#v", older, olderRetry)
	}
}
