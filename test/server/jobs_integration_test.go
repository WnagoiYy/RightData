package server_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"server/app"
)

const importCSVMediaType = "application/vnd.rightdata.import+csv"

func persistedUser(t *testing.T, a *app.App, id string, permissions ...string) *app.User {
	t.Helper()
	encoded, err := json.Marshal(permissions)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.ExecContext(testContext(t),
		`INSERT INTO users(id,username,password_hash,permissions,disabled,created_at) VALUES(?,?,?,?,false,?)`,
		id, id+"-name", "unused-by-job-tests", string(encoded), time.Now().UTC(),
	); err != nil {
		t.Fatal(err)
	}
	return &app.User{ID: id, Username: id + "-name", Permissions: permissions}
}

func grantTable(t *testing.T, a *app.App, userID, datasetID, table string, operations, columns []string, row any) {
	t.Helper()
	opsJSON, _ := json.Marshal(operations)
	columnsJSON, _ := json.Marshal(columns)
	rowJSON, _ := json.Marshal(row)
	if _, err := a.DB.ExecContext(testContext(t),
		`INSERT INTO grants(user_id,dataset_id,table_name,operations,columns_json,row_filter) VALUES(?,?,?,?,?,?)`,
		userID, datasetID, table, string(opsJSON), string(columnsJSON), string(rowJSON),
	); err != nil {
		t.Fatal(err)
	}
}

