package app

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/duckdb/duckdb-go/v2"
)

func NewID() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func tokenHash(s string) string  { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func sqlLiteral(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// OpenEncrypted is for trusted storage operations only. No user SQL is executed here.
func OpenEncrypted(ctx context.Context, path, password string) (*sql.DB, error) {
	return openEncrypted(ctx, path, password, "")
}

func openEncrypted(ctx context.Context, path, password, backupDirectory string) (*sql.DB, error) {
	if len(password) < 12 {
		return nil, Error(400, "invalid_password", "数据库密码至少需要12个字符")
	}
	db, err := sql.Open("duckdb", ":memory:?threads=2&memory_limit=512MB&autoinstall_known_extensions=false&autoload_known_extensions=false")
	if err != nil {
		return nil, errors.New("数据库引擎初始化失败")
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	fail := func() (*sql.DB, error) {
		db.Close()
		return nil, errors.New("加密数据库打开失败，请核对数据库文件、启动凭据与运行权限")
	}
	var platform, engine string
	if db.QueryRowContext(ctx, "PRAGMA platform").Scan(&platform) != nil || db.QueryRowContext(ctx, "SELECT version()").Scan(&engine) != nil {
		return fail()
	}
	extension := os.Getenv("RIGHTDATA_DUCKDB_EXTENSION")
	if extension == "" {
		exe, _ := os.Executable()
		for _, base := range []string{"resource", "../server/resource", "../../server/resource", filepath.Join(filepath.Dir(exe), "resource"), filepath.Join(filepath.Dir(exe), "../resource")} {
			candidate := filepath.Join(base, "duckdb", engine, platform, "httpfs.duckdb_extension")
			if _, e := os.Stat(candidate); e == nil {
				extension, _ = filepath.Abs(candidate)
				break
			}
		}
	}
	if extension == "" {
		db.Close()
		return nil, errors.New("缺少匹配引擎平台的离线 httpfs 扩展；请运行 deploy/scripts/prepare-duckdb.ps1 或设置 RIGHTDATA_DUCKDB_EXTENSION")
	}
	if _, err = db.ExecContext(ctx, "LOAD "+sqlLiteral(filepath.ToSlash(extension))); err != nil {
		db.Close()
		return nil, errors.New("离线 httpfs 扩展无法加载，请检查引擎版本与平台")
	}
	temp := filepath.Join(filepath.Dir(path), "tmp")
	if err = os.MkdirAll(temp, 0700); err != nil {
		return fail()
	}
	settings := []string{"SET temp_directory = " + sqlLiteral(filepath.ToSlash(temp)), "SET max_temp_directory_size = '1GB'", "ATTACH " + sqlLiteral(filepath.ToSlash(path)) + " AS vault (TYPE DUCKDB, ENCRYPTION_KEY " + sqlLiteral(password) + ", STORAGE_VERSION 'latest')", "USE vault"}
	if backupDirectory != "" {
		backupAbs, e := filepath.Abs(backupDirectory)
		if e != nil {
			return fail()
		}
		settings = append(settings, "SET allowed_directories=["+sqlLiteral(filepath.ToSlash(backupAbs))+"]")
	}
	settings = append(settings, "SET enable_external_access=false")
	for _, q := range settings {
		if _, err = db.ExecContext(ctx, q); err != nil {
			return fail()
		}
	}
	var version string
	if err = db.QueryRowContext(ctx, "SELECT version()").Scan(&version); err != nil || !strings.HasPrefix(version, "v2.") {
		db.Close()
		return nil, errors.New("需要 DuckDB 2.x 引擎")
	}
	return db, nil
}

func defaults(c Config) Config {
	if c.Address == "" {
		c.Address = "127.0.0.1:8003"
	}
	if c.DataDir == "" {
		c.DataDir = "data"
	}
	if c.AdminUsername == "" {
		c.AdminUsername = "admin"
	}
	if c.QueryTimeout <= 0 {
		c.QueryTimeout = 30 * time.Second
	}
	if c.TaskTimeout <= 0 {
		c.TaskTimeout = 15 * time.Minute
	}
	if c.MaxUploadBytes <= 0 {
		c.MaxUploadBytes = 50 << 20
	}
	if c.MaxResultRows <= 0 {
		c.MaxResultRows = 10000
	}
	if c.MaxConcurrentTasks <= 0 {
		c.MaxConcurrentTasks = 2
	}
	if c.MaxConcurrentRequests <= 0 {
		c.MaxConcurrentRequests = 32
	}
	if c.ResultTTL <= 0 {
		c.ResultTTL = 24 * time.Hour
	}
	return c
}

type bootRecord struct {
	Password    string `json:"password"`
	InstanceID  string `json:"instanceId"`
	Initialized bool   `json:"initialized"`
}

func protect(data []byte, decrypt bool) ([]byte, error) {
	keyText := os.Getenv("RIGHTDATA_MASTER_KEY")
	if keyText == "" {
		return platformProtect(data, decrypt)
	}
	key, err := base64.StdEncoding.DecodeString(keyText)
	if err != nil || len(key) != 32 {
		return nil, errors.New("RIGHTDATA_MASTER_KEY 必须为32字节密钥的Base64编码")
	}
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	if decrypt {
		if len(data) < gcm.NonceSize() {
			return nil, errors.New("启动凭据损坏")
		}
		return gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], []byte("RightData boot v1"))
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, data, []byte("RightData boot v1")), nil
}
func saveBoot(path string, b bootRecord) error {
	raw, _ := json.Marshal(b)
	enc, err := protect(raw, false)
	if err != nil {
		return err
	}
	tmp := path + ".pending"
	if err = os.WriteFile(tmp, enc, 0600); err != nil {
		return err
	}
	f, err := os.OpenFile(tmp, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	err = f.Sync()
	f.Close()
	if err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func Open(ctx context.Context, c Config) (*App, error) {
	c = defaults(c)
	abs, err := filepath.Abs(c.DataDir)
	if err != nil {
		return nil, err
	}
	c.DataDir = abs
	if err = os.MkdirAll(abs, 0700); err != nil {
		return nil, err
	}
	unlock, err := lockInstance(filepath.Join(abs, "instance.lock"))
	if err != nil {
		return nil, errors.New("实例已运行或无法锁定数据目录")
	}
	ok := false
	defer func() {
		if !ok {
			unlock()
		}
	}()
	bootPath := filepath.Join(abs, "startup.credential")
	dbPath := filepath.Join(abs, "system.duckdb")
	var boot bootRecord
	raw, readErr := os.ReadFile(bootPath)
	if errors.Is(readErr, os.ErrNotExist) {
		if _, e := os.Stat(dbPath); !errors.Is(e, os.ErrNotExist) {
			return nil, errors.New("系统库已存在但启动凭据缺失，停止初始化")
		}
		boot = bootRecord{Password: NewID(), InstanceID: NewID()}
		if err = saveBoot(bootPath, boot); err != nil {
			return nil, err
		}
	} else if readErr != nil {
		return nil, readErr
	} else {
		dec, e := protect(raw, true)
		if e != nil || json.Unmarshal(dec, &boot) != nil || boot.Password == "" || boot.InstanceID == "" {
			return nil, errors.New("启动凭据解密失败")
		}
	}
	if boot.Initialized {
		if _, err = os.Stat(dbPath); err != nil {
			return nil, errors.New("已初始化实例的系统库缺失，停止启动")
		}
	}
	db, err := openEncrypted(ctx, dbPath, boot.Password, filepath.Join(c.DataDir, "databases", "snapshots"))
	if err != nil {
		return nil, err
	}
	appCtx, cancel := context.WithCancel(context.Background())
	a := &App{DB: db, Config: c, InstanceID: boot.InstanceID, systemPassword: boot.Password, handles: map[string]*Database{}, tasks: map[string]context.CancelFunc{}, taskSlots: make(chan struct{}, c.MaxConcurrentTasks), ctx: appCtx, cancel: cancel, unlock: unlock}
	if err = a.migrate(ctx); err != nil {
		db.Close()
		cancel()
		return nil, fmt.Errorf("系统库初始化或迁移失败: %w", err)
	}
	if err = db.QueryRowContext(ctx, "SELECT version()").Scan(&a.EngineVersion); err != nil {
		db.Close()
		cancel()
		return nil, err
	}
	boot.Initialized = true
	if err = saveBoot(bootPath, boot); err != nil {
		db.Close()
		cancel()
		return nil, err
	}
	if err = a.RecoverJobs(ctx); err != nil {
		db.Close()
		cancel()
		return nil, err
	}
	a.StartCleanup()
	ok = true
	return a, nil
}

func (a *App) migrate(ctx context.Context) error {
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		`CREATE TABLE IF NOT EXISTS metadata (key VARCHAR PRIMARY KEY,value VARCHAR NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS users (id VARCHAR PRIMARY KEY,username VARCHAR UNIQUE NOT NULL,password_hash VARCHAR NOT NULL,permissions VARCHAR NOT NULL,disabled BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMP NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS sessions (id VARCHAR PRIMARY KEY,user_id VARCHAR NOT NULL,access_hash VARCHAR UNIQUE NOT NULL,refresh_hash VARCHAR UNIQUE NOT NULL,access_expires TIMESTAMP NOT NULL,refresh_expires TIMESTAMP NOT NULL,revoked BOOLEAN NOT NULL DEFAULT false)`,
		`CREATE TABLE IF NOT EXISTS doc_tickets (hash VARCHAR PRIMARY KEY,session_id VARCHAR NOT NULL,expires_at TIMESTAMP NOT NULL,used BOOLEAN NOT NULL DEFAULT false)`,
		`CREATE TABLE IF NOT EXISTS doc_sessions (hash VARCHAR PRIMARY KEY,session_id VARCHAR NOT NULL,expires_at TIMESTAMP NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS data_files (id VARCHAR PRIMARY KEY,name VARCHAR NOT NULL,kind VARCHAR NOT NULL,source_id VARCHAR NOT NULL,path VARCHAR NOT NULL,password VARCHAR NOT NULL,owner_id VARCHAR NOT NULL,created_at TIMESTAMP NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS connections (id VARCHAR PRIMARY KEY,name VARCHAR NOT NULL,file_id VARCHAR NOT NULL,owner_id VARCHAR NOT NULL,created_at TIMESTAMP NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS grants (user_id VARCHAR NOT NULL,dataset_id VARCHAR NOT NULL,table_name VARCHAR NOT NULL,operations VARCHAR NOT NULL,columns_json VARCHAR NOT NULL,row_filter VARCHAR NOT NULL,PRIMARY KEY(user_id,dataset_id,table_name))`,
		`CREATE TABLE IF NOT EXISTS configs (id VARCHAR PRIMARY KEY,kind VARCHAR NOT NULL,name VARCHAR NOT NULL,body VARCHAR NOT NULL,owner_id VARCHAR NOT NULL,version BIGINT NOT NULL,updated_at TIMESTAMP NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS screen_versions (screen_id VARCHAR NOT NULL,version VARCHAR NOT NULL,manifest VARCHAR NOT NULL,path VARCHAR NOT NULL,size BIGINT NOT NULL,sha256 VARCHAR NOT NULL,created_by VARCHAR NOT NULL,created_at TIMESTAMP NOT NULL,PRIMARY KEY(screen_id,version))`,
		`CREATE TABLE IF NOT EXISTS screen_publications (screen_id VARCHAR PRIMARY KEY,version VARCHAR NOT NULL,revision BIGINT NOT NULL,published_by VARCHAR NOT NULL,published_at TIMESTAMP NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS files (id VARCHAR PRIMARY KEY,name VARCHAR NOT NULL,path VARCHAR NOT NULL,owner_id VARCHAR NOT NULL,size BIGINT NOT NULL,sha256 VARCHAR NOT NULL,media_type VARCHAR NOT NULL,created_at TIMESTAMP NOT NULL,updated_at TIMESTAMP NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS client_updates (id VARCHAR PRIMARY KEY,version VARCHAR NOT NULL,platform VARCHAR NOT NULL,arch VARCHAR NOT NULL,signature VARCHAR NOT NULL,path VARCHAR NOT NULL,size BIGINT NOT NULL,sha256 VARCHAR NOT NULL,file_name VARCHAR NOT NULL,publisher_id VARCHAR NOT NULL,active BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMP NOT NULL,disabled_at TIMESTAMP,UNIQUE(platform,arch,version))`,
		`CREATE TABLE IF NOT EXISTS jobs (id VARCHAR PRIMARY KEY,actor_id VARCHAR NOT NULL,kind VARCHAR NOT NULL,dataset_id VARCHAR NOT NULL,state VARCHAR NOT NULL,progress VARCHAR NOT NULL,fingerprint VARCHAR NOT NULL,idempotency_key VARCHAR NOT NULL,payload VARCHAR NOT NULL,result VARCHAR,error VARCHAR,created_at TIMESTAMP NOT NULL,updated_at TIMESTAMP NOT NULL,expires_at TIMESTAMP NOT NULL,UNIQUE(actor_id,dataset_id,idempotency_key))`,
		`CREATE TABLE IF NOT EXISTS client_events (actor_id VARCHAR NOT NULL,event_id VARCHAR NOT NULL,fingerprint VARCHAR NOT NULL,instance_id VARCHAR NOT NULL,category VARCHAR NOT NULL,action VARCHAR NOT NULL,target_id VARCHAR NOT NULL,outcome VARCHAR NOT NULL,occurred_at VARCHAR NOT NULL,received_at TIMESTAMP NOT NULL,applied BOOLEAN NOT NULL,audit_id VARCHAR NOT NULL,PRIMARY KEY(actor_id,event_id))`,
		`CREATE TABLE IF NOT EXISTS client_event_latest (actor_id VARCHAR NOT NULL,target_id VARCHAR NOT NULL,stage VARCHAR NOT NULL,event_id VARCHAR NOT NULL,occurred_at VARCHAR NOT NULL,PRIMARY KEY(actor_id,target_id,stage))`,
		`CREATE TABLE IF NOT EXISTS audit (id VARCHAR PRIMARY KEY,created_at TIMESTAMP NOT NULL,actor_id VARCHAR NOT NULL,category VARCHAR NOT NULL,action VARCHAR NOT NULL,target VARCHAR NOT NULL,outcome VARCHAR NOT NULL,duration_ms BIGINT NOT NULL,request_id VARCHAR NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS query_logs (id VARCHAR PRIMARY KEY,created_at TIMESTAMP NOT NULL,actor_id VARCHAR NOT NULL,dataset_id VARCHAR NOT NULL,table_name VARCHAR NOT NULL,source VARCHAR NOT NULL,query_kind VARCHAR NOT NULL,sql_template VARCHAR NOT NULL,outcome VARCHAR NOT NULL,duration_ms BIGINT NOT NULL,request_id VARCHAR NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS _rd_operations (key VARCHAR PRIMARY KEY,actor VARCHAR NOT NULL,fingerprint VARCHAR NOT NULL,result VARCHAR NOT NULL,created_at TIMESTAMP NOT NULL)`,
	}
	for _, q := range statements {
		if _, err = tx.ExecContext(ctx, q); err != nil {
			return errors.New("系统表结构不兼容")
		}
	}
	if err = migrateClientEventOccurredAt(ctx, tx); err != nil {
		return fmt.Errorf("系统表结构不兼容: 客户端事件时间迁移失败: %w", err)
	}
	var version string
	err = tx.QueryRowContext(ctx, "SELECT value FROM metadata WHERE key='schema_version'").Scan(&version)
	if err == nil && version != "1" {
		return errors.New("系统库版本超出服务支持范围")
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var n int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM users").Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		password := a.Config.AdminPassword
		if password == "" {
			password = NewID()
			enc, e := protect([]byte(password), false)
			if e != nil {
				return e
			}
			if e = os.WriteFile(filepath.Join(a.Config.DataDir, "admin.credential"), enc, 0600); e != nil {
				return e
			}
		}
		if len(password) < 12 {
			return errors.New("初始管理员密码至少12个字符")
		}
		hash, e := hashPassword(password)
		if e != nil {
			return e
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO users VALUES (?, ?, ?, ?, false, ?)", NewID(), a.Config.AdminUsername, hash, `["*"]`, time.Now().UTC()); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO data_files VALUES ('system','system.duckdb','system','',?,?, 'system',?) ON CONFLICT(id) DO NOTHING`, filepath.Join(a.Config.DataDir, "system.duckdb"), a.systemPassword, time.Now().UTC())
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO metadata VALUES ('schema_version','1') ON CONFLICT(key) DO NOTHING`)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO metadata VALUES ('authz_revision','1') ON CONFLICT(key) DO NOTHING`); err != nil {
		return err
	}
	return tx.Commit()
}

func migrateClientEventOccurredAt(ctx context.Context, tx *sql.Tx) error {
	type migrationSpec struct {
		table        string
		temporary    string
		create       string
		insertPrefix string
		selectPrefix string
		selectSuffix string
	}
	specs := []migrationSpec{
		{
			table:     "client_events",
			temporary: "_client_events_rfc3339_migration",
			create: `CREATE TABLE _client_events_rfc3339_migration (
				actor_id VARCHAR NOT NULL,event_id VARCHAR NOT NULL,fingerprint VARCHAR NOT NULL,instance_id VARCHAR NOT NULL,
				category VARCHAR NOT NULL,action VARCHAR NOT NULL,target_id VARCHAR NOT NULL,outcome VARCHAR NOT NULL,
				occurred_at VARCHAR NOT NULL,received_at TIMESTAMP NOT NULL,applied BOOLEAN NOT NULL,audit_id VARCHAR NOT NULL,
				PRIMARY KEY(actor_id,event_id))`,
			insertPrefix: `INSERT INTO _client_events_rfc3339_migration(actor_id,event_id,fingerprint,instance_id,category,action,target_id,outcome,occurred_at,received_at,applied,audit_id) `,
			selectPrefix: `SELECT actor_id,event_id,fingerprint,instance_id,category,action,target_id,outcome,`,
			selectSuffix: `,received_at,applied,audit_id FROM client_events`,
		},
		{
			table:     "client_event_latest",
			temporary: "_client_event_latest_rfc3339_migration",
			create: `CREATE TABLE _client_event_latest_rfc3339_migration (
				actor_id VARCHAR NOT NULL,target_id VARCHAR NOT NULL,stage VARCHAR NOT NULL,event_id VARCHAR NOT NULL,
				occurred_at VARCHAR NOT NULL,PRIMARY KEY(actor_id,target_id,stage))`,
			insertPrefix: `INSERT INTO _client_event_latest_rfc3339_migration(actor_id,target_id,stage,event_id,occurred_at) `,
			selectPrefix: `SELECT actor_id,target_id,stage,event_id,`,
			selectSuffix: ` FROM client_event_latest`,
		},
	}
	for _, spec := range specs {
		var dataType string
		err := tx.QueryRowContext(ctx, `SELECT data_type FROM information_schema.columns WHERE table_schema='main' AND table_name=? AND column_name='occurred_at'`, spec.table).Scan(&dataType)
		if err != nil {
			return fmt.Errorf("inspect %s occurred_at: %w", spec.table, err)
		}
		if strings.EqualFold(dataType, "VARCHAR") {
			continue
		}
		timestampExpression := "occurred_at"
		if strings.Contains(strings.ToUpper(dataType), "WITH TIME ZONE") {
			timestampExpression = "timezone('UTC', occurred_at)"
		} else if !strings.HasPrefix(strings.ToUpper(dataType), "TIMESTAMP") {
			return fmt.Errorf("unsupported %s occurred_at type %s", spec.table, dataType)
		}
		if _, err = tx.ExecContext(ctx, spec.create); err != nil {
			return fmt.Errorf("create %s replacement: %w", spec.table, err)
		}
		copyStatement := spec.insertPrefix + spec.selectPrefix + fmt.Sprintf(`strftime(%s, '%%Y-%%m-%%dT%%H:%%M:%%S.%%fZ')`, timestampExpression) + spec.selectSuffix
		if _, err = tx.ExecContext(ctx, copyStatement); err != nil {
			return fmt.Errorf("copy %s data: %w", spec.table, err)
		}
		if _, err = tx.ExecContext(ctx, `DROP TABLE `+spec.table); err != nil {
			return fmt.Errorf("drop old %s: %w", spec.table, err)
		}
		if _, err = tx.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE %s RENAME TO %s`, spec.temporary, spec.table)); err != nil {
			return fmt.Errorf("rename %s replacement: %w", spec.table, err)
		}
	}
	return nil
}

// AuthorizationRevision invalidates immutable exports after any grant change.
func (a *App) AuthorizationRevision(ctx context.Context) (string, error) {
	var revision string
	err := a.DB.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key='authz_revision'`).Scan(&revision)
	return revision, err
}
func bumpAuthorization(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `UPDATE metadata SET value=CAST(CAST(value AS BIGINT)+1 AS VARCHAR) WHERE key='authz_revision'`)
	return err
}

func (a *App) datasetDB(ctx context.Context, id string) (*Database, error) {
	if id == "system" {
		return nil, Error(403, "system_database", "系统库不作为业务数据集开放")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if d := a.handles[id]; d != nil {
		return d, nil
	}
	if a.closed {
		return nil, Error(503, "unavailable", "服务正在停止")
	}
	var path, password, kind string
	if err := a.DB.QueryRowContext(ctx, "SELECT path,password,kind FROM data_files WHERE id=?", id).Scan(&path, &password, &kind); err != nil {
		return nil, Error(404, "dataset_not_found", "数据集不存在")
	}
	if kind != "business" {
		return nil, Error(400, "not_dataset", "该文件不是业务数据集")
	}
	if _, err := os.Stat(path); err != nil {
		return nil, Error(503, "dataset_missing", "数据集文件缺失")
	}
	db, err := openEncrypted(ctx, path, password, filepath.Join(a.Config.DataDir, "databases", "snapshots"))
	if err != nil {
		return nil, Error(503, "dataset_unavailable", "数据集无法打开")
	}
	d := &Database{DB: db, Path: path, Password: password}
	a.handles[id] = d
	return d, nil
}

func (a *App) Close() error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil
	}
	a.closed = true
	a.mu.Unlock()
	a.cancel()
	a.wg.Wait()
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, d := range a.handles {
		d.Mu.Lock()
		d.DB.Close()
		d.Mu.Unlock()
	}
	err := a.DB.Close()
	if a.unlock != nil {
		a.unlock()
	}
	return err
}

// InitialPassword is a local operator command; never exposed by an HTTP endpoint.
func InitialPassword(dataDir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, "admin.credential"))
	if err != nil {
		return "", err
	}
	p, err := protect(raw, true)
	return string(p), err
}
