package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const importCSVMediaType = "application/vnd.rightdata.import+csv"

var managedDatabaseName = regexp.MustCompile(`^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.duckdb$`)
var safeUploadedDefault = regexp.MustCompile(`(?is)^(NULL|TRUE|FALSE|[+-]?[0-9]+(?:\.[0-9]+)?|'(?:[^']|'')*')$`)

type DataFile struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Kind        string           `json:"kind"`
	SourceID    string           `json:"sourceId,omitempty"`
	OwnerID     string           `json:"ownerId"`
	Size        int64            `json:"size"`
	HasPassword bool             `json:"hasPassword"`
	CreatedAt   time.Time        `json:"createdAt"`
	Connections []FileConnection `json:"connections"`
}

type FileConnection struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	FileID    string    `json:"fileId,omitempty"`
	OwnerID   string    `json:"ownerId,omitempty"`
	CreatedAt time.Time `json:"createdAt,omitempty"`
}

type StoredFile struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"ownerId"`
	Size      int64     `json:"size"`
	SHA256    string    `json:"sha256"`
	MediaType string    `json:"mediaType"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type dataFileRecord struct {
	DataFile
	Path     string
	Password string
}

type storedFileRecord struct {
	StoredFile
	Path string
}

func (a *App) dataFilesDir() string { return filepath.Join(a.Config.DataDir, "databases") }
func (a *App) snapshotsDir() string { return filepath.Join(a.dataFilesDir(), "snapshots") }
func (a *App) filesDir() string     { return filepath.Join(a.Config.DataDir, "files") }
func (a *App) resultsDir() string   { return filepath.Join(a.Config.DataDir, "results") }

func pathWithin(root, path string) bool {
	rootAbs, rootErr := filepath.Abs(root)
	pathAbs, pathErr := filepath.Abs(path)
	if rootErr != nil || pathErr != nil {
		return false
	}
	rel, err := filepath.Rel(rootAbs, pathAbs)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func ensurePrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700)
}

func randomDatabasePassword() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func validateDatabaseName(name string) error {
	if !managedDatabaseName.MatchString(name) || strings.Contains(name, "..") {
		return Error(400, "invalid_file_name", "数据库文件名必须以 .duckdb 结尾且不能包含目录")
	}
	for _, reserved := range []string{"system.duckdb", "memory.duckdb", "temp.duckdb"} {
		if strings.EqualFold(name, reserved) {
			return Error(400, "reserved_file_name", "该数据库文件名不可使用")
		}
	}
	return nil
}

