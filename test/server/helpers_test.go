package server_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"server/app"
)

const testAdminPassword = "test-password-at-least-12"

func runtimeTempDir(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "runtime"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(root, "server-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	// Encrypted fixture startup can be slow under host I/O contention; application query limits remain unchanged.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

func openTestApp(t *testing.T, dataDir string) *app.App {
	t.Helper()
	a, err := app.Open(testContext(t), app.Config{
		DataDir:       dataDir,
		AdminUsername: "admin",
		AdminPassword: testAdminPassword,
		CookieSecure:  false,
	})
	if err != nil {
		t.Fatalf("open app: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func requireAPIError(t *testing.T, err error, status int, code string) {
	t.Helper()
	var apiErr *app.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected API error %d/%s, got %T: %v", status, code, err, err)
	}
	if apiErr.Status != status || apiErr.Code != code {
		t.Fatalf("expected API error %d/%s, got %d/%s", status, code, apiErr.Status, apiErr.Code)
	}
}

func userContext(t *testing.T, user *app.User) context.Context {
	t.Helper()
	return app.WithUser(testContext(t), user)
}
