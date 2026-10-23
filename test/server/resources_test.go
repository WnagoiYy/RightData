package server_test

import (
	"encoding/json"
	"testing"
	"time"

	"server/app"
)

func insertResourceConfig(t *testing.T, a *app.App, id, kind, name string, body any) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.ExecContext(testContext(t),
		`INSERT INTO configs(id,kind,name,body,owner_id,version,updated_at) VALUES(?,?,?,?,?,?,?)`,
		id, kind, name, string(encoded), "resource-test-owner", 1, time.Now().UTC(),
	); err != nil {
		t.Fatal(err)
	}
}

func resourceQueryDefinition(datasetID string, fields []string, permissions ...string) map[string]any {
	return map[string]any{
		"datasetId": datasetID,
		"query": app.QueryRequest{
			DatasetID: datasetID,
			Table:     "sales",
			Fields:    fields,
			OrderBy:   []app.Order{{Field: "id", Direction: "asc"}},
		},
		"permissions": permissions,
	}
}

func TestResourceUserExecutesBoundQueryWithoutConfigRead(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareBusinessDataset(t, a, "sales-db")
	reader := persistedUser(t, a, "resource-reader",
		"resources.read", "data.read", "resource.view", "resource.query", "menu.parent", "menu.child",
	)
	grantTable(t, a, reader.ID, "sales-db", "sales", []string{"read"}, []string{"id", "region", "amount"}, app.Filter{Field: "region", Op: "eq", Value: "north"})

	insertResourceConfig(t, a, "north-query", "query", "North query",
		resourceQueryDefinition("sales-db", []string{"id", "region", "amount"}, "resource.query"))
	insertResourceConfig(t, a, "sales-report", "report", "Sales report", app.ResourcePolicy{
		Enabled: true, Permissions: []string{"resource.view"}, DefinitionIDs: []string{"north-query"},
	})
	insertResourceConfig(t, a, "reports-menu", "menu", "Reports", app.MenuPolicy{
		Enabled: true, Permissions: []string{"menu.parent"}, Order: 1,
	})
	insertResourceConfig(t, a, "sales-menu", "menu", "Sales", app.MenuPolicy{
		Enabled: true, Permissions: []string{"menu.child"}, ParentID: "reports-menu", Order: 2,
		ResourceID: "sales-report", ResourceKind: "report",
	})

	if app.HasPermission(reader, "config.read") {
		t.Fatal("resource reader unexpectedly has config.read")
	}
	controller := &app.ResourceController{App: a}
	menus, err := controller.Menus(userContext(t, reader), &app.MenuListReq{})
	if err != nil {
		t.Fatal(err)
	}
	if len(menus.Items) != 2 || menus.Items[0].ID != "reports-menu" || menus.Items[1].ID != "sales-menu" {
		t.Fatalf("authorized menu path was not returned: %#v", menus.Items)
	}
	result, err := controller.Execute(userContext(t, reader), &app.ResourceExecuteReq{
		ID: "sales-report", DefinitionID: "north-query",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 1 || len(result.Rows) != 1 || result.Rows[0]["region"] != "north" {
		t.Fatalf("resource query did not apply the reader's row policy: %#v", result)
	}
	if _, exposed := result.Rows[0]["secret"]; exposed {
		t.Fatalf("resource query exposed a column outside the reader's grant: %#v", result.Rows[0])
	}

	_, err = (&app.ConfigController{App: a}).Execute(userContext(t, reader), &app.DefinitionExecuteReq{ID: "north-query"})
	requireAPIError(t, err, 403, "forbidden")
}

func TestResourceExecutionRejectsInaccessibleBindings(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	reader := persistedUser(t, a, "binding-reader", "resources.read", "resource.view", "definition.use")
	controller := &app.ResourceController{App: a}

	insertResourceConfig(t, a, "bound-query", "query", "Bound query", resourceQueryDefinition("unused", []string{"id"}, "definition.use"))
	insertResourceConfig(t, a, "other-query", "query", "Other query", resourceQueryDefinition("unused", []string{"id"}, "definition.use"))
	insertResourceConfig(t, a, "restricted-query", "query", "Restricted query", resourceQueryDefinition("unused", []string{"id"}, "definition.restricted"))

	resources := []struct {
		id     string
		policy app.ResourcePolicy
	}{
		{"unbound-resource", app.ResourcePolicy{Enabled: true, Permissions: []string{"resource.view"}, DefinitionIDs: []string{"bound-query"}}},
		{"disabled-resource", app.ResourcePolicy{Enabled: false, Permissions: []string{"resource.view"}, DefinitionIDs: []string{"bound-query"}}},
		{"disabled-menu-resource", app.ResourcePolicy{Enabled: true, Permissions: []string{"resource.view"}, DefinitionIDs: []string{"bound-query"}}},
		{"disabled-ancestor-resource", app.ResourcePolicy{Enabled: true, Permissions: []string{"resource.view"}, DefinitionIDs: []string{"bound-query"}}},
		{"permission-resource", app.ResourcePolicy{Enabled: true, Permissions: []string{"resource.restricted"}, DefinitionIDs: []string{"bound-query"}}},
		{"visible-resource", app.ResourcePolicy{Enabled: true, Permissions: []string{"resource.view"}, DefinitionIDs: []string{"bound-query", "restricted-query"}}},
	}
	for _, resource := range resources {
		insertResourceConfig(t, a, resource.id, "report", resource.id, resource.policy)
	}

	insertResourceConfig(t, a, "disabled-resource-menu", "menu", "Disabled resource entry", app.MenuPolicy{
		Enabled: true, ResourceID: "disabled-resource", ResourceKind: "report",
	})
	insertResourceConfig(t, a, "disabled-menu", "menu", "Disabled entry", app.MenuPolicy{
		Enabled: false, ResourceID: "disabled-menu-resource", ResourceKind: "report",
	})
	insertResourceConfig(t, a, "disabled-parent", "menu", "Disabled parent", app.MenuPolicy{Enabled: false})
	insertResourceConfig(t, a, "enabled-child", "menu", "Enabled child", app.MenuPolicy{
		Enabled: true, ParentID: "disabled-parent", ResourceID: "disabled-ancestor-resource", ResourceKind: "report",
	})
	insertResourceConfig(t, a, "permission-menu", "menu", "Permission entry", app.MenuPolicy{
		Enabled: true, ResourceID: "permission-resource", ResourceKind: "report",
	})
	insertResourceConfig(t, a, "visible-menu", "menu", "Visible entry", app.MenuPolicy{
		Enabled: true, ResourceID: "visible-resource", ResourceKind: "report",
	})

	for _, resourceID := range []string{
		"unbound-resource", "disabled-resource", "disabled-menu-resource", "disabled-ancestor-resource", "permission-resource",
	} {
		t.Run(resourceID, func(t *testing.T) {
			_, err := controller.Execute(userContext(t, reader), &app.ResourceExecuteReq{
				ID: resourceID, DefinitionID: "bound-query",
			})
			requireAPIError(t, err, 403, "resource_forbidden")
		})
	}

	t.Run("definition is not bound", func(t *testing.T) {
		_, err := controller.Execute(userContext(t, reader), &app.ResourceExecuteReq{
			ID: "visible-resource", DefinitionID: "other-query",
		})
		requireAPIError(t, err, 403, "definition_forbidden")
	})

	t.Run("definition permission is missing", func(t *testing.T) {
		_, err := controller.Execute(userContext(t, reader), &app.ResourceExecuteReq{
			ID: "visible-resource", DefinitionID: "restricted-query",
		})
		requireAPIError(t, err, 403, "definition_forbidden")
	})
}

func TestResourcePreviewRequiresConfigWriteAndPreservesDataPolicy(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareBusinessDataset(t, a, "sales-db")
	ordinary := persistedUser(t, a, "ordinary-resource-user", "resources.read", "data.read", "resource.query")
	writer := persistedUser(t, a, "resource-writer", "config.write", "data.read", "resource.query")
	grantTable(t, a, writer.ID, "sales-db", "sales", []string{"read"}, []string{"id", "region", "amount"}, app.Filter{Field: "region", Op: "eq", Value: "north"})

	insertResourceConfig(t, a, "preview-query", "query", "Preview query",
		resourceQueryDefinition("sales-db", []string{"id", "region", "amount"}, "resource.query"))
	insertResourceConfig(t, a, "secret-query", "query", "Secret query",
		resourceQueryDefinition("sales-db", []string{"secret"}, "resource.query"))
	insertResourceConfig(t, a, "disabled-preview-report", "report", "Disabled preview report", app.ResourcePolicy{
		Enabled: false, DefinitionIDs: []string{"preview-query", "secret-query"},
	})

	controller := &app.ResourceController{App: a}
	_, err := controller.Preview(userContext(t, ordinary), &app.ResourcePreviewReq{ID: "disabled-preview-report"})
	requireAPIError(t, err, 403, "forbidden")

	if app.HasPermission(writer, "config.read") {
		t.Fatal("preview writer unexpectedly has config.read")
	}
	saved, err := controller.Preview(userContext(t, writer), &app.ResourcePreviewReq{
		ID: "disabled-preview-report", DefinitionID: "preview-query",
	})
	if err != nil {
		t.Fatal(err)
	}
	assertNorthPreviewResult(t, saved.Data)

	unsavedBody := json.RawMessage(`{"enabled":false,"definitionIds":["preview-query","secret-query"],"layout":{"columns":3}}`)
	unsaved, err := controller.Preview(userContext(t, writer), &app.ResourcePreviewReq{
		ID: "unsaved-dashboard", Kind: "dashboard", Body: unsavedBody, DefinitionID: "preview-query",
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(unsaved.Body) != string(unsavedBody) {
		t.Fatalf("preview changed the unsaved layout: got %s want %s", unsaved.Body, unsavedBody)
	}
	assertNorthPreviewResult(t, unsaved.Data)

	var persisted int
	if err = a.DB.QueryRowContext(testContext(t), `SELECT count(*) FROM configs WHERE id=?`, "unsaved-dashboard").Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	if persisted != 0 {
		t.Fatalf("unsaved preview persisted %d config row(s)", persisted)
	}

	_, err = controller.Preview(userContext(t, writer), &app.ResourcePreviewReq{
		Kind: "dashboard", Body: unsavedBody, DefinitionID: "secret-query",
	})
	requireAPIError(t, err, 403, "column_forbidden")
}

func assertNorthPreviewResult(t *testing.T, result *app.QueryResult) {
	t.Helper()
	if result == nil || result.Total != 1 || len(result.Rows) != 1 || result.Rows[0]["region"] != "north" {
		t.Fatalf("preview did not apply the writer's row policy: %#v", result)
	}
	if _, exposed := result.Rows[0]["secret"]; exposed {
		t.Fatalf("preview exposed a column outside the writer's grant: %#v", result.Rows[0])
	}
}

func TestResourceMenuCycleFailsClosed(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	reader := persistedUser(t, a, "cycle-reader", "resources.read")
	insertResourceConfig(t, a, "cycle-resource", "report", "Cycle resource", app.ResourcePolicy{Enabled: true})
	insertResourceConfig(t, a, "cycle-a", "menu", "Cycle A", app.MenuPolicy{
		Enabled: true, ParentID: "cycle-b", ResourceID: "cycle-resource", ResourceKind: "report",
	})
	insertResourceConfig(t, a, "cycle-b", "menu", "Cycle B", app.MenuPolicy{
		Enabled: true, ParentID: "cycle-a",
	})

	controller := &app.ResourceController{App: a}
	_, err := controller.View(userContext(t, reader), &app.ResourceViewReq{ID: "cycle-resource"})
	requireAPIError(t, err, 403, "resource_forbidden")
	menus, err := controller.Menus(userContext(t, reader), &app.MenuListReq{})
	if err != nil {
		t.Fatal(err)
	}
	if len(menus.Items) != 0 {
		t.Fatalf("cyclic menu path was exposed: %#v", menus.Items)
	}
}