func (a *App) createDataFile(ctx context.Context, ownerID, name, password string) (DataFile, error) {
	if err := validateDatabaseName(name); err != nil {
		return DataFile{}, err
	}
	if password == "" {
		var err error
		password, err = randomDatabasePassword()
		if err != nil {
			return DataFile{}, Error(500, "password_generation_failed", "无法生成数据库密码")
		}
	}
	if len(password) < 12 || len(password) > 1024 {
		return DataFile{}, Error(400, "invalid_password", "数据库密码长度必须为 12 至 1024 个字符")
	}
	if err := ensurePrivateDir(a.dataFilesDir()); err != nil {
		return DataFile{}, Error(500, "storage_unavailable", "数据库存储不可用")
	}
	id := NewID()
	path := filepath.Join(a.dataFilesDir(), id+".duckdb")
	db, err := OpenEncrypted(ctx, path, password)
	if err != nil {
		return DataFile{}, Error(422, "database_create_failed", "无法创建加密数据库")
	}
	if _, err = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS _rd_operations(key VARCHAR PRIMARY KEY, actor VARCHAR NOT NULL, fingerprint VARCHAR NOT NULL, result VARCHAR NOT NULL, created_at TIMESTAMPTZ NOT NULL)`); err == nil {
		_, err = db.ExecContext(ctx, `CHECKPOINT`)
	}
	closeErr := db.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(path)
		return DataFile{}, Error(422, "database_create_failed", "无法初始化加密数据库")
	}
	now := time.Now().UTC()
	if _, err = a.DB.ExecContext(ctx, `INSERT INTO data_files(id,name,kind,source_id,path,password,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?)`, id, name, "business", "", path, password, ownerID, now); err != nil {
		_ = os.Remove(path)
		return DataFile{}, err
	}
	info, _ := os.Stat(path)
	item := DataFile{ID: id, Name: name, Kind: "business", OwnerID: ownerID, HasPassword: true, CreatedAt: now, Connections: []FileConnection{}}
	if info != nil {
		item.Size = info.Size()
	}
	return item, nil
}

func copyUploadToTemp(file *multipart.FileHeader, dir, suffix string, max int64) (string, int64, string, error) {
	if file == nil || file.Size <= 0 {
		return "", 0, "", Error(400, "empty_upload", "上传文件为空")
	}
	if max > 0 && file.Size > max {
		return "", 0, "", Error(413, "upload_too_large", "上传文件超过大小限制")
	}
	if err := ensurePrivateDir(dir); err != nil {
		return "", 0, "", Error(500, "storage_unavailable", "文件存储不可用")
	}
	source, err := file.Open()
	if err != nil {
		return "", 0, "", Error(400, "upload_read_failed", "无法读取上传文件")
	}
	defer source.Close()
	temp, err := os.CreateTemp(dir, ".upload-*"+suffix)
	if err != nil {
		return "", 0, "", Error(500, "storage_unavailable", "文件存储不可用")
	}
	path := temp.Name()
	complete := false
	defer func() {
		_ = temp.Close()
		if !complete {
			_ = os.Remove(path)
		}
	}()
	hash := sha256.New()
	reader := io.Reader(source)
	if max > 0 {
		reader = io.LimitReader(source, max+1)
	}
	written, err := io.Copy(io.MultiWriter(temp, hash), reader)
	if err == nil && max > 0 && written > max {
		err = Error(413, "upload_too_large", "上传文件超过大小限制")
	}
	if err == nil {
		err = temp.Sync()
	}
	if err == nil {
		err = temp.Close()
	}
	if err != nil {
		return "", 0, "", err
	}
	complete = true
	return path, written, hex.EncodeToString(hash.Sum(nil)), nil
}

func (a *App) registerUploadedDatabase(ctx context.Context, ownerID, name, password string, file *multipart.FileHeader) (DataFile, error) {
	if err := validateDatabaseName(name); err != nil {
		return DataFile{}, err
	}
	if password == "" {
		return DataFile{}, Error(400, "password_required", "必须提供数据库密码")
	}
	temp, _, _, err := copyUploadToTemp(file, a.dataFilesDir(), ".duckdb", a.Config.MaxUploadBytes)
	if err != nil {
		return DataFile{}, err
	}
	defer os.Remove(temp)
	db, err := OpenEncrypted(ctx, temp, password)
	if err != nil {
		return DataFile{}, Error(422, "invalid_database", "数据库文件或密码无效")
	}
	var one int
	err = db.QueryRowContext(ctx, `SELECT 1`).Scan(&one)
	if err == nil {
		err = validateUploadedDatabase(ctx, db)
	}
	if err == nil {
		_, err = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS _rd_operations(key VARCHAR PRIMARY KEY, actor VARCHAR NOT NULL, fingerprint VARCHAR NOT NULL, result VARCHAR NOT NULL, created_at TIMESTAMPTZ NOT NULL)`)
	}
	if err == nil {
		_, err = db.ExecContext(ctx, `CHECKPOINT`)
	}
	closeErr := db.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil || one != 1 {
		return DataFile{}, Error(422, "invalid_database", "数据库文件或密码无效")
	}
	id := NewID()
	path := filepath.Join(a.dataFilesDir(), id+".duckdb")
	if err = os.Rename(temp, path); err != nil {
		return DataFile{}, Error(500, "storage_unavailable", "无法保存数据库文件")
	}
	now := time.Now().UTC()
	if _, err = a.DB.ExecContext(ctx, `INSERT INTO data_files(id,name,kind,source_id,path,password,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?)`, id, name, "business", "", path, password, ownerID, now); err != nil {
		_ = os.Remove(path)
		return DataFile{}, err
	}
	info, _ := os.Stat(path)
	item := DataFile{ID: id, Name: name, Kind: "business", OwnerID: ownerID, HasPassword: true, CreatedAt: now, Connections: []FileConnection{}}
	if info != nil {
		item.Size = info.Size()
	}
	return item, nil
}