func prepareImportDataset(t *testing.T, a *app.App, id string) string {
	t.Helper()
	databaseDir := filepath.Join(a.Config.DataDir, "databases")
	if err := os.MkdirAll(databaseDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(databaseDir, id+".duckdb")
	password := "import-password-at-least-12"
	db, err := app.OpenEncrypted(testContext(t), path, password)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
		CREATE TABLE imports(id BIGINT PRIMARY KEY, segment VARCHAR NOT NULL, note VARCHAR);
		INSERT INTO imports VALUES (1, 'a', 'old-a'), (2, 'b', 'old-b');
		CREATE TABLE _rd_operations(
			key VARCHAR NOT NULL,
			actor VARCHAR NOT NULL,
			fingerprint VARCHAR NOT NULL,
			result VARCHAR NOT NULL,
			created_at TIMESTAMPTZ NOT NULL,
			PRIMARY KEY(key, actor)
		);
	`)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.ExecContext(testContext(t),
		`INSERT INTO data_files(id,name,kind,source_id,path,password,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?)`,
		id, id+".duckdb", "business", "", path, password, "owner", time.Now().UTC(),
	); err != nil {
		t.Fatal(err)
	}
	return path
}

func storeImportCSV(t *testing.T, a *app.App, owner, contents string) string {
	t.Helper()
	id := app.NewID()
	dir := filepath.Join(a.Config.DataDir, "files")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, id+".csv")
	data := []byte(contents)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	now := time.Now().UTC()
	if _, err := a.DB.ExecContext(testContext(t),
		`INSERT INTO files(id,name,path,owner_id,size,sha256,media_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
		id, id+".csv", path, owner, len(data), hex.EncodeToString(digest[:]), importCSVMediaType, now, now,
	); err != nil {
		t.Fatal(err)
	}
	return id
}

func createImportAndWait(t *testing.T, a *app.App, user *app.User, key string, spec app.ImportJobSpec) app.Job {
	t.Helper()
	controller := &app.JobsController{App: a}
	ctx := userContext(t, user)
	created, err := controller.CreateImportJob(ctx, &app.CreateImportJobReq{ImportJobSpec: spec, IdempotencyKey: key})
	if err != nil {
		t.Fatalf("create import %s: %v", key, err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		got, readErr := controller.GetJob(ctx, &app.GetJobReq{ID: created.JobID})
		if readErr != nil {
			t.Fatalf("read import %s: %v", key, readErr)
		}
		switch got.State {
		case "succeeded", "failed", "canceled", "expired":
			return got.Job
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("import %s did not finish", key)
	return app.Job{}
}

func requireJobSucceeded(t *testing.T, job app.Job) {
	t.Helper()
	if job.State != "succeeded" {
		t.Fatalf("job %s ended in %s: %s", job.ID, job.State, job.Error)
	}
}

func TestCSVImportDistinguishesQuotedNullAndSupportsAllModes(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareImportDataset(t, a, "imports-db")
	user := persistedUser(t, a, "importer", "data.write", "jobs.read", "jobs.cancel", "schema.manage")
	grantTable(t, a, user.ID, "imports-db", "imports", []string{"write"}, []string{"*"}, nil)

	job := createImportAndWait(t, a, user, "append-null-semantics", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "append",
		UploadID: storeImportCSV(t, a, user.ID, "id,segment,note\n3,a,\"\\N\"\n4,a,\\N\n"),
	})
	requireJobSucceeded(t, job)
	database, err := a.DatasetDB(testContext(t), "imports-db")
	if err != nil {
		t.Fatal(err)
	}
	var quoted, unquoted *string
	if err = database.DB.QueryRow(`SELECT note FROM imports WHERE id=3`).Scan(&quoted); err != nil {
		t.Fatal(err)
	}
	if err = database.DB.QueryRow(`SELECT note FROM imports WHERE id=4`).Scan(&unquoted); err != nil {
		t.Fatal(err)
	}
	if quoted == nil || *quoted != `\N` || unquoted != nil {
		t.Fatalf("CSV null semantics changed: quoted=%v unquoted=%v", quoted, unquoted)
	}

	job = createImportAndWait(t, a, user, "replace-where", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "replace_where",
		Condition: &app.ImportCondition{Field: "segment", Op: "eq", Value: "a"},
		UploadID:  storeImportCSV(t, a, user.ID, "id,segment,note\n5,a,new-a\n"),
	})
	requireJobSucceeded(t, job)

	job = createImportAndWait(t, a, user, "merge", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "merge", KeyFields: []string{"id"},
		UploadID: storeImportCSV(t, a, user.ID, "id,segment,note\n2,b,merged\n6,c,inserted\n"),
	})
	requireJobSucceeded(t, job)

	job = createImportAndWait(t, a, user, "skip-existing", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "skip_existing", KeyFields: []string{"id"},
		UploadID: storeImportCSV(t, a, user.ID, "id,segment,note\n2,b,must-not-overwrite\n7,d,inserted\n"),
	})
	requireJobSucceeded(t, job)
	var note string
	if err = database.DB.QueryRow(`SELECT note FROM imports WHERE id=2`).Scan(&note); err != nil || note != "merged" {
		t.Fatalf("skip_existing overwrote row: note=%q err=%v", note, err)
	}

	job = createImportAndWait(t, a, user, "replace-all", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "replace_all",
		UploadID: storeImportCSV(t, a, user.ID, "id,segment,note\n8,z,only-row\n"),
	})
	requireJobSucceeded(t, job)
	var count int
	if err = database.DB.QueryRow(`SELECT count(*) FROM imports`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("replace_all left %d rows: %v", count, err)
	}
}

func TestCSVImportRejectsMoreThan1024Columns(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareImportDataset(t, a, "imports-db")
	user := persistedUser(t, a, "wide-importer", "data.write", "jobs.read")
	grantTable(t, a, user.ID, "imports-db", "imports", []string{"write"}, []string{"id", "segment", "note"}, nil)

	columns := make([]string, 1025)
	for index := range columns {
		columns[index] = fmt.Sprintf("column_%d", index)
	}
	job := createImportAndWait(t, a, user, "too-many-columns", app.ImportJobSpec{
		DatasetID: "imports-db",
		Table:     "imports",
		Mode:      "append",
		UploadID:  storeImportCSV(t, a, user.ID, strings.Join(columns, ",")+"\n"),
	})
	if job.State != "failed" || !strings.Contains(job.Error, "1024") {
		t.Fatalf("wide CSV did not fail at the documented column limit: state=%s error=%q", job.State, job.Error)
	}
}

