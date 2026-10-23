package server_test

import (
	"encoding/json"
	"testing"

	"server/app"
)

func TestConfigOptimisticVersionIdempotencyAndExecutionPolicy(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareBusinessDataset(t, a, "sales-db")
	owner := persistedUser(t, a, "config-owner", "config.write", "config.read")
	otherWriter := persistedUser(t, a, "config-writer", "config.write", "config.read")
	reader := persistedUser(t, a, "config-reader", "config.read", "data.read")
	grantTable(t, a, reader.ID, "sales-db", "sales", []string{"read"}, []string{"id", "region", "amount"}, app.Filter{Field: "region", Op: "eq", Value: "north"})
	controller := &app.ConfigController{App: a}
	body := json.RawMessage(`{"datasetId":"sales-db","query":{"datasetId":"sales-db","table":"sales","fields":["id","region","amount"],"orderBy":[{"field":"id","direction":"asc"}]}}`)
	request := &app.ConfigSaveReq{
		ID: "north-sales", Kind: "query", Name: "North sales", Body: body,
		Version: 0, IdempotencyKey: "save-v1",
	}
	first, err := controller.Save(userContext(t, owner), request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Version != 1 || first.OwnerID != owner.ID {
		t.Fatalf("unexpected first version: %#v", first)
	}
	replayed, err := controller.Save(userContext(t, owner), request)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Version != first.Version || replayed.UpdatedAt != first.UpdatedAt {
		t.Fatalf("idempotent replay changed the saved config: first=%#v replay=%#v", first, replayed)
	}

	changed := *request
	changed.Name = "Changed under reused key"
	_, err = controller.Save(userContext(t, owner), &changed)
	requireAPIError(t, err, 409, "idempotency_conflict")
	stale := *request
	stale.IdempotencyKey = "different-key-with-stale-version"
	_, err = controller.Save(userContext(t, owner), &stale)
	requireAPIError(t, err, 409, "version_conflict")

	updatedRequest := *request
	updatedRequest.Name = "North sales updated"
	updatedRequest.Version = first.Version
	updatedRequest.IdempotencyKey = "save-by-other-writer"
	updated, err := controller.Save(userContext(t, otherWriter), &updatedRequest)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != first.Version+1 || updated.OwnerID != owner.ID {
		t.Fatalf("cross-user update changed config ownership or version: %#v", updated)
	}
	listed, err := controller.List(userContext(t, reader), &app.ConfigListReq{Kind: "query"})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 1 || listed.Items[0].OwnerID != owner.ID || listed.Items[0].Version != updated.Version {
		t.Fatalf("config list is inconsistent after cross-user update: %#v", listed.Items)
	}

	result, err := controller.Execute(userContext(t, reader), &app.DefinitionExecuteReq{ID: first.ID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 1 || len(result.Rows) != 1 || result.Rows[0]["region"] != "north" {
		t.Fatalf("saved query did not use the execution user's row policy: %#v", result)
	}
	if _, ok := result.Rows[0]["secret"]; ok {
		t.Fatalf("saved query exposed a column outside the execution user's grant: %#v", result.Rows[0])
	}
}