func validateUploadedDatabase(ctx context.Context, db *sql.DB) error {
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.tables WHERE table_catalog=current_database() AND table_schema='main' AND table_type<>'BASE TABLE'`).Scan(&count); err != nil || count != 0 {
		return Error(422, "unsafe_database_schema", "上传数据库包含不支持的视图或表类型")
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM duckdb_functions() WHERE database_name=current_database() AND function_type IN ('macro','table_macro')`).Scan(&count); err != nil || count != 0 {
		return Error(422, "unsafe_database_schema", "上传数据库包含不支持的自定义宏")
	}
	rows, err := db.QueryContext(ctx, `SELECT column_default FROM information_schema.columns WHERE table_catalog=current_database() AND table_schema='main' AND column_default IS NOT NULL`)
	if err != nil {
		return Error(422, "unsafe_database_schema", "无法验证上传数据库字段默认值")
	}
	defer rows.Close()
	for rows.Next() {
		var value string
		if rows.Scan(&value) != nil || !safeUploadedDefault.MatchString(strings.TrimSpace(value)) {
			return Error(422, "unsafe_database_schema", "上传数据库包含不支持的字段默认表达式")
		}
	}
	if err = rows.Err(); err != nil {
		return Error(422, "unsafe_database_schema", "无法验证上传数据库字段默认值")
	}
	return nil
}

func (a *App) dataFile(ctx context.Context, id string) (dataFileRecord, error) {
	var item dataFileRecord
	var source sql.NullString
	err := a.DB.QueryRowContext(ctx, `SELECT id,name,kind,source_id,path,password,owner_id,created_at FROM data_files WHERE id=?`, id).
		Scan(&item.ID, &item.Name, &item.Kind, &source, &item.Path, &item.Password, &item.OwnerID, &item.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return item, Error(404, "data_file_not_found", "数据库文件不存在")
	}
	if err != nil {
		return item, err
	}
	if source.Valid {
		item.SourceID = source.String
	}
	validPath := pathWithin(a.dataFilesDir(), item.Path)
	if item.Kind == "system" {
		expected, _ := filepath.Abs(filepath.Join(a.Config.DataDir, "system.duckdb"))
		actual, _ := filepath.Abs(item.Path)
		validPath = expected == actual
	}
	if !validPath {
		return item, Error(409, "invalid_storage_record", "数据库文件登记路径无效")
	}
	item.HasPassword = item.Password != ""
	item.Connections = []FileConnection{}
	rows, err := a.DB.QueryContext(ctx, `SELECT id,name FROM connections WHERE file_id=? ORDER BY created_at,id`, id)
	if err != nil {
		return item, err
	}
	defer rows.Close()
	for rows.Next() {
		var c FileConnection
		if err = rows.Scan(&c.ID, &c.Name); err != nil {
			return item, err
		}
		item.Connections = append(item.Connections, c)
	}
	if err = rows.Err(); err != nil {
		return item, err
	}
	if info, statErr := os.Stat(item.Path); statErr == nil {
		item.Size = info.Size()
	}
	return item, nil
}