func TestCSVImportRequiresGlobalPermissionAndEnforcesScopedGrant(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareImportDataset(t, a, "imports-db")

	withoutGlobal := persistedUser(t, a, "grant-only", "jobs.read")
	grantTable(t, a, withoutGlobal.ID, "imports-db", "imports", []string{"write"}, []string{"*"}, nil)
	controller := &app.JobsController{App: a}
	_, err := controller.CreateImportJob(userContext(t, withoutGlobal), &app.CreateImportJobReq{
		ImportJobSpec:  app.ImportJobSpec{DatasetID: "imports-db", Table: "imports", Mode: "append", UploadID: storeImportCSV(t, a, withoutGlobal.ID, "id,segment,note\n9,a,x\n")},
		IdempotencyKey: "global-permission-required",
	})
	requireAPIError(t, err, 403, "forbidden")

	scoped := persistedUser(t, a, "scoped", "data.write", "jobs.read")
	grantTable(t, a, scoped.ID, "imports-db", "imports", []string{"write"}, []string{"*"}, app.Filter{Field: "segment", Op: "eq", Value: "a"})
	job := createImportAndWait(t, a, scoped, "scoped-append-inside", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "append",
		UploadID: storeImportCSV(t, a, scoped.ID, "id,segment,note\n9,a,x\n"),
	})
	requireJobSucceeded(t, job)
	job = createImportAndWait(t, a, scoped, "scoped-append-outside", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "append",
		UploadID: storeImportCSV(t, a, scoped.ID, "id,segment,note\n10,b,outside\n"),
	})
	if job.State != "failed" || !strings.Contains(job.Error, "超出行权限") {
		t.Fatalf("out-of-scope append was not rejected: state=%s error=%q", job.State, job.Error)
	}

	// A scoped user cannot invoke a mode whose contract is full-table replacement.
	if _, err := a.DB.Exec(`UPDATE users SET permissions='["data.write","jobs.read","schema.manage"]' WHERE id=?`, scoped.ID); err != nil {
		t.Fatal(err)
	}
	scoped.Permissions = append(scoped.Permissions, "schema.manage")
	job = createImportAndWait(t, a, scoped, "scoped-replace", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "replace_all",
		UploadID: storeImportCSV(t, a, scoped.ID, "id,segment,note\n11,a,replacement\n"),
	})
	if job.State != "failed" || !strings.Contains(job.Error, "完整数据范围") {
		t.Fatalf("scoped replace_all was not rejected: state=%s error=%q", job.State, job.Error)
	}
	database, err := a.DatasetDB(testContext(t), "imports-db")
	if err != nil {
		t.Fatal(err)
	}
	var outside, inside int
	if err = database.DB.QueryRow(`SELECT count(*) FILTER (WHERE segment='b'), count(*) FILTER (WHERE segment='a') FROM imports`).Scan(&outside, &inside); err != nil {
		t.Fatal(err)
	}
	if outside != 1 || inside != 2 {
		t.Fatalf("scoped replace touched the wrong range: outside=%d inside=%d", outside, inside)
	}

	job = createImportAndWait(t, a, scoped, "scoped-merge-inside", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "merge", KeyFields: []string{"id"},
		UploadID: storeImportCSV(t, a, scoped.ID, "id,segment,note\n9,a,updated\n12,a,inserted\n"),
	})
	requireJobSucceeded(t, job)
	job = createImportAndWait(t, a, scoped, "scoped-merge-old-outside", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "merge", KeyFields: []string{"id"},
		UploadID: storeImportCSV(t, a, scoped.ID, "id,segment,note\n2,b,must-not-update\n"),
	})
	if job.State != "failed" {
		t.Fatalf("merge accessed an old row outside policy: state=%s error=%q", job.State, job.Error)
	}
	job = createImportAndWait(t, a, scoped, "scoped-merge-new-outside", app.ImportJobSpec{
		DatasetID: "imports-db", Table: "imports", Mode: "merge", KeyFields: []string{"id"},
		UploadID: storeImportCSV(t, a, scoped.ID, "id,segment,note\n13,b,must-not-insert\n"),
	})
	if job.State != "failed" || !strings.Contains(job.Error, "超出行权限") {
		t.Fatalf("merge inserted a row outside policy: state=%s error=%q", job.State, job.Error)
	}
}

