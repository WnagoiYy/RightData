package server_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"server/app"
)

func prepareBusinessDataset(t *testing.T, a *app.App, id string) string {
	t.Helper()
	ctx := testContext(t)
	databaseDir := filepath.Join(a.Config.DataDir, "databases")
	if err := os.MkdirAll(databaseDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(databaseDir, id+".duckdb")
	password := "business-password-at-least-12"
	db, err := app.OpenEncrypted(ctx, path, password)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `
		CREATE TABLE sales(
			id BIGINT PRIMARY KEY,
			region VARCHAR NOT NULL,
			amount DECIMAL(20,2) NOT NULL,
			secret VARCHAR NOT NULL
		);
		INSERT INTO sales VALUES
			(9007199254740993, 'north', 10.25, 'north-secret'),
			(9007199254740994, 'south', 20.50, 'south-secret');
	`)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = a.DB.ExecContext(ctx,
		`INSERT INTO data_files(id,name,kind,source_id,path,password,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?)`,
		id, id+".duckdb", "business", "", path, password, "test-owner", time.Now().UTC(),
	)
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func grantNorthReader(t *testing.T, a *app.App, userID, datasetID string) *app.User {
	t.Helper()
	operations, _ := json.Marshal([]string{"read"})
	columns, _ := json.Marshal([]string{"id", "region", "amount"})
	rowFilter, _ := json.Marshal(app.Filter{Field: "region", Op: "eq", Value: "north"})
	if _, err := a.DB.ExecContext(testContext(t),
		`INSERT INTO grants(user_id,dataset_id,table_name,operations,columns_json,row_filter) VALUES(?,?,?,?,?,?)`,
		userID, datasetID, "sales", string(operations), string(columns), string(rowFilter),
	); err != nil {
		t.Fatal(err)
	}
	return &app.User{ID: userID, Username: "reader", Permissions: []string{"data.read", "sql.execute"}}
}

func TestQueryAppliesRowAndColumnPolicyBeforeAggregation(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareBusinessDataset(t, a, "sales-db")
	user := grantNorthReader(t, a, "reader-1", "sales-db")
	ctx := userContext(t, user)

	result, err := a.Query(ctx, app.QueryRequest{
		DatasetID:  "sales-db",
		Table:      "sales",
		Fields:     []string{"region"},
		GroupBy:    []string{"region"},
		Aggregates: []app.Aggregate{{Function: "sum", Field: "amount", Alias: "total"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 1 || len(result.Rows) != 1 {
		t.Fatalf("row policy was not applied before aggregation: total=%d rows=%#v", result.Total, result.Rows)
	}
	if got := result.Rows[0]["region"]; got != "north" {
		t.Fatalf("unexpected region: %#v", got)
	}
	if got := result.Rows[0]["total"]; got != "10.25" {
		t.Fatalf("decimal did not preserve scale/precision: %#v", got)
	}

	_, err = a.Query(ctx, app.QueryRequest{DatasetID: "sales-db", Table: "sales", Fields: []string{"secret"}})
	requireAPIError(t, err, 403, "column_forbidden")
}

func TestQueryBindsFilterValuesAndPreservesLargeIntegers(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareBusinessDataset(t, a, "sales-db")
	ctx := userContext(t, grantNorthReader(t, a, "reader-1", "sales-db"))

	result, err := a.Query(ctx, app.QueryRequest{
		DatasetID: "sales-db",
		Table:     "sales",
		Fields:    []string{"id", "region", "amount"},
		Filters:   []app.Filter{{Field: "region", Op: "eq", Value: `north' OR 1=1 --`}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 0 || len(result.Rows) != 0 {
		t.Fatalf("filter value changed SQL semantics: total=%d rows=%#v", result.Total, result.Rows)
	}
	logs, err := (&app.ConfigController{App: a}).QueryLogs(
		userContext(t, &app.User{ID: "log-reader", Permissions: []string{"logs.read"}}),
		&app.QueryLogsReq{DatasetID: "sales-db"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs.Items) == 0 {
		t.Fatal("query execution did not produce a query log")
	}
	for _, item := range logs.Items {
		if strings.Contains(item.SQLTemplate, `north' OR 1=1 --`) {
			t.Fatalf("query log leaked a bound parameter: %#v", item)
		}
	}
	if !strings.Contains(logs.Items[0].SQLTemplate, "?") || logs.Items[0].Source != "api" || logs.Items[0].Outcome != "success" {
		t.Fatalf("query log did not retain a safe template/source/outcome: %#v", logs.Items[0])
	}

	result, err = a.Query(ctx, app.QueryRequest{
		DatasetID: "sales-db",
		Table:     "sales",
		Fields:    []string{"id", "amount"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 || result.Rows[0]["id"] != "9007199254740993" || result.Rows[0]["amount"] != "10.25" {
		t.Fatalf("lossless values not preserved: %#v", result.Rows)
	}
}

func TestControlledSQLUsesSameDataPolicy(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareBusinessDataset(t, a, "sales-db")
	ctx := userContext(t, grantNorthReader(t, a, "reader-1", "sales-db"))

	result, err := a.QueryControlledSQL(ctx, app.ControlledSQLRequest{
		DatasetID: "sales-db",
		SQL:       `SELECT id, region FROM sales WHERE amount >= :minimum AND region = :sensitive ORDER BY id`,
		Params:    map[string]any{"minimum": "0.00", "sensitive": "north"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 1 || len(result.Rows) != 1 || result.Rows[0]["region"] != "north" {
		t.Fatalf("controlled SQL bypassed data policy: %#v", result)
	}
	logs, err := (&app.ConfigController{App: a}).QueryLogs(
		userContext(t, &app.User{ID: "log-reader", Permissions: []string{"logs.read"}}),
		&app.QueryLogsReq{DatasetID: "sales-db"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs.Items) != 1 {
		t.Fatalf("controlled SQL query log count = %d, want 1", len(logs.Items))
	}
	log := logs.Items[0]
	if log.Kind != "controlled_sql" || log.Source != "api" || !strings.Contains(log.SQLTemplate, "?") {
		t.Fatalf("controlled SQL query log metadata is invalid: %#v", log)
	}
	if strings.Contains(log.SQLTemplate, "0.00") || strings.Contains(log.SQLTemplate, "north") {
		t.Fatalf("controlled SQL query log leaked bound parameters: %#v", log)
	}
}

func TestGrantColumnsAndRowsCannotBeComposedAcrossGrants(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareBusinessDataset(t, a, "sales-db")
	user := persistedUser(t, a, "split-grants", "data.read")
	grantTable(t, a, user.ID, "sales-db", "*", []string{"read"}, []string{"id"}, nil)
	grantTable(t, a, user.ID, "sales-db", "sales", []string{"read"}, []string{"secret"}, app.Filter{Field: "region", Op: "eq", Value: "north"})
	ctx := userContext(t, user)

	secret, err := a.Query(ctx, app.QueryRequest{DatasetID: "sales-db", Table: "sales", Fields: []string{"secret"}})
	if err != nil {
		t.Fatal(err)
	}
	if secret.Total != 1 || len(secret.Rows) != 1 || secret.Rows[0]["secret"] != "north-secret" {
		t.Fatalf("row scope was borrowed from the unrelated wildcard grant: %#v", secret)
	}
	_, err = a.Query(ctx, app.QueryRequest{DatasetID: "sales-db", Table: "sales", Fields: []string{"id", "secret"}})
	requireAPIError(t, err, 403, "column_forbidden")
}

func TestMutationIsAtomicAndIdempotent(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareBusinessDataset(t, a, "sales-db")
	ctx := userContext(t, &app.User{ID: "admin-test", Username: "admin", Permissions: []string{"*"}})

	failed := app.MutationRequest{
		DatasetID:      "sales-db",
		Table:          "sales",
		IdempotencyKey: "atomic-failure",
		Operations: []app.RecordMutation{
			{Action: "insert", Values: map[string]any{"id": "9007199254740995", "region": "north", "amount": "30.75", "secret": "ok"}},
			{Action: "insert", Values: map[string]any{"id": "not-a-number", "region": "north", "amount": "40.00", "secret": "bad"}},
		},
	}
	if _, err := a.Mutate(ctx, failed); err == nil {
		t.Fatal("invalid second operation did not fail the transaction")
	}
	db, err := a.DatasetDB(ctx, "sales-db")
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.DB.QueryRowContext(ctx, `SELECT count(*) FROM sales WHERE id=9007199254740995`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("partial transaction committed %d row(s)", count)
	}

	request := app.MutationRequest{
		DatasetID:      "sales-db",
		Table:          "sales",
		IdempotencyKey: "one-insert",
		Operations: []app.RecordMutation{{Action: "insert", Values: map[string]any{
			"id": "9007199254740995", "region": "north", "amount": "30.75", "secret": "once",
		}}},
	}
	first, err := a.Mutate(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.Mutate(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first.Inserted != 1 {
		t.Fatalf("idempotent replay returned inconsistent results: first=%#v second=%#v", first, second)
	}
	if err = db.DB.QueryRowContext(ctx, `SELECT count(*) FROM sales WHERE id=9007199254740995`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("idempotent replay committed %d rows", count)
	}

	conflict := request
	conflict.Operations = []app.RecordMutation{{Action: "delete", Filter: &app.Filter{Field: "id", Op: "eq", Value: "9007199254740995"}}}
	_, err = a.Mutate(ctx, conflict)
	requireAPIError(t, err, 409, "idempotency_conflict")
}

func TestUnicodeSchemaDefaultsConstraintsAndTimestampSemantics(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareBusinessDataset(t, a, "sales-db")
	admin := &app.User{ID: "schema-admin", Username: "schema-admin", Permissions: []string{"*"}}
	ctx := userContext(t, admin)
	_, err := a.MutateSchema(ctx, app.SchemaMutationRequest{
		DatasetID: "sales-db", IdempotencyKey: "create-chinese-table", Action: "create_table", Table: "订单",
		Fields: []app.FieldDefinition{
			{Name: "编号", DataType: "BIGINT", PrimaryKey: true},
			{Name: "名称", DataType: "VARCHAR", Default: "未命名", Unique: true},
			{Name: "本地时间", DataType: "TIMESTAMP"},
			{Name: "绝对时间", DataType: "TIMESTAMP WITH TIME ZONE"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	fields, err := a.Schema(ctx, "sales-db", "订单")
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]app.Field{}
	for _, field := range fields {
		byName[field.Name] = field
	}
	if !byName["编号"].PrimaryKey || !byName["名称"].Unique || byName["名称"].Default == nil {
		t.Fatalf("schema metadata lost constraints/default: %#v", fields)
	}
	_, err = a.Mutate(ctx, app.MutationRequest{
		DatasetID: "sales-db", Table: "订单", IdempotencyKey: "insert-chinese-row",
		Operations: []app.RecordMutation{{Action: "insert", Values: map[string]any{
			"编号": "9007199254740993", "本地时间": "2024-01-02T03:04:05", "绝对时间": "2024-01-02T03:04:05+08:00",
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := a.Query(ctx, app.QueryRequest{
		DatasetID: "sales-db", Table: "订单", Fields: []string{"编号", "名称", "本地时间", "绝对时间"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 {
		t.Fatalf("unexpected Unicode table rows: %#v", result)
	}
	row := result.Rows[0]
	if row["编号"] != "9007199254740993" || row["名称"] != "未命名" {
		t.Fatalf("default or bigint was not preserved: %#v", row)
	}
	if row["本地时间"] != "2024-01-02T03:04:05" {
		t.Fatalf("timezone-free timestamp changed semantics: %#v", row["本地时间"])
	}
	if row["绝对时间"] != "2024-01-01T19:04:05Z" {
		t.Fatalf("timezone-aware timestamp was not normalized to UTC: %#v", row["绝对时间"])
	}

	_, err = a.MutateSchema(ctx, app.SchemaMutationRequest{
		DatasetID: "sales-db", IdempotencyKey: "unsafe-default", Action: "add_column", Table: "订单",
		Field: &app.FieldDefinition{Name: "危险", DataType: "INTEGER", Nullable: true, Default: `0); DROP TABLE "订单";--`},
	})
	if err == nil {
		t.Fatal("SQL expression was accepted as a numeric default")
	}
	if _, err = a.Schema(ctx, "sales-db", "订单"); err != nil {
		t.Fatalf("unsafe default damaged the table: %v", err)
	}
}