func (a *App) listDataFiles(ctx context.Context, user *User) ([]DataFile, error) {
	query := `SELECT id FROM data_files`
	args := []any{}
	if !HasPermission(user, "system.manage") {
		query += ` WHERE owner_id=? AND kind <> 'system' AND NOT (kind='backup' AND source_id='system')`
		args = append(args, user.ID)
	}
	query += ` ORDER BY created_at DESC,id`
	rows, err := a.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	items := make([]DataFile, 0, len(ids))
	for _, id := range ids {
		item, readErr := a.dataFile(ctx, id)
		if readErr != nil {
			return nil, readErr
		}
		items = append(items, item.DataFile)
	}
	return items, nil
}

func (a *App) registerConnection(ctx context.Context, user *User, fileID, name string) (FileConnection, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 128 {
		return FileConnection{}, Error(400, "invalid_connection_name", "连接名称不能为空且不能超过 128 个字符")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return FileConnection{}, Error(503, "unavailable", "服务正在停止")
	}
	item, err := a.dataFile(ctx, fileID)
	if err != nil {
		return FileConnection{}, err
	}
	if item.Kind != "business" {
		return FileConnection{}, Error(409, "file_not_connectable", "该数据库文件不能登记为业务连接")
	}
	if item.OwnerID != user.ID && !HasPermission(user, "system.manage") {
		return FileConnection{}, Error(403, "forbidden", "不能使用其他用户的数据库文件")
	}
	result := FileConnection{ID: NewID(), Name: name, FileID: fileID, OwnerID: user.ID, CreatedAt: time.Now().UTC()}
	_, err = a.DB.ExecContext(ctx, `INSERT INTO connections(id,name,file_id,owner_id,created_at) VALUES(?,?,?,?,?)`, result.ID, result.Name, fileID, user.ID, result.CreatedAt)
	if err != nil {
		return FileConnection{}, err
	}
	return result, nil
}

func (a *App) connection(ctx context.Context, id string) (FileConnection, error) {
	var item FileConnection
	err := a.DB.QueryRowContext(ctx, `SELECT id,name,file_id,owner_id,created_at FROM connections WHERE id=?`, id).Scan(&item.ID, &item.Name, &item.FileID, &item.OwnerID, &item.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return item, Error(404, "connection_not_found", "数据库连接不存在")
	}
	return item, err
}