func TestRecoverJobsUsesCommittedReceiptAndNeverReplaysUnknownImport(t *testing.T) {
	dir := runtimeTempDir(t)
	a := openTestApp(t, dir)
	prepareImportDataset(t, a, "imports-db")
	now := time.Now().UTC()
	payload := `{"import":{"datasetId":"imports-db","table":"imports","uploadId":"gone","mode":"append"}}`
	insert := func(id, state, fingerprint, key string) {
		t.Helper()
		_, err := a.DB.Exec(`INSERT INTO jobs(id,actor_id,kind,dataset_id,state,progress,fingerprint,idempotency_key,payload,result,error,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, "recover-user", "import", "imports-db", state, `{"phase":"running"}`, fingerprint, key, payload, nil, nil, now, now, now.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
	}
	insert("committed-job", "running", "receipt-fingerprint", "committed-key")
	insert("unknown-job", "queued", "missing-fingerprint", "missing-key")
	database, err := a.DatasetDB(testContext(t), "imports-db")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = database.DB.Exec(`INSERT INTO _rd_operations VALUES(?,?,?,?,?)`,
		"committed-key", "recover-user", "receipt-fingerprint", `{"insertedRows":1,"rolledBack":false}`, now); err != nil {
		t.Fatal(err)
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := app.Open(testContext(t), app.Config{DataDir: dir, AdminUsername: "admin", AdminPassword: testAdminPassword})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	for id, want := range map[string]string{"committed-job": "succeeded", "unknown-job": "failed"} {
		var got string
		if err = reopened.DB.QueryRow(`SELECT state FROM jobs WHERE id=?`, id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("recovered %s as %s, want %s", id, got, want)
		}
	}
	var rows int
	db, err := reopened.DatasetDB(testContext(t), "imports-db")
	if err != nil {
		t.Fatal(err)
	}
	if err = db.DB.QueryRow(`SELECT count(*) FROM imports`).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("recovery replayed an import: rows=%d err=%v", rows, err)
	}
}

func TestCancelImportEndsInAConsistentTerminalState(t *testing.T) {
	dir := runtimeTempDir(t)
	a, err := app.Open(testContext(t), app.Config{
		DataDir: dir, AdminUsername: "admin", AdminPassword: testAdminPassword,
		MaxConcurrentTasks: 1, TaskTimeout: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	prepareImportDataset(t, a, "imports-db")
	user := persistedUser(t, a, "cancel-user", "data.write", "jobs.read", "jobs.cancel")
	grantTable(t, a, user.ID, "imports-db", "imports", []string{"write"}, []string{"*"}, nil)
	var csv strings.Builder
	csv.WriteString("id,segment,note\n")
	for i := 1000; i < 6000; i++ {
		fmt.Fprintf(&csv, "%d,x,row-%d\n", i, i)
	}
	controller := &app.JobsController{App: a}
	ctx := userContext(t, user)
	created, err := controller.CreateImportJob(ctx, &app.CreateImportJobReq{
		ImportJobSpec:  app.ImportJobSpec{DatasetID: "imports-db", Table: "imports", Mode: "append", UploadID: storeImportCSV(t, a, user.ID, csv.String())},
		IdempotencyKey: "cancel-race",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = controller.CancelJob(ctx, &app.CancelJobReq{ID: created.JobID}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	var terminal app.Job
	for time.Now().Before(deadline) {
		got, readErr := controller.GetJob(ctx, &app.GetJobReq{ID: created.JobID})
		if readErr != nil {
			t.Fatal(readErr)
		}
		if got.State == "canceled" || got.State == "succeeded" || got.State == "failed" {
			terminal = got.Job
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if terminal.State == "" {
		t.Fatal("canceled import never reached a terminal state")
	}
	database, err := a.DatasetDB(context.Background(), "imports-db")
	if err != nil {
		t.Fatal(err)
	}
	var imported int
	if err = database.DB.QueryRow(`SELECT count(*) FROM imports WHERE id>=1000`).Scan(&imported); err != nil {
		t.Fatal(err)
	}
	switch terminal.State {
	case "canceled", "failed":
		if imported != 0 {
			t.Fatalf("%s import committed %d rows", terminal.State, imported)
		}
	case "succeeded":
		if imported != 5000 {
			t.Fatalf("succeeded import committed only %d rows", imported)
		}
	}
}

func TestBackupJobIsIdempotentAndProducesIndependentlyOpenableSnapshot(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareImportDataset(t, a, "imports-db")
	user := persistedUser(t, a, "backup-user", "datasets.manage", "jobs.read")
	ctx := userContext(t, user)
	if _, err := a.DB.ExecContext(ctx, `UPDATE data_files SET owner_id=? WHERE id=?`, user.ID, "imports-db"); err != nil {
		t.Fatal(err)
	}

	// Keep the source open and commit a change through the managed handle. The
	// backup must include this commit and remain readable through another handle.
	source, err := a.DatasetDB(ctx, "imports-db")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = source.DB.ExecContext(ctx, `INSERT INTO imports VALUES (9, 'snapshot', 'latest')`); err != nil {
		t.Fatal(err)
	}
	files := &app.FilesController{App: a}
	first, err := files.BackupDataFile(ctx, &app.BackupDataFileReq{ID: "imports-db", IdempotencyKey: "backup-once"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := files.BackupDataFile(ctx, &app.BackupDataFileReq{ID: "imports-db", IdempotencyKey: "backup-once"})
	if err != nil {
		t.Fatal(err)
	}
	if second.JobID != first.JobID {
		t.Fatalf("backup idempotency returned two jobs: %s != %s", first.JobID, second.JobID)
	}
	jobs := &app.JobsController{App: a}
	deadline := time.Now().Add(15 * time.Second)
	var job app.Job
	for time.Now().Before(deadline) {
		got, readErr := jobs.GetJob(ctx, &app.GetJobReq{ID: first.JobID})
		if readErr != nil {
			t.Fatal(readErr)
		}
		job = got.Job
		if job.State == "succeeded" || job.State == "failed" || job.State == "canceled" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	requireJobSucceeded(t, job)
	var result struct {
		DataFileID string `json:"dataFileId"`
		Name       string `json:"name"`
		Size       int64  `json:"size"`
	}
	if err = json.Unmarshal(job.Result, &result); err != nil || result.DataFileID == "" || result.Name == "" || result.Size <= 0 {
		t.Fatalf("invalid backup result: %s err=%v", job.Result, err)
	}
	var path, password, kind, sourceID string
	if err = a.DB.QueryRowContext(ctx, `SELECT path,password,kind,source_id FROM data_files WHERE id=?`, result.DataFileID).
		Scan(&path, &password, &kind, &sourceID); err != nil {
		t.Fatal(err)
	}
	if kind != "backup" || sourceID != "imports-db" {
		t.Fatalf("invalid backup record kind=%q source=%q", kind, sourceID)
	}
	snapshot, err := app.OpenEncrypted(ctx, path, password)
	if err != nil {
		t.Fatalf("open backup independently: %v", err)
	}
	defer snapshot.Close()
	var note string
	if err = snapshot.QueryRowContext(ctx, `SELECT note FROM imports WHERE id=9`).Scan(&note); err != nil || note != "latest" {
		t.Fatalf("backup omitted latest commit: note=%q err=%v", note, err)
	}
}

func TestDuckDBEncryptedCopyPrimitive(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareImportDataset(t, a, "copy-source")
	database, err := a.DatasetDB(testContext(t), "copy-source")
	if err != nil {
		t.Fatal(err)
	}
	snapshotsDir := filepath.Join(a.Config.DataDir, "databases", "snapshots")
	if err = os.MkdirAll(snapshotsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	destination := filepath.ToSlash(filepath.Join(snapshotsDir, "copy-probe.duckdb"))
	literal := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	alias := `"copy_probe"`
	database.Mu.Lock()
	defer database.Mu.Unlock()
	connection, err := database.DB.Conn(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	steps := []string{
		`ATTACH ` + literal(destination) + ` AS ` + alias + ` (TYPE DUCKDB, ENCRYPTION_KEY ` + literal("import-password-at-least-12") + `, STORAGE_VERSION 'latest')`,
		`COPY FROM DATABASE vault TO ` + alias,
		`CHECKPOINT ` + alias,
		`DETACH ` + alias,
	}
	for index, statement := range steps {
		if _, err = connection.ExecContext(testContext(t), statement); err != nil {
			t.Fatalf("encrypted database copy step %d failed (%s): %v", index+1, statement, err)
		}
	}
	copyDB, err := app.OpenEncrypted(testContext(t), filepath.FromSlash(destination), "import-password-at-least-12")
	if err != nil {
		t.Fatal(err)
	}
	defer copyDB.Close()
	var count int
	if err = copyDB.QueryRow(`SELECT count(*) FROM imports`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("encrypted copy is incomplete: rows=%d err=%v", count, err)
	}
}

func TestExportJobPreservesPolicyPrecisionAndCompletionDigest(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareBusinessDataset(t, a, "sales-db")
	user := persistedUser(t, a, "export-user", "data.read", "data.export", "jobs.read")
	grantTable(t, a, user.ID, "sales-db", "sales", []string{"read", "export"}, []string{"id", "region", "amount"}, app.Filter{Field: "region", Op: "eq", Value: "north"})
	controller := &app.JobsController{App: a}
	ctx := userContext(t, user)
	request := &app.CreateExportJobReq{
		ExportJobSpec:  app.ExportJobSpec{DatasetID: "sales-db", Table: "sales", Fields: []string{"id", "region", "amount"}},
		IdempotencyKey: "export-once",
	}
	created, err := controller.CreateExportJob(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := controller.CreateExportJob(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.JobID != created.JobID {
		t.Fatalf("export replay created a second job: %s != %s", replayed.JobID, created.JobID)
	}
	deadline := time.Now().Add(15 * time.Second)
	var job app.Job
	for time.Now().Before(deadline) {
		got, readErr := controller.GetJob(ctx, &app.GetJobReq{ID: created.JobID})
		if readErr != nil {
			t.Fatal(readErr)
		}
		job = got.Job
		if job.State == "succeeded" || job.State == "failed" || job.State == "canceled" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	requireJobSucceeded(t, job)
	if bytes.Contains(job.Result, []byte(`"path"`)) {
		t.Fatalf("public job result leaked a server path: %s", job.Result)
	}
	var raw string
	if err = a.DB.QueryRowContext(ctx, `SELECT result FROM jobs WHERE id=?`, job.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var artifact struct {
		Path      string `json:"path"`
		SHA256    string `json:"sha256"`
		TotalRows int64  `json:"totalRows"`
	}
	if err = json.Unmarshal([]byte(raw), &artifact); err != nil {
		t.Fatal(err)
	}
	if artifact.TotalRows != 1 || artifact.Path == "" || artifact.SHA256 == "" {
		t.Fatalf("invalid export artifact: %#v", artifact)
	}
	data, err := os.ReadFile(artifact.Path)
	if err != nil {
		t.Fatal(err)
	}
	trimmed := bytes.TrimSuffix(data, []byte("\n"))
	footerStart := bytes.LastIndexByte(trimmed, '\n') + 1
	var footer struct {
		Type      string `json:"type"`
		Complete  bool   `json:"complete"`
		TotalRows int64  `json:"totalRows"`
		SHA256    string `json:"sha256"`
	}
	if err = json.Unmarshal(trimmed[footerStart:], &footer); err != nil {
		t.Fatalf("invalid export footer: %v", err)
	}
	digest := sha256.Sum256(data[:footerStart])
	if footer.Type != "complete" || !footer.Complete || footer.TotalRows != 1 || footer.SHA256 != hex.EncodeToString(digest[:]) || artifact.SHA256 != footer.SHA256 {
		t.Fatalf("invalid export completion proof: artifact=%#v footer=%#v", artifact, footer)
	}
	if !bytes.Contains(data, []byte(`9007199254740993`)) || !bytes.Contains(data, []byte(`10.25`)) || bytes.Contains(data, []byte(`south-secret`)) || bytes.Contains(data, []byte(`9007199254740994`)) {
		t.Fatalf("export lost precision or bypassed row policy: %s", data)
	}

	conflict := *request
	conflict.Fields = []string{"id"}
	_, err = controller.CreateExportJob(ctx, &conflict)
	requireAPIError(t, err, 409, "idempotency_key_reused")
}
