package server_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"server/app"
)

func TestSystemDatabaseUsesDuckDB2EncryptionAndPersists(t *testing.T) {
	dir := runtimeTempDir(t)
	ctx := testContext(t)
	a, err := app.Open(ctx, app.Config{
		DataDir:       dir,
		AdminUsername: "admin",
		AdminPassword: testAdminPassword,
		CookieSecure:  false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(a.EngineVersion, "v2.") {
		t.Fatalf("expected DuckDB 2.x, got %q", a.EngineVersion)
	}
	if a.InstanceID == "" {
		t.Fatal("instance ID is empty")
	}
	firstInstanceID := a.InstanceID

	var encrypted bool
	var cipher string
	if err = a.DB.QueryRowContext(ctx,
		`SELECT encrypted, cipher FROM duckdb_databases() WHERE database_name = current_database()`,
	).Scan(&encrypted, &cipher); err != nil {
		t.Fatal(err)
	}
	if !encrypted || !strings.EqualFold(cipher, "GCM") {
		t.Fatalf("expected encrypted GCM database, got encrypted=%v cipher=%q", encrypted, cipher)
	}
	if _, err = a.DB.ExecContext(ctx, `INSERT INTO metadata VALUES ('restart_marker','kept')`); err != nil {
		t.Fatal(err)
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := app.Open(ctx, app.Config{
		DataDir:       dir,
		AdminUsername: "admin",
		AdminPassword: testAdminPassword,
		CookieSecure:  false,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.InstanceID != firstInstanceID {
		t.Fatalf("instance ID changed across restart: %q != %q", reopened.InstanceID, firstInstanceID)
	}
	var marker string
	if err = reopened.DB.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key='restart_marker'`).Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if marker != "kept" {
		t.Fatalf("restart marker changed: %q", marker)
	}
}

func TestOpenEncryptedRejectsWrongPassword(t *testing.T) {
	dir := runtimeTempDir(t)
	path := filepath.Join(dir, "wrong-password.duckdb")
	ctx := testContext(t)
	db, err := app.OpenEncrypted(ctx, path, "correct-password-at-least-12")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `CREATE TABLE proof(id INTEGER); INSERT INTO proof VALUES (1)`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = app.OpenEncrypted(ctx, path, "incorrect-password-at-least-12"); err == nil {
		t.Fatal("encrypted database opened with the wrong password")
	}

	reopened, err := app.OpenEncrypted(ctx, path, "correct-password-at-least-12")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var count int
	if err = reopened.QueryRowContext(ctx, `SELECT count(*) FROM proof`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected persisted row, got %d", count)
	}
}

func TestOpenRefusesMissingStartupState(t *testing.T) {
	t.Run("empty credential", func(t *testing.T) {
		dir := runtimeTempDir(t)
		a := openTestApp(t, dir)
		if err := a.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "startup.credential"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := app.Open(testContext(t), app.Config{DataDir: dir, AdminPassword: testAdminPassword}); err == nil {
			t.Fatal("startup succeeded with an empty boot credential")
		}
	})

	t.Run("missing credential", func(t *testing.T) {
		dir := runtimeTempDir(t)
		a := openTestApp(t, dir)
		if err := a.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(dir, "startup.credential")); err != nil {
			t.Fatal(err)
		}
		if _, err := app.Open(testContext(t), app.Config{DataDir: dir, AdminPassword: testAdminPassword}); err == nil {
			t.Fatal("startup succeeded without the boot credential")
		}
	})

	t.Run("missing database", func(t *testing.T) {
		dir := runtimeTempDir(t)
		a := openTestApp(t, dir)
		if err := a.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(dir, "system.duckdb")); err != nil {
			t.Fatal(err)
		}
		if _, err := app.Open(testContext(t), app.Config{DataDir: dir, AdminPassword: testAdminPassword}); err == nil {
			t.Fatal("startup succeeded without the initialized system database")
		}
	})

	t.Run("corrupt credential", func(t *testing.T) {
		dir := runtimeTempDir(t)
		a := openTestApp(t, dir)
		if err := a.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "startup.credential"), []byte("corrupt"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := app.Open(testContext(t), app.Config{DataDir: dir, AdminPassword: testAdminPassword}); err == nil {
			t.Fatal("startup succeeded with a corrupt boot credential")
		}
	})
}

func TestInitialPasswordRejectsEmptyCredential(t *testing.T) {
	dir := runtimeTempDir(t)
	a, err := app.Open(testContext(t), app.Config{
		DataDir:       dir,
		AdminUsername: "admin",
		CookieSecure:  false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	credential := filepath.Join(dir, "admin.credential")
	password, err := app.InitialPassword(dir)
	if err != nil || len(password) < 12 {
		t.Fatalf("read generated initial password: length=%d err=%v", len(password), err)
	}
	if err = os.WriteFile(credential, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if password, err = app.InitialPassword(dir); err == nil || password != "" {
		t.Fatalf("empty admin credential returned password=%q err=%v", password, err)
	}
}

func TestConcurrentStartupAllowsOneInstance(t *testing.T) {
	dir := runtimeTempDir(t)
	const attempts = 6
	start := make(chan struct{})
	results := make(chan *app.App, attempts)
	errorsFound := make(chan error, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			a, err := app.Open(context.Background(), app.Config{
				DataDir:       dir,
				AdminUsername: "admin",
				AdminPassword: testAdminPassword,
				CookieSecure:  false,
			})
			if err != nil {
				errorsFound <- err
				return
			}
			results <- a
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errorsFound)

	var opened []*app.App
	for a := range results {
		opened = append(opened, a)
	}
	for _, a := range opened {
		_ = a.Close()
	}
	if len(opened) != 1 {
		t.Fatalf("expected exactly one successful startup, got %d", len(opened))
	}
	if got := len(errorsFound); got != attempts-1 {
		t.Fatalf("expected %d lock failures, got %d", attempts-1, got)
	}
}