func (a *App) listConnections(ctx context.Context, user *User) ([]FileConnection, error) {
	query := `SELECT id,name,file_id,owner_id,created_at FROM connections WHERE owner_id=? ORDER BY created_at DESC,id`
	args := []any{user.ID}
	if HasPermission(user, "system.manage") {
		query = `SELECT id,name,file_id,owner_id,created_at FROM connections ORDER BY created_at DESC,id`
		args = nil
	}
	rows, err := a.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []FileConnection{}
	for rows.Next() {
		var item FileConnection
		if err = rows.Scan(&item.ID, &item.Name, &item.FileID, &item.OwnerID, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (a *App) renameConnection(ctx context.Context, user *User, id, name string) (FileConnection, error) {
	item, err := a.connection(ctx, id)
	if err != nil {
		return item, err
	}
	if item.OwnerID != user.ID && !HasPermission(user, "system.manage") {
		return item, Error(403, "forbidden", "不能修改其他用户的数据库连接")
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 128 {
		return item, Error(400, "invalid_connection_name", "连接名称不能为空且不能超过 128 个字符")
	}
	if _, err = a.DB.ExecContext(ctx, `UPDATE connections SET name=? WHERE id=?`, name, id); err != nil {
		return item, err
	}
	item.Name = name
	return item, nil
}

func (a *App) deleteConnection(ctx context.Context, user *User, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return Error(503, "unavailable", "服务正在停止")
	}
	item, err := a.connection(ctx, id)
	if err != nil {
		return err
	}
	if item.OwnerID != user.ID && !HasPermission(user, "system.manage") {
		return Error(403, "forbidden", "不能删除其他用户的数据库连接")
	}
	_, err = a.DB.ExecContext(ctx, `DELETE FROM connections WHERE id=?`, id)
	return err
}

// copyEncryptedDatabase uses DuckDB's database copy command so the destination
// is a transactionally consistent, independently openable encrypted database.
// The caller serializes access to sourceDB when it is a business dataset.
func copyEncryptedDatabase(ctx context.Context, sourceDB *sql.DB, destination, password, id string) error {
	alias := "_rd_backup_" + id
	connection, err := sourceDB.Conn(ctx)
	if err != nil {
		return err
	}
	attached := false
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if attached {
			_, _ = connection.ExecContext(cleanupCtx, `DETACH `+jobQuote(alias))
		}
		_ = connection.Close()
	}()
	allowedPath := filepath.ToSlash(destination)
	attachSQL := `ATTACH ` + sqlLiteral(allowedPath) + ` AS ` + jobQuote(alias) + ` (TYPE DUCKDB, ENCRYPTION_KEY ` + sqlLiteral(password) + `, STORAGE_VERSION 'latest')`
	if _, err = connection.ExecContext(ctx, attachSQL); err != nil {
		return err
	}
	attached = true
	if _, err = connection.ExecContext(ctx, `COPY FROM DATABASE vault TO `+jobQuote(alias)); err != nil {
		return err
	}
	if _, err = connection.ExecContext(ctx, `CHECKPOINT `+jobQuote(alias)); err != nil {
		return err
	}
	if _, err = connection.ExecContext(ctx, `DETACH `+jobQuote(alias)); err != nil {
		return err
	}
	attached = false
	return nil
}

func (a *App) createBackup(ctx context.Context, user *User, sourceID string) (DataFile, error) {
	return a.createBackupWithID(ctx, user, sourceID, NewID())
}

func (a *App) createBackupWithID(ctx context.Context, user *User, sourceID, id string) (DataFile, error) {
	source, err := a.dataFile(ctx, sourceID)
	if err != nil {
		return DataFile{}, err
	}
	if !canAccessDataFile(user, source) {
		return DataFile{}, Error(403, "forbidden", "不能备份其他用户的数据库文件")
	}
	if source.Kind == "backup" {
		return DataFile{}, Error(409, "backup_source_invalid", "备份文件不能再次生成备份")
	}
	if err = requireRegularFile(source.Path); err != nil {
		return DataFile{}, Error(409, "file_missing", "数据库文件不可用")
	}
	if err = ensurePrivateDir(a.snapshotsDir()); err != nil {
		return DataFile{}, Error(500, "storage_unavailable", "数据库存储不可用")
	}
	path := filepath.Join(a.snapshotsDir(), id+".duckdb")
	if source.Kind == "system" {
		if err = copyEncryptedDatabase(ctx, a.DB, path, source.Password, id); err != nil {
			_ = os.Remove(path)
			return DataFile{}, Error(422, "backup_failed", "无法生成一致系统数据库快照")
		}
	}
	// Every business file is backed by a managed handle. Holding its mutex while
	// checkpointing and copying keeps the encrypted file and WAL at one commit.
	var database *Database
	if source.Kind != "system" {
		database, err = a.DatasetDB(ctx, source.ID)
	}
	if source.Kind == "system" {
		err = nil
	} else if err == nil {
		database.Mu.Lock()
		defer database.Mu.Unlock()
		err = copyEncryptedDatabase(ctx, database.DB, path, source.Password, id)
	}
	if err != nil {
		_ = os.Remove(path)
		return DataFile{}, Error(422, "backup_failed", "无法生成一致数据库快照")
	}
	// Verify the copied encrypted file before publishing its record.
	check, err := OpenEncrypted(ctx, path, source.Password)
	if err == nil {
		var one int
		err = check.QueryRowContext(ctx, `SELECT 1`).Scan(&one)
		closeErr := check.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		_ = os.Remove(path)
		return DataFile{}, Error(422, "backup_failed", "数据库快照校验失败")
	}
	now := time.Now().UTC()
	name := strings.TrimSuffix(source.Name, ".duckdb") + "-" + now.Format("20060102-150405") + ".duckdb"
	if _, err = a.DB.ExecContext(ctx, `INSERT INTO data_files(id,name,kind,source_id,path,password,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?)`, id, name, "backup", source.ID, path, source.Password, user.ID, now); err != nil {
		_ = os.Remove(path)
		return DataFile{}, err
	}
	info, _ := os.Stat(path)
	item := DataFile{ID: id, Name: name, Kind: "backup", SourceID: source.ID, OwnerID: user.ID, HasPassword: true, CreatedAt: now, Connections: []FileConnection{}}
	if info != nil {
		item.Size = info.Size()
	}
	return item, nil
}

func (a *App) deleteDataFile(ctx context.Context, user *User, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return Error(503, "unavailable", "服务正在停止")
	}
	item, err := a.dataFile(ctx, id)
	if err != nil {
		return err
	}
	if item.Kind == "system" {
		return Error(409, "system_file_protected", "系统数据库不能删除")
	}
	if item.Kind == "backup" && item.SourceID == "system" && !HasPermission(user, "system.manage") {
		return Error(403, "forbidden", "系统数据库备份需要系统管理权限")
	}
	if item.OwnerID != user.ID && !HasPermission(user, "system.manage") {
		return Error(403, "forbidden", "不能删除其他用户的数据库文件")
	}
	if len(item.Connections) > 0 {
		return Error(409, "file_in_use", "数据库文件仍被连接引用")
	}
	var managed *Database
	if item.Kind == "business" {
		managed = a.handles[id]
		if managed != nil {
			if !managed.Mu.TryLock() {
				return Error(409, "file_in_use", "数据库文件正在使用")
			}
			defer managed.Mu.Unlock()
			if err = managed.DB.Close(); err != nil {
				return Error(409, "file_in_use", "数据库文件暂时无法关闭")
			}
			delete(a.handles, id)
		}
	}
	restoreHandle := func() {
		if managed == nil {
			return
		}
		restoreCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		if reopened, openErr := openEncrypted(restoreCtx, item.Path, item.Password, a.snapshotsDir()); openErr == nil {
			managed.DB = reopened
			a.handles[id] = managed
		}
	}
	pending := item.Path + ".deleting-" + NewID()
	if err = os.Rename(item.Path, pending); err != nil {
		restoreHandle()
		if errors.Is(err, os.ErrNotExist) {
			return Error(409, "file_missing", "数据库文件缺失，未删除登记")
		}
		return Error(500, "storage_unavailable", "数据库文件暂时不可删除")
	}
	if _, err = a.DB.ExecContext(ctx, `DELETE FROM data_files WHERE id=? AND kind<>'system'`, id); err != nil {
		_ = os.Rename(pending, item.Path)
		restoreHandle()
		return err
	}
	return os.Remove(pending)
}

func (a *App) storeFile(ctx context.Context, ownerID, name, mediaType string, upload *multipart.FileHeader) (StoredFile, error) {
	name = strings.TrimSpace(filepath.Base(name))
	if name == "." || name == "" || len(name) > 255 {
		return StoredFile{}, Error(400, "invalid_file_name", "文件名无效")
	}
	id := NewID()
	temp, size, sum, err := copyUploadToTemp(upload, a.filesDir(), ".bin", a.Config.MaxUploadBytes)
	if err != nil {
		return StoredFile{}, err
	}
	defer os.Remove(temp)
	path := filepath.Join(a.filesDir(), id+".bin")
	if err = os.Rename(temp, path); err != nil {
		return StoredFile{}, Error(500, "storage_unavailable", "无法保存上传文件")
	}
	now := time.Now().UTC()
	item := StoredFile{ID: id, Name: name, OwnerID: ownerID, Size: size, SHA256: sum, MediaType: mediaType, CreatedAt: now, UpdatedAt: now}
	if _, err = a.DB.ExecContext(ctx, `INSERT INTO files(id,name,path,owner_id,size,sha256,media_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, name, path, ownerID, size, sum, mediaType, now, now); err != nil {
		_ = os.Remove(path)
		return StoredFile{}, err
	}
	return item, nil
}

func (a *App) storedFile(ctx context.Context, id string) (storedFileRecord, error) {
	var item storedFileRecord
	err := a.DB.QueryRowContext(ctx, `SELECT id,name,path,owner_id,size,sha256,media_type,created_at,updated_at FROM files WHERE id=?`, id).
		Scan(&item.ID, &item.Name, &item.Path, &item.OwnerID, &item.Size, &item.SHA256, &item.MediaType, &item.CreatedAt, &item.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return item, Error(404, "file_not_found", "文件不存在")
	}
	if err == nil && !pathWithin(a.filesDir(), item.Path) {
		return item, Error(409, "invalid_storage_record", "文件登记路径无效")
	}
	return item, err
}

func canAccessOwnedFile(user *User, ownerID string) bool {
	return user != nil && (user.ID == ownerID || HasPermission(user, "system.manage"))
}

func canAccessDataFile(user *User, item dataFileRecord) bool {
	if user == nil {
		return false
	}
	if HasPermission(user, "system.manage") {
		return true
	}
	if item.Kind == "system" || item.Kind == "backup" && item.SourceID == "system" {
		return false
	}
	return item.OwnerID == user.ID
}

func (a *App) replaceStoredFile(ctx context.Context, user *User, id string, upload *multipart.FileHeader) (StoredFile, error) {
	item, err := a.storedFile(ctx, id)
	if err != nil {
		return StoredFile{}, err
	}
	if !canAccessOwnedFile(user, item.OwnerID) {
		return StoredFile{}, Error(403, "forbidden", "不能替换其他用户的文件")
	}
	if item.MediaType == importCSVMediaType {
		return StoredFile{}, Error(409, "managed_upload_immutable", "导入上传内容不可替换，请重新上传并创建任务")
	}
	temp, size, sum, err := copyUploadToTemp(upload, a.filesDir(), ".bin", a.Config.MaxUploadBytes)
	if err != nil {
		return StoredFile{}, err
	}
	defer os.Remove(temp)
	old := item.Path + ".replaced-" + NewID()
	if err = os.Rename(item.Path, old); err != nil {
		return StoredFile{}, Error(500, "storage_unavailable", "文件暂时不可替换")
	}
	if err = os.Rename(temp, item.Path); err != nil {
		_ = os.Rename(old, item.Path)
		return StoredFile{}, Error(500, "storage_unavailable", "文件暂时不可替换")
	}
	now := time.Now().UTC()
	if _, err = a.DB.ExecContext(ctx, `UPDATE files SET size=?,sha256=?,updated_at=? WHERE id=?`, size, sum, now, id); err != nil {
		_ = os.Remove(item.Path)
		_ = os.Rename(old, item.Path)
		return StoredFile{}, err
	}
	_ = os.Remove(old)
	item.Size, item.SHA256, item.UpdatedAt = size, sum, now
	return item.StoredFile, nil
}

func (a *App) deleteStoredFile(ctx context.Context, user *User, id string) error {
	item, err := a.storedFile(ctx, id)
	if err != nil {
		return err
	}
	if !canAccessOwnedFile(user, item.OwnerID) {
		return Error(403, "forbidden", "不能删除其他用户的文件")
	}
	pending := item.Path + ".deleting-" + NewID()
	if err = os.Rename(item.Path, pending); err != nil {
		return Error(500, "storage_unavailable", "文件暂时不可删除")
	}
	if _, err = a.DB.ExecContext(ctx, `DELETE FROM files WHERE id=?`, id); err != nil {
		_ = os.Rename(pending, item.Path)
		return err
	}
	return os.Remove(pending)
}

func contentDispositionName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, filepath.Base(name))
	return name
}

func safePublicError(err error, fallback string) error {
	if IsAPIError(err) {
		return err
	}
	return Error(500, "internal_error", fallback)
}

func requireRegularFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("managed file unavailable")
	}
	return nil
}
