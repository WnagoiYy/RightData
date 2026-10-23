package server_test

import (
	"testing"

	"server/app"
)

func TestDataFilesAreOwnerScopedAndDataReadDoesNotRevealFiles(t *testing.T) {
	a := openTestApp(t, runtimeTempDir(t))
	prepareImportDataset(t, a, "alice-db")
	prepareImportDataset(t, a, "bob-db")
	alice := persistedUser(t, a, "alice", "datasets.manage", "datasets.password", "datasets.download", "jobs.read")
	bob := persistedUser(t, a, "bob", "datasets.manage", "datasets.password", "datasets.download", "jobs.read")
	if _, err := a.DB.Exec(`UPDATE data_files SET owner_id=? WHERE id=?`, alice.ID, "alice-db"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Exec(`UPDATE data_files SET owner_id=? WHERE id=?`, bob.ID, "bob-db"); err != nil {
		t.Fatal(err)
	}
	files := &app.FilesController{App: a}
	aliceCtx := userContext(t, alice)
	listed, err := files.ListDataFiles(aliceCtx, &app.ListDataFilesReq{})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 1 || listed.Items[0].ID != "alice-db" {
		t.Fatalf("Alice can enumerate another owner's data files: %#v", listed.Items)
	}
	if _, err = files.DataFilePassword(aliceCtx, &app.DataFilePasswordReq{ID: "bob-db"}); err == nil {
		t.Fatal("Alice retrieved Bob's database password")
	} else {
		requireAPIError(t, err, 403, "forbidden")
	}
	if _, err = files.BackupDataFile(aliceCtx, &app.BackupDataFileReq{ID: "bob-db", IdempotencyKey: "foreign-backup"}); err == nil {
		t.Fatal("Alice submitted a backup of Bob's database")
	} else {
		requireAPIError(t, err, 403, "forbidden")
	}
	aliceConnection, err := files.CreateConnection(aliceCtx, &app.CreateConnectionReq{FileID: "alice-db", Name: "Alice connection"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = files.CreateConnection(aliceCtx, &app.CreateConnectionReq{FileID: "bob-db", Name: "Foreign connection"}); err == nil {
		t.Fatal("Alice registered Bob's database as her connection")
	} else {
		requireAPIError(t, err, 403, "forbidden")
	}
	bobConnection, err := files.CreateConnection(userContext(t, bob), &app.CreateConnectionReq{FileID: "bob-db", Name: "Bob connection"})
	if err != nil {
		t.Fatal(err)
	}
	connections, err := files.ListConnections(aliceCtx, &app.ListConnectionsReq{})
	if err != nil {
		t.Fatal(err)
	}
	if len(connections.Items) != 1 || connections.Items[0].ID != aliceConnection.ID {
		t.Fatalf("Alice can enumerate Bob's connections: %#v", connections.Items)
	}
	if _, err = files.UpdateConnection(aliceCtx, &app.UpdateConnectionReq{ID: bobConnection.ID, Name: "stolen"}); err == nil {
		t.Fatal("Alice renamed Bob's connection")
	} else {
		requireAPIError(t, err, 403, "forbidden")
	}
	if _, err = files.DeleteConnection(aliceCtx, &app.DeleteConnectionReq{ID: bobConnection.ID}); err == nil {
		t.Fatal("Alice deleted Bob's connection")
	} else {
		requireAPIError(t, err, 403, "forbidden")
	}
	updated, err := files.UpdateConnection(aliceCtx, &app.UpdateConnectionReq{ID: aliceConnection.ID, Name: "Alice renamed"})
	if err != nil || updated.Name != "Alice renamed" {
		t.Fatalf("Alice could not rename her connection: %#v err=%v", updated, err)
	}
	if _, err = files.DeleteConnection(aliceCtx, &app.DeleteConnectionReq{ID: aliceConnection.ID}); err != nil {
		t.Fatalf("Alice could not delete her connection: %v", err)
	}

	reader := persistedUser(t, a, "plain-reader", "data.read")
	readerCtx := userContext(t, reader)
	if _, err = files.DataFilePassword(readerCtx, &app.DataFilePasswordReq{ID: "alice-db"}); err == nil {
		t.Fatal("data.read implied datasets.password")
	} else {
		requireAPIError(t, err, 403, "forbidden")
	}
	if _, err = files.DownloadDataFile(readerCtx, &app.DownloadDataFileReq{ID: "alice-db"}); err == nil {
		t.Fatal("data.read implied datasets.download")
	} else {
		requireAPIError(t, err, 403, "forbidden")
	}
}
