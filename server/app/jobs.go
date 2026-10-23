package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	jobQueued    = "queued"
	jobRunning   = "running"
	jobSucceeded = "succeeded"
	jobFailed    = "failed"
	jobCanceled  = "canceled"
	jobExpired   = "expired"
)

type Job struct {
	ID             string          `json:"id"`
	ActorID        string          `json:"actorId,omitempty"`
	Kind           string          `json:"kind"`
	DatasetID      string          `json:"datasetId"`
	State          string          `json:"state"`
	Progress       json.RawMessage `json:"progress"`
	Result         json.RawMessage `json:"result,omitempty"`
	Error          string          `json:"error,omitempty"`
	CreatedAt      time.Time       `json:"createdAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
	ExpiresAt      time.Time       `json:"expiresAt"`
	Fingerprint    string          `json:"-"`
	IdempotencyKey string          `json:"-"`
	Payload        json.RawMessage `json:"-"`
}

type ImportCondition struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value any    `json:"value,omitempty"`
}

type ImportJobSpec struct {
	DatasetID string           `json:"datasetId"`
	Table     string           `json:"table"`
	UploadID  string           `json:"uploadId"`
	Mode      string           `json:"mode"`
	Columns   []string         `json:"columns,omitempty"`
	KeyFields []string         `json:"keyFields,omitempty"`
	Condition *ImportCondition `json:"condition,omitempty"`
}

type ExportJobSpec struct {
	DatasetID string   `json:"datasetId"`
	Table     string   `json:"table"`
	Fields    []string `json:"fields"`
	Filters   []Filter `json:"filters,omitempty"`
	OrderBy   []Order  `json:"orderBy,omitempty"`
}

type BackupJobSpec struct {
	SourceID string `json:"sourceId"`
	BackupID string `json:"backupId"`
}

type jobPayload struct {
	Import       *ImportJobSpec `json:"import,omitempty"`
	Export       *ExportJobSpec `json:"export,omitempty"`
	Backup       *BackupJobSpec `json:"backup,omitempty"`
	UploadSHA256 string         `json:"uploadSha256,omitempty"`
	Source       string         `json:"source,omitempty"`
	RequestID    string         `json:"requestId,omitempty"`
}

type jobArtifact struct {
	Path          string `json:"path,omitempty"`
	Name          string `json:"name,omitempty"`
	SHA256        string `json:"sha256,omitempty"`
	AuthzRevision string `json:"authzRevision,omitempty"`
	Size          int64  `json:"size,omitempty"`
	TotalRows     int64  `json:"totalRows,omitempty"`
	Inserted      int64  `json:"insertedRows,omitempty"`
	Updated       int64  `json:"updatedRows,omitempty"`
	Deleted       int64  `json:"deletedRows,omitempty"`
	Skipped       int64  `json:"skippedRows,omitempty"`
	RolledBack    bool   `json:"rolledBack"`
	DataFileID    string `json:"dataFileId,omitempty"`
}

func (a *App) readJob(ctx context.Context, id string) (Job, error) {
	var job Job
	var progress, payload string
	var result, message sql.NullString
	err := a.DB.QueryRowContext(ctx, `SELECT id,actor_id,kind,dataset_id,state,progress,fingerprint,idempotency_key,payload,result,error,created_at,updated_at,expires_at FROM jobs WHERE id=?`, id).
		Scan(&job.ID, &job.ActorID, &job.Kind, &job.DatasetID, &job.State, &progress, &job.Fingerprint, &job.IdempotencyKey, &payload, &result, &message, &job.CreatedAt, &job.UpdatedAt, &job.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return job, Error(404, "job_not_found", "任务不存在")
	}
	if err != nil {
		return job, err
	}
	job.Progress = json.RawMessage(progress)
	job.Payload = json.RawMessage(payload)
	if result.Valid {
		job.Result = publicJobResult(json.RawMessage(result.String))
	}
	if message.Valid {
		job.Error = message.String
	}
	return job, nil
}

func publicJobResult(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var values map[string]any
	if json.Unmarshal(raw, &values) != nil {
		return nil
	}
	delete(values, "path")
	delete(values, "authzRevision")
	result, _ := json.Marshal(values)
	return result
}

func jobFingerprint(kind string, payload jobPayload) (string, error) {
	fingerprintPayload := payload
	fingerprintPayload.Source = ""
	fingerprintPayload.RequestID = ""
	if payload.Backup != nil {
		backup := *payload.Backup
		backup.BackupID = ""
		fingerprintPayload.Backup = &backup
	}
	fingerprintBody, err := json.Marshal(fingerprintPayload)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(append([]byte(kind+"\x00"), fingerprintBody...))
	return hex.EncodeToString(hash[:]), nil
}

func (a *App) existingIdempotentJob(ctx context.Context, actorID, datasetID, key, fingerprint string) (Job, bool, error) {
	var id, existingFingerprint string
	err := a.DB.QueryRowContext(ctx, `SELECT id,fingerprint FROM jobs WHERE actor_id=? AND dataset_id=? AND idempotency_key=?`, actorID, datasetID, key).Scan(&id, &existingFingerprint)
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, err
	}
	if existingFingerprint != fingerprint {
		return Job{}, false, Error(409, "idempotency_key_reused", "幂等标识已用于不同请求")
	}
	job, err := a.readJob(ctx, id)
	return job, true, err
}

func (a *App) submitJob(ctx context.Context, user *User, kind, datasetID, key string, payload jobPayload) (Job, error) {
	key = strings.TrimSpace(key)
	if key == "" || len(key) > 128 {
		return Job{}, Error(400, "idempotency_key_required", "必须提供有效的 Idempotency-Key")
	}
	fingerprint, err := jobFingerprint(kind, payload)
	if err != nil {
		return Job{}, err
	}
	if existing, ok, lookupErr := a.existingIdempotentJob(ctx, user.ID, datasetID, key, fingerprint); ok || lookupErr != nil {
		return existing, lookupErr
	}
	// Serialize admission with Close so every accepted task is added to the
	// wait group before shutdown can begin waiting.
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return Job{}, Error(503, "unavailable", "服务正在停止")
	}
	select {
	case <-a.baseContext().Done():
		return Job{}, Error(503, "unavailable", "服务正在停止")
	default:
	}
	if existing, ok, lookupErr := a.existingIdempotentJob(ctx, user.ID, datasetID, key, fingerprint); ok || lookupErr != nil {
		return existing, lookupErr
	}
	queueLimit := a.Config.MaxConcurrentTasks * 16
	if queueLimit < 16 {
		queueLimit = 16
	}
	var pending int
	if err = a.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs WHERE state IN (?,?)`, jobQueued, jobRunning).Scan(&pending); err != nil {
		return Job{}, err
	}
	if pending >= queueLimit {
		return Job{}, Error(429, "job_queue_full", "后台任务队列已满，请稍后重试")
	}
	now := time.Now().UTC()
	ttl := a.Config.ResultTTL
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	jobID := NewID()
	payload.Source = QuerySource(ctx)
	payload.RequestID = RequestID(ctx)
	if payload.RequestID == "" {
		payload.RequestID = jobID
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return Job{}, err
	}
	job := Job{ID: jobID, ActorID: user.ID, Kind: kind, DatasetID: datasetID, State: jobQueued, Progress: json.RawMessage(`{"phase":"queued"}`), Fingerprint: fingerprint, IdempotencyKey: key, Payload: body, CreatedAt: now, UpdatedAt: now, ExpiresAt: now.Add(ttl)}
	_, err = a.DB.ExecContext(ctx, `INSERT INTO jobs(id,actor_id,kind,dataset_id,state,progress,fingerprint,idempotency_key,payload,result,error,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, job.ID, job.ActorID, job.Kind, job.DatasetID, job.State, string(job.Progress), job.Fingerprint, job.IdempotencyKey, string(job.Payload), nil, nil, job.CreatedAt, job.UpdatedAt, job.ExpiresAt)
	if err != nil {
		if existing, ok, lookupErr := a.existingIdempotentJob(ctx, user.ID, datasetID, key, fingerprint); ok || lookupErr != nil {
			return existing, lookupErr
		}
		return Job{}, err
	}
	a.startJob(job, user)
	return job, nil
}

func (a *App) startJob(job Job, user *User) {
	base := a.ctx
	if base == nil {
		base = context.Background()
	}
	var contextPayload jobPayload
	_ = json.Unmarshal(job.Payload, &contextPayload)
	if contextPayload.Source == "" {
		contextPayload.Source = "api"
	}
	if contextPayload.RequestID == "" {
		contextPayload.RequestID = job.ID
	}
	base = context.WithValue(base, querySourceKey{}, contextPayload.Source)
	base = context.WithValue(base, requestIDKey{}, contextPayload.RequestID)
	base = WithUser(base, user)
	timeout := a.Config.TaskTimeout
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	ctx, cancel := context.WithTimeout(base, timeout)
	a.taskMu.Lock()
	if a.tasks == nil {
		a.tasks = make(map[string]context.CancelFunc)
	}
	a.tasks[job.ID] = cancel
	a.taskMu.Unlock()
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		defer cancel()
		defer func() {
			a.taskMu.Lock()
			delete(a.tasks, job.ID)
			a.taskMu.Unlock()
		}()
		if a.taskSlots != nil {
			select {
			case a.taskSlots <- struct{}{}:
				defer func() { <-a.taskSlots }()
			case <-ctx.Done():
				a.finishCanceledJob(job.ID)
				return
			}
		}
		currentUser, refreshErr := a.refreshJobUser(ctx, user.ID)
		if refreshErr != nil {
			a.finishFailedJob(job.ID, refreshErr)
			return
		}
		ctx = WithUser(ctx, currentUser)
		result, runErr := a.runJob(ctx, job)
		if runErr != nil {
			if job.Kind == "import" && a.resolveCommittedImport(job) {
				return
			}
			if job.Kind == "backup" && a.resolveCommittedBackup(job) {
				return
			}
			if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
				a.finishCanceledJob(job.ID)
				return
			}
			a.finishFailedJob(job.ID, runErr)
			return
		}
		a.finishSuccessfulJob(job.ID, result)
	}()
}

func (a *App) refreshJobUser(ctx context.Context, id string) (*User, error) {
	user, err := a.UserByID(ctx, id)
	if err != nil || user.Disabled {
		return nil, Error(403, "job_permission_revoked", "任务执行权限已失效")
	}
	return user, nil
}

func (a *App) resolveCommittedImport(job Job) bool {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(a.baseContext()), 15*time.Second)
	defer cancel()
	database, err := a.DatasetDB(ctx, job.DatasetID)
	if err != nil {
		return false
	}
	database.Mu.Lock()
	defer database.Mu.Unlock()
	var actor, fingerprint, raw string
	if err = database.DB.QueryRowContext(ctx, `SELECT actor,fingerprint,result FROM _rd_operations WHERE key=?`, job.IdempotencyKey).Scan(&actor, &fingerprint, &raw); err != nil || actor != job.ActorID || fingerprint != job.Fingerprint {
		return false
	}
	var artifact jobArtifact
	if json.Unmarshal([]byte(raw), &artifact) != nil {
		return false
	}
	a.finishSuccessfulJob(job.ID, artifact)
	return true
}

func (a *App) resolveCommittedBackup(job Job) bool {
	var payload jobPayload
	if json.Unmarshal(job.Payload, &payload) != nil || payload.Backup == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(a.baseContext()), 15*time.Second)
	defer cancel()
	record, err := a.dataFile(ctx, payload.Backup.BackupID)
	if err != nil || record.Kind != "backup" || record.SourceID != payload.Backup.SourceID || requireRegularFile(record.Path) != nil {
		return false
	}
	a.finishSuccessfulJob(job.ID, jobArtifact{DataFileID: record.ID, Name: record.Name, Size: record.Size})
	return true
}

func (a *App) runJob(ctx context.Context, job Job) (jobArtifact, error) {
	progress := `{"phase":"running"}`
	result, err := a.DB.ExecContext(ctx, `UPDATE jobs SET state=?,progress=?,updated_at=? WHERE id=? AND state=?`, jobRunning, progress, time.Now().UTC(), job.ID, jobQueued)
	if err != nil {
		return jobArtifact{}, err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return jobArtifact{}, context.Canceled
	}
	var payload jobPayload
	if json.Unmarshal(job.Payload, &payload) != nil {
		return jobArtifact{}, Error(500, "invalid_job_payload", "任务参数损坏")
	}
	switch job.Kind {
	case "import":
		if payload.Import == nil {
			return jobArtifact{}, Error(500, "invalid_job_payload", "导入任务参数损坏")
		}
		return a.runImportJob(ctx, job, *payload.Import, payload.UploadSHA256)
	case "export":
		if payload.Export == nil {
			return jobArtifact{}, Error(500, "invalid_job_payload", "导出任务参数损坏")
		}
		return a.runExportJob(ctx, job, *payload.Export)
	case "backup":
		if payload.Backup == nil {
			return jobArtifact{}, Error(500, "invalid_job_payload", "备份任务参数损坏")
		}
		if _, permissionErr := Require(ctx, "datasets.manage"); permissionErr != nil {
			return jobArtifact{}, permissionErr
		}
		item, backupErr := a.createBackupWithID(ctx, CurrentUser(ctx), payload.Backup.SourceID, payload.Backup.BackupID)
		if backupErr != nil {
			return jobArtifact{}, backupErr
		}
		return jobArtifact{DataFileID: item.ID, Name: item.Name, Size: item.Size}, nil
	default:
		return jobArtifact{}, Error(500, "invalid_job_kind", "任务类型无效")
	}
}

func (a *App) finishSuccessfulJob(id string, result jobArtifact) {
	result.RolledBack = false
	body, _ := json.Marshal(result)
	_, _ = a.DB.ExecContext(context.WithoutCancel(a.baseContext()), `UPDATE jobs SET state=?,progress=?,result=?,error=NULL,updated_at=? WHERE id=? AND state=?`, jobSucceeded, `{"phase":"complete","percent":100}`, string(body), time.Now().UTC(), id, jobRunning)
}

func (a *App) finishFailedJob(id string, runErr error) {
	message := "任务执行失败，所有未提交修改已回滚"
	if apiErr := new(APIError); errors.As(runErr, &apiErr) {
		message = apiErr.Message
	}
	_, _ = a.DB.ExecContext(context.WithoutCancel(a.baseContext()), `UPDATE jobs SET state=?,progress=?,error=?,updated_at=? WHERE id=? AND state IN (?,?)`, jobFailed, `{"phase":"failed"}`, message, time.Now().UTC(), id, jobQueued, jobRunning)
}

func (a *App) finishCanceledJob(id string) {
	_, _ = a.DB.ExecContext(context.WithoutCancel(a.baseContext()), `UPDATE jobs SET state=?,progress=?,error=?,updated_at=? WHERE id=? AND state IN (?,?)`, jobCanceled, `{"phase":"canceled"}`, "任务已取消，未提交修改已回滚", time.Now().UTC(), id, jobQueued, jobRunning)
}

func (a *App) baseContext() context.Context {
	if a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}

type csvCell struct {
	Text   string
	Quoted bool
}

func parseStrictCSV(data []byte) ([][]csvCell, error) {
	const (
		maxCSVColumns = 1024
		maxCSVRows    = 250000
		maxCSVCells   = 2000000
	)
	if len(data) == 0 {
		return nil, Error(422, "empty_csv", "CSV 文件为空")
	}
	if bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		return nil, Error(422, "csv_bom_not_allowed", "CSV 必须为 UTF-8 且不含 BOM")
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return nil, Error(422, "invalid_csv_encoding", "CSV 必须为有效 UTF-8 文本")
	}
	rows := [][]csvCell{}
	row := []csvCell{}
	totalCells := 0
	var limitErr error
	field := strings.Builder{}
	quoted, inQuotes, quoteClosed, atFieldStart := false, false, false, true
	finishField := func() {
		if limitErr != nil {
			return
		}
		if len(row) >= maxCSVColumns {
			limitErr = Error(422, "csv_too_many_columns", "CSV 每条记录不能超过 1024 个字段")
			return
		}
		row = append(row, csvCell{Text: field.String(), Quoted: quoted})
		field.Reset()
		quoted, quoteClosed, atFieldStart = false, false, true
	}
	finishRow := func() {
		finishField()
		if limitErr != nil {
			return
		}
		if len(rows) >= maxCSVRows || totalCells+len(row) > maxCSVCells {
			limitErr = Error(413, "csv_record_limit", "CSV 记录过多，请拆分文件后分批导入")
			return
		}
		totalCells += len(row)
		rows = append(rows, row)
		row = []csvCell{}
	}
	for i := 0; i < len(data); i++ {
		b := data[i]
		if b == '\r' {
			return nil, Error(422, "invalid_csv_line_ending", "CSV 必须使用 LF 换行")
		}
		if inQuotes {
			if b == '"' {
				if i+1 < len(data) && data[i+1] == '"' {
					field.WriteByte('"')
					i++
				} else {
					inQuotes, quoteClosed = false, true
				}
			} else {
				field.WriteByte(b)
			}
			continue
		}
		if quoteClosed && b != ',' && b != '\n' {
			return nil, Error(422, "invalid_csv_quote", "CSV 引号字段结束后只能跟逗号或换行")
		}
		switch b {
		case '"':
			if !atFieldStart {
				return nil, Error(422, "invalid_csv_quote", "CSV 字段中的双引号必须正确转义")
			}
			quoted, inQuotes, atFieldStart = true, true, false
		case ',':
			finishField()
		case '\n':
			finishRow()
		default:
			field.WriteByte(b)
			atFieldStart = false
		}
		if limitErr != nil {
			return nil, limitErr
		}
	}
	if inQuotes {
		return nil, Error(422, "invalid_csv_quote", "CSV 存在未闭合的引号字段")
	}
	if field.Len() > 0 || quoted || len(row) > 0 || data[len(data)-1] != '\n' {
		finishRow()
	}
	if limitErr != nil {
		return nil, limitErr
	}
	if len(rows) == 0 {
		return nil, Error(422, "empty_csv", "CSV 文件为空")
	}
	width := len(rows[0])
	if width == 0 {
		return nil, Error(422, "invalid_csv_header", "CSV 表头不能为空")
	}
	for i, item := range rows {
		if len(item) != width {
			return nil, Error(422, "csv_field_count_mismatch", fmt.Sprintf("CSV 第 %d 条逻辑记录字段数量不一致", i+1))
		}
	}
	return rows, nil
}

type importColumn struct {
	Name       string
	DataType   string
	Nullable   bool
	HasDefault bool
}

func jobQuote(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }

func readImportColumns(ctx context.Context, tx *sql.Tx, table string) ([]importColumn, error) {
	rows, err := tx.QueryContext(ctx, `SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='main' AND table_name=? ORDER BY ordinal_position`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []importColumn{}
	for rows.Next() {
		var item importColumn
		var nullable string
		var defaultValue sql.NullString
		if err = rows.Scan(&item.Name, &item.DataType, &nullable, &defaultValue); err != nil {
			return nil, err
		}
		item.Nullable, item.HasDefault = nullable == "YES", defaultValue.Valid
		result = append(result, item)
	}
	return result, rows.Err()
}

func (a *App) runImportJob(ctx context.Context, job Job, spec ImportJobSpec, expectedUploadSHA256 string) (jobArtifact, error) {
	if spec.DatasetID == "" || spec.Table == "" || spec.UploadID == "" {
		return jobArtifact{}, Error(400, "invalid_import", "导入任务缺少数据集、数据表或上传标识")
	}
	mode := strings.ToLower(strings.TrimSpace(spec.Mode))
	if mode == "" {
		mode = "append"
	}
	if mode != "append" && mode != "replace_all" && mode != "replace_where" && mode != "merge" && mode != "skip_existing" {
		return jobArtifact{}, Error(400, "unsupported_import_mode", "不支持该导入模式")
	}
	authzRevision, err := a.AuthorizationRevision(ctx)
	if err != nil {
		return jobArtifact{}, Error(500, "authorization_unavailable", "无法读取导入授权版本")
	}
	policy, err := a.AuthorizeTable(ctx, spec.DatasetID, spec.Table, "write", spec.Columns)
	if err != nil {
		return jobArtifact{}, err
	}
	if mode == "replace_all" {
		if _, err = Require(ctx, "schema.manage"); err != nil {
			return jobArtifact{}, err
		}
	}
	upload, err := a.storedFile(ctx, spec.UploadID)
	if err != nil {
		return jobArtifact{}, err
	}
	user := CurrentUser(ctx)
	if user == nil || upload.OwnerID != user.ID || upload.MediaType != importCSVMediaType {
		return jobArtifact{}, Error(403, "upload_access_denied", "导入上传不可用")
	}
	if err = requireRegularFile(upload.Path); err != nil {
		return jobArtifact{}, Error(409, "upload_missing", "导入上传文件缺失")
	}
	limit := a.Config.MaxUploadBytes
	if limit <= 0 {
		limit = 64 << 20
	}
	file, err := os.Open(upload.Path)
	if err != nil {
		return jobArtifact{}, Error(409, "upload_missing", "导入上传文件缺失")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	_ = file.Close()
	if err != nil {
		return jobArtifact{}, Error(422, "upload_read_failed", "无法读取导入上传")
	}
	if int64(len(data)) > limit {
		return jobArtifact{}, Error(413, "upload_too_large", "导入上传超过大小限制")
	}
	digest := sha256.Sum256(data)
	if expectedUploadSHA256 == "" || !strings.EqualFold(expectedUploadSHA256, hex.EncodeToString(digest[:])) {
		return jobArtifact{}, Error(409, "upload_changed", "导入上传内容已变化，请重新上传并创建任务")
	}
	rows, err := parseStrictCSV(data)
	if err != nil {
		return jobArtifact{}, err
	}
	headers := make([]string, len(rows[0]))
	seen := map[string]bool{}
	for i, cell := range rows[0] {
		headers[i] = cell.Text
		key := strings.ToLower(cell.Text)
		if strings.TrimSpace(cell.Text) == "" || seen[key] {
			return jobArtifact{}, Error(422, "invalid_csv_header", "CSV 表头不能为空或重复")
		}
		seen[key] = true
	}
	if len(spec.Columns) > 0 {
		if len(spec.Columns) != len(headers) {
			return jobArtifact{}, Error(422, "csv_header_mismatch", "CSV 表头与提交列定义不一致")
		}
		for i := range headers {
			if headers[i] != spec.Columns[i] {
				return jobArtifact{}, Error(422, "csv_header_mismatch", "CSV 表头与提交列定义不一致")
			}
		}
	} else {
		spec.Columns = headers
	}
	if policy, err = a.AuthorizeTable(ctx, spec.DatasetID, spec.Table, "write", headers); err != nil {
		return jobArtifact{}, err
	}
	database, err := a.DatasetDB(ctx, spec.DatasetID)
	if err != nil {
		return jobArtifact{}, err
	}
	database.Mu.Lock()
	defer database.Mu.Unlock()
	tx, err := database.DB.BeginTx(ctx, nil)
	if err != nil {
		return jobArtifact{}, Error(422, "import_transaction_failed", "无法启动导入事务")
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS _rd_operations(key VARCHAR PRIMARY KEY, actor VARCHAR NOT NULL, fingerprint VARCHAR NOT NULL, result VARCHAR NOT NULL, created_at TIMESTAMPTZ NOT NULL)`); err != nil {
		return jobArtifact{}, Error(422, "operation_metadata_failed", "无法初始化导入事务元数据")
	}
	columns, err := readImportColumns(ctx, tx, spec.Table)
	if err != nil || len(columns) == 0 {
		return jobArtifact{}, Error(404, "table_not_found", "目标数据表不存在")
	}
	byName := map[string]importColumn{}
	policyFields := make([]Field, len(columns))
	for _, column := range columns {
		byName[strings.ToLower(column.Name)] = column
	}
	for i, column := range columns {
		dataType, typeErr := normalizeFieldType(column.DataType)
		if typeErr != nil {
			return jobArtifact{}, typeErr
		}
		policyFields[i] = Field{Name: column.Name, DataType: dataType, Nullable: column.Nullable, Ordinal: i + 1}
	}
	authorizationColumns := headers
	if mode == "replace_all" {
		authorizationColumns = make([]string, len(columns))
		for i, column := range columns {
			authorizationColumns[i] = column.Name
		}
		fullPolicy, authErr := a.AuthorizeTable(ctx, spec.DatasetID, spec.Table, "write", authorizationColumns)
		if authErr != nil || fullPolicy.Row != nil {
			return jobArtifact{}, Error(403, "replace_all_forbidden", "全表替换需要完整数据范围和全部字段权限")
		}
		policy = fullPolicy
	}
	for _, name := range headers {
		if _, ok := byName[strings.ToLower(name)]; !ok {
			return jobArtifact{}, Error(422, "unknown_import_column", "CSV 包含目标表不存在的字段")
		}
	}
	tableSQL := jobQuote(spec.Table)
	columnSQL := make([]string, len(headers))
	placeholders := make([]string, len(headers))
	for i, name := range headers {
		columnSQL[i], placeholders[i] = jobQuote(byName[strings.ToLower(name)].Name), "?"
	}
	insertSQL := `INSERT INTO ` + tableSQL + ` (` + strings.Join(columnSQL, ",") + `) VALUES (` + strings.Join(placeholders, ",") + `) RETURNING *`
	policySQL, policyArgs, err := CompilePolicySQL(policy, policyFields, "")
	if err != nil {
		return jobArtifact{}, err
	}
	artifact := jobArtifact{RolledBack: true}
	if mode == "replace_all" {
		if len(rows) == 1 {
			return jobArtifact{}, Error(422, "empty_replace_rejected", "空文件不能执行全表替换")
		}
		deleteSQL := `DELETE FROM ` + tableSQL
		if policySQL != "" {
			deleteSQL += ` WHERE (` + policySQL + `)`
		}
		res, deleteErr := tx.ExecContext(ctx, deleteSQL, policyArgs...)
		if deleteErr != nil {
			return jobArtifact{}, Error(422, "replace_failed", "全表替换清理失败")
		}
		artifact.Deleted, _ = res.RowsAffected()
	}
	var conditionIndex = -1
	if mode == "replace_where" {
		if spec.Condition == nil || strings.ToLower(spec.Condition.Op) != "eq" {
			return jobArtifact{}, Error(400, "unsupported_replace_condition", "按条件替换当前仅支持 eq 条件")
		}
		for i, name := range headers {
			if strings.EqualFold(name, spec.Condition.Field) {
				conditionIndex = i
			}
		}
		column, ok := byName[strings.ToLower(spec.Condition.Field)]
		if !ok || conditionIndex < 0 {
			return jobArtifact{}, Error(422, "replace_condition_column_missing", "替换条件字段必须存在于目标表和 CSV")
		}
		for i := 1; i < len(rows); i++ {
			cell := rows[i][conditionIndex]
			if cell.Text == `\N` && !cell.Quoted || fmt.Sprint(spec.Condition.Value) != cell.Text {
				return jobArtifact{}, Error(422, "row_outside_replace_scope", fmt.Sprintf("CSV 第 %d 条逻辑记录超出替换条件", i+1))
			}
		}
		deleteSQL := `DELETE FROM ` + tableSQL + ` WHERE ` + jobQuote(column.Name) + `=?`
		deleteArgs := []any{spec.Condition.Value}
		if policySQL != "" {
			deleteSQL += ` AND (` + policySQL + `)`
			deleteArgs = append(deleteArgs, policyArgs...)
		}
		res, deleteErr := tx.ExecContext(ctx, deleteSQL, deleteArgs...)
		if deleteErr != nil {
			return jobArtifact{}, Error(422, "replace_failed", "按条件替换清理失败")
		}
		artifact.Deleted, _ = res.RowsAffected()
	}
	keyIndexes, err := validateImportKeys(ctx, tx, tableSQL, headers, spec.KeyFields, mode, policySQL, policyArgs)
	if err != nil {
		return jobArtifact{}, err
	}
	batchKeys := map[string]bool{}
	for rowIndex := 1; rowIndex < len(rows); rowIndex++ {
		if err = ctx.Err(); err != nil {
			return jobArtifact{}, err
		}
		values := make([]any, len(headers))
		for i, cell := range rows[rowIndex] {
			if cell.Text == `\N` && !cell.Quoted {
				values[i] = nil
			} else {
				values[i] = cell.Text
			}
		}
		if len(keyIndexes) > 0 {
			parts := make([]string, len(keyIndexes))
			for i, index := range keyIndexes {
				if values[index] == nil {
					return jobArtifact{}, Error(422, "null_import_key", fmt.Sprintf("CSV 第 %d 条逻辑记录的键值不能为空", rowIndex+1))
				}
				parts[i] = fmt.Sprint(values[index])
			}
			key := strings.Join(parts, "\x00")
			if batchKeys[key] {
				return jobArtifact{}, Error(422, "duplicate_import_key", fmt.Sprintf("CSV 第 %d 条逻辑记录包含重复键", rowIndex+1))
			}
			batchKeys[key] = true
		}
		switch mode {
		case "merge":
			updated, fullRow, execErr := mergeImportRow(ctx, tx, tableSQL, headers, keyIndexes, values, columns, policySQL, policyArgs)
			if execErr != nil {
				return jobArtifact{}, Error(422, "import_row_invalid", fmt.Sprintf("CSV 第 %d 条逻辑记录校验或写入失败", rowIndex+1))
			}
			if policyErr := CheckPolicyValues(ctx, tx, policy, policyFields, fullRow); policyErr != nil {
				return jobArtifact{}, policyErr
			}
			if updated {
				artifact.Updated++
			} else {
				artifact.Inserted++
			}
		case "skip_existing":
			exists, queryErr := importKeyExists(ctx, tx, tableSQL, headers, keyIndexes, values, policySQL, policyArgs)
			if queryErr != nil {
				return jobArtifact{}, Error(422, "import_row_invalid", fmt.Sprintf("CSV 第 %d 条逻辑记录校验失败", rowIndex+1))
			}
			if exists {
				artifact.Skipped++
				continue
			}
			fullRow, execErr := queryImportRow(ctx, tx, insertSQL, values, columns)
			if execErr != nil {
				return jobArtifact{}, Error(422, "import_row_invalid", fmt.Sprintf("CSV 第 %d 条逻辑记录校验或写入失败", rowIndex+1))
			}
			if policyErr := CheckPolicyValues(ctx, tx, policy, policyFields, fullRow); policyErr != nil {
				return jobArtifact{}, policyErr
			}
			artifact.Inserted++
		default:
			fullRow, execErr := queryImportRow(ctx, tx, insertSQL, values, columns)
			if execErr != nil {
				return jobArtifact{}, Error(422, "import_row_invalid", fmt.Sprintf("CSV 第 %d 条逻辑记录校验或写入失败", rowIndex+1))
			}
			if policyErr := CheckPolicyValues(ctx, tx, policy, policyFields, fullRow); policyErr != nil {
				return jobArtifact{}, policyErr
			}
			artifact.Inserted++
		}
	}
	currentRevision, revisionErr := a.AuthorizationRevision(ctx)
	if revisionErr != nil || currentRevision != authzRevision {
		return jobArtifact{}, Error(403, "import_authorization_changed", "导入期间授权已变化，请重新创建任务")
	}
	latestPolicy, authErr := a.AuthorizeTable(ctx, spec.DatasetID, spec.Table, "write", authorizationColumns)
	if authErr != nil || mode == "replace_all" && latestPolicy.Row != nil {
		if authErr != nil {
			return jobArtifact{}, authErr
		}
		return jobArtifact{}, Error(403, "replace_all_forbidden", "全表替换需要完整数据范围和全部字段权限")
	}
	artifact.RolledBack = false
	operationResult, _ := json.Marshal(artifact)
	if _, err = tx.ExecContext(ctx, `INSERT INTO _rd_operations(key,actor,fingerprint,result,created_at) VALUES(?,?,?,?,?)`, job.IdempotencyKey, job.ActorID, job.Fingerprint, string(operationResult), time.Now().UTC()); err != nil {
		return jobArtifact{}, Error(409, "operation_conflict", "导入操作已存在或无法登记")
	}
	if err = tx.Commit(); err != nil {
		return jobArtifact{}, Error(422, "import_commit_failed", "导入事务提交失败，提交状态待恢复核验")
	}
	return artifact, nil
}

func validateImportKeys(ctx context.Context, tx *sql.Tx, tableSQL string, headers, keys []string, mode, policySQL string, policyArgs []any) ([]int, error) {
	if mode != "merge" && mode != "skip_existing" {
		return nil, nil
	}
	if len(keys) == 0 {
		return nil, Error(400, "import_keys_required", "按键导入必须指定键字段")
	}
	indexes := make([]int, len(keys))
	quoted := make([]string, len(keys))
	seen := map[string]bool{}
	for i, key := range keys {
		lower := strings.ToLower(key)
		if seen[lower] {
			return nil, Error(400, "duplicate_import_key_field", "键字段不能重复")
		}
		seen[lower] = true
		indexes[i] = -1
		for index, header := range headers {
			if strings.EqualFold(header, key) {
				indexes[i] = index
				quoted[i] = jobQuote(header)
			}
		}
		if indexes[i] < 0 {
			return nil, Error(422, "import_key_missing", "键字段必须存在于 CSV 和目标表")
		}
	}
	query := `SELECT 1 FROM ` + tableSQL
	if policySQL != "" {
		query += ` WHERE (` + policySQL + `)`
	}
	query += ` GROUP BY ` + strings.Join(quoted, ",") + ` HAVING COUNT(*)>1 LIMIT 1`
	var one int
	err := tx.QueryRowContext(ctx, query, policyArgs...).Scan(&one)
	if err == nil {
		return nil, Error(409, "target_key_not_unique", "目标表中的键字段当前不唯一")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, Error(422, "key_validation_failed", "无法校验目标键字段")
	}
	return indexes, nil
}

func importKeyWhere(headers []string, indexes []int, values []any) (string, []any) {
	predicates := make([]string, len(indexes))
	args := make([]any, len(indexes))
	for i, index := range indexes {
		predicates[i] = jobQuote(headers[index]) + `=?`
		args[i] = values[index]
	}
	return strings.Join(predicates, ` AND `), args
}

func importKeyExists(ctx context.Context, tx *sql.Tx, tableSQL string, headers []string, indexes []int, values []any, policySQL string, policyArgs []any) (bool, error) {
	where, args := importKeyWhere(headers, indexes, values)
	if policySQL != "" {
		where += ` AND (` + policySQL + `)`
		args = append(args, policyArgs...)
	}
	var one int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM `+tableSQL+` WHERE `+where+` LIMIT 1`, args...).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func queryImportRow(ctx context.Context, tx *sql.Tx, query string, args []any, columns []importColumn) (map[string]any, error) {
	values := make([]any, len(columns))
	pointers := make([]any, len(columns))
	for i := range values {
		pointers[i] = &values[i]
	}
	if err := tx.QueryRowContext(ctx, query, args...).Scan(pointers...); err != nil {
		return nil, err
	}
	result := make(map[string]any, len(columns))
	for i, column := range columns {
		dataType, err := normalizeFieldType(column.DataType)
		if err != nil {
			return nil, err
		}
		result[column.Name] = normalizeWireValue(values[i], dataType)
	}
	return result, nil
}

func mergeImportRow(ctx context.Context, tx *sql.Tx, tableSQL string, headers []string, keyIndexes []int, values []any, tableColumns []importColumn, policySQL string, policyArgs []any) (bool, map[string]any, error) {
	keySet := map[int]bool{}
	for _, index := range keyIndexes {
		keySet[index] = true
	}
	sets, args := []string{}, []any{}
	for index, header := range headers {
		if !keySet[index] {
			sets = append(sets, jobQuote(header)+`=?`)
			args = append(args, values[index])
		}
	}
	where, keyArgs := importKeyWhere(headers, keyIndexes, values)
	args = append(args, keyArgs...)
	if policySQL != "" {
		where += ` AND (` + policySQL + `)`
		args = append(args, policyArgs...)
	}
	if len(sets) > 0 {
		row, err := queryImportRow(ctx, tx, `UPDATE `+tableSQL+` SET `+strings.Join(sets, `,`)+` WHERE `+where+` RETURNING *`, args, tableColumns)
		if err == nil {
			return true, row, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return false, nil, err
		}
	} else {
		selectSQL := `SELECT * FROM ` + tableSQL + ` WHERE ` + where + ` LIMIT 1`
		row, err := queryImportRow(ctx, tx, selectSQL, args, tableColumns)
		if err == nil {
			return true, row, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return false, nil, err
		}
	}
	insertColumns, placeholders := make([]string, len(headers)), make([]string, len(headers))
	for i, header := range headers {
		insertColumns[i], placeholders[i] = jobQuote(header), "?"
	}
	row, err := queryImportRow(ctx, tx, `INSERT INTO `+tableSQL+` (`+strings.Join(insertColumns, `,`)+`) VALUES (`+strings.Join(placeholders, `,`)+`) RETURNING *`, values, tableColumns)
	return false, row, err
}

func exportJSONValue(value any) any {
	if value == nil {
		return nil
	}
	switch typed := value.(type) {
	case int:
		return strconv.FormatInt(int64(typed), 10)
	case int8:
		return strconv.FormatInt(int64(typed), 10)
	case int16:
		return strconv.FormatInt(int64(typed), 10)
	case int32:
		return strconv.FormatInt(int64(typed), 10)
	case int64:
		return strconv.FormatInt(typed, 10)
	case uint:
		return strconv.FormatUint(uint64(typed), 10)
	case uint8:
		return strconv.FormatUint(uint64(typed), 10)
	case uint16:
		return strconv.FormatUint(uint64(typed), 10)
	case uint32:
		return strconv.FormatUint(uint64(typed), 10)
	case uint64:
		return strconv.FormatUint(typed, 10)
	case time.Time:
		return typed.UTC().Format(time.RFC3339Nano)
	case []byte:
		return string(typed)
	case json.Number:
		return typed.String()
	}
	valueOf := reflect.ValueOf(value)
	if valueOf.IsValid() && valueOf.Kind() == reflect.String {
		return valueOf.String()
	}
	return value
}

type hashingLimitWriter struct {
	Writer io.Writer
	Hash   io.Writer
	Limit  int64
	N      int64
}

func (w *hashingLimitWriter) Write(p []byte) (int, error) {
	if w.Limit > 0 && w.N+int64(len(p)) > w.Limit {
		return 0, Error(413, "export_too_large", "导出结果超过大小限制")
	}
	n, err := w.Writer.Write(p)
	if n > 0 {
		_, _ = w.Hash.Write(p[:n])
		w.N += int64(n)
	}
	return n, err
}

func (a *App) runExportJob(ctx context.Context, job Job, spec ExportJobSpec) (jobArtifact, error) {
	if spec.DatasetID == "" || spec.Table == "" || len(spec.Fields) == 0 {
		return jobArtifact{}, Error(400, "invalid_export", "导出任务必须指定数据集、数据表和字段")
	}
	authzRevision, err := a.AuthorizationRevision(ctx)
	if err != nil {
		return jobArtifact{}, Error(500, "authorization_unavailable", "无法读取导出授权版本")
	}
	if err := ensurePrivateDir(a.resultsDir()); err != nil {
		return jobArtifact{}, Error(500, "storage_unavailable", "导出结果存储不可用")
	}
	path := filepath.Join(a.resultsDir(), job.ID+".ndjson")
	file, err := os.OpenFile(path+".pending", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return jobArtifact{}, Error(500, "storage_unavailable", "导出结果存储不可用")
	}
	complete := false
	defer func() {
		_ = file.Close()
		if !complete {
			_ = os.Remove(path + ".pending")
		}
	}()
	hash := sha256.New()
	sizeLimit := a.Config.MaxUploadBytes
	if sizeLimit <= 0 {
		sizeLimit = 256 << 20
	}
	writer := &hashingLimitWriter{Writer: file, Hash: hash, Limit: sizeLimit}
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	const chunkSize = 1000
	chunk := make([][]any, 0, chunkSize)
	sequence := 0
	flush := func() error {
		if len(chunk) == 0 {
			return nil
		}
		if err := encoder.Encode(map[string]any{"type": "chunk", "sequence": sequence, "rows": chunk}); err != nil {
			return err
		}
		sequence++
		chunk = make([][]any, 0, chunkSize)
		return nil
	}
	total, err := a.StreamQuery(ctx, QueryRequest{
		DatasetID: spec.DatasetID,
		Table:     spec.Table,
		Fields:    spec.Fields,
		Filters:   spec.Filters,
		OrderBy:   spec.OrderBy,
	}, "export", func(fields []Field) error {
		return encoder.Encode(map[string]any{"type": "schema", "fields": fields})
	}, func(source []any) error {
		row := make([]any, len(source))
		for i, value := range source {
			row[i] = exportJSONValue(value)
		}
		chunk = append(chunk, row)
		if len(chunk) == chunkSize {
			return flush()
		}
		return nil
	})
	if err != nil {
		return jobArtifact{}, err
	}
	if err = flush(); err != nil {
		return jobArtifact{}, err
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	footer, _ := json.Marshal(map[string]any{"type": "complete", "complete": true, "totalRows": total, "sha256": digest})
	if writer.Limit > 0 && writer.N+int64(len(footer)+1) > writer.Limit {
		return jobArtifact{}, Error(413, "export_too_large", "导出结果超过大小限制")
	}
	if _, err = file.Write(append(footer, '\n')); err != nil {
		return jobArtifact{}, err
	}
	if err = file.Sync(); err == nil {
		err = file.Close()
	}
	if err == nil {
		err = os.Rename(path+".pending", path)
	}
	if err != nil {
		return jobArtifact{}, Error(500, "export_write_failed", "无法保存导出结果")
	}
	complete = true
	info, _ := os.Stat(path)
	artifact := jobArtifact{Path: path, Name: spec.Table + ".ndjson", SHA256: digest, AuthzRevision: authzRevision, TotalRows: total}
	if info != nil {
		artifact.Size = info.Size()
	}
	return artifact, nil
}

func (a *App) cancelJob(ctx context.Context, user *User, id string) (Job, error) {
	job, err := a.readJob(ctx, id)
	if err != nil {
		return Job{}, err
	}
	if job.ActorID != user.ID && !HasPermission(user, "system.manage") {
		return Job{}, Error(403, "forbidden", "不能取消其他用户的任务")
	}
	if job.State == jobSucceeded || job.State == jobFailed || job.State == jobCanceled || job.State == jobExpired {
		return job, nil
	}
	a.taskMu.Lock()
	cancel := a.tasks[id]
	a.taskMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if job.State == jobQueued {
		a.finishCanceledJob(id)
	}
	return a.readJob(ctx, id)
}

// RecoverJobs resolves interrupted writes by checking the operation record that
// was committed in the same business transaction. It never replays a write.
func (a *App) RecoverJobs(ctx context.Context) error {
	rows, err := a.DB.QueryContext(ctx, `SELECT id,actor_id,kind,dataset_id,fingerprint,idempotency_key,payload FROM jobs WHERE state IN (?,?)`, jobQueued, jobRunning)
	if err != nil {
		return err
	}
	type pending struct {
		id, actor, kind, dataset, fingerprint, key string
		payload                                    []byte
	}
	items := []pending{}
	for rows.Next() {
		var item pending
		if err = rows.Scan(&item.id, &item.actor, &item.kind, &item.dataset, &item.fingerprint, &item.key, &item.payload); err != nil {
			_ = rows.Close()
			return err
		}
		items = append(items, item)
	}
	err = rows.Close()
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.kind == "export" {
			var result sql.NullString
			_ = a.DB.QueryRowContext(ctx, `SELECT result FROM jobs WHERE id=?`, item.id).Scan(&result)
			var artifact jobArtifact
			if result.Valid && json.Unmarshal([]byte(result.String), &artifact) == nil && artifact.Path != "" && pathWithin(a.resultsDir(), artifact.Path) && requireRegularFile(artifact.Path) == nil {
				_, _ = a.DB.ExecContext(ctx, `UPDATE jobs SET state=?,progress=?,error=NULL,updated_at=? WHERE id=?`, jobSucceeded, `{"phase":"complete","percent":100}`, time.Now().UTC(), item.id)
			} else {
				_, _ = a.DB.ExecContext(ctx, `UPDATE jobs SET state=?,progress=?,error=?,updated_at=? WHERE id=?`, jobFailed, `{"phase":"failed"}`, "服务重启时导出未完成，请重新创建任务", time.Now().UTC(), item.id)
			}
			continue
		}
		if item.kind == "backup" {
			var payload jobPayload
			var record dataFileRecord
			if json.Unmarshal(item.payload, &payload) == nil && payload.Backup != nil {
				record, _ = a.dataFile(ctx, payload.Backup.BackupID)
			}
			if payload.Backup != nil && record.ID != "" && record.Kind == "backup" && record.SourceID == payload.Backup.SourceID && requireRegularFile(record.Path) == nil {
				result, _ := json.Marshal(jobArtifact{DataFileID: record.ID, Name: record.Name, Size: record.Size})
				_, _ = a.DB.ExecContext(ctx, `UPDATE jobs SET state=?,progress=?,result=?,error=NULL,updated_at=? WHERE id=?`, jobSucceeded, `{"phase":"complete","percent":100}`, string(result), time.Now().UTC(), item.id)
			} else {
				_, _ = a.DB.ExecContext(ctx, `UPDATE jobs SET state=?,progress=?,error=?,updated_at=? WHERE id=?`, jobFailed, `{"phase":"failed"}`, "服务重启时备份未完成，请重新创建任务", time.Now().UTC(), item.id)
			}
			continue
		}
		database, openErr := a.DatasetDB(ctx, item.dataset)
		if openErr != nil {
			_, _ = a.DB.ExecContext(ctx, `UPDATE jobs SET state=?,progress=?,error=?,updated_at=? WHERE id=?`, jobFailed, `{"phase":"failed"}`, "服务重启后无法核实导入提交状态", time.Now().UTC(), item.id)
			continue
		}
		var actor, fingerprint, result string
		queryErr := database.DB.QueryRowContext(ctx, `SELECT actor,fingerprint,result FROM _rd_operations WHERE key=?`, item.key).Scan(&actor, &fingerprint, &result)
		if queryErr == nil && actor == item.actor && fingerprint == item.fingerprint {
			_, _ = a.DB.ExecContext(ctx, `UPDATE jobs SET state=?,progress=?,result=?,error=NULL,updated_at=? WHERE id=?`, jobSucceeded, `{"phase":"complete","percent":100}`, result, time.Now().UTC(), item.id)
		} else {
			_, _ = a.DB.ExecContext(ctx, `UPDATE jobs SET state=?,progress=?,error=?,updated_at=? WHERE id=?`, jobFailed, `{"phase":"failed"}`, "服务重启后未发现已提交记录，导入未自动重跑", time.Now().UTC(), item.id)
		}
	}
	return nil
}

// StartCleanup removes expired immutable artifacts and unreferenced import
// uploads. Job rows remain as idempotency evidence.
func (a *App) StartCleanup() {
	interval := a.Config.ResultTTL / 4
	if interval < time.Minute {
		interval = time.Minute
	}
	if interval > time.Hour {
		interval = time.Hour
	}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-a.baseContext().Done():
				return
			case <-ticker.C:
				cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(a.baseContext()), 30*time.Second)
				a.cleanupExpired(cleanupCtx)
				cancel()
			}
		}
	}()
}

func (a *App) cleanupExpired(ctx context.Context) {
	now := time.Now().UTC()
	rows, err := a.DB.QueryContext(ctx, `SELECT id,result FROM jobs WHERE expires_at<? AND result IS NOT NULL`, now)
	if err == nil {
		type expiredResult struct{ id, raw string }
		expired := []expiredResult{}
		for rows.Next() {
			var item expiredResult
			if rows.Scan(&item.id, &item.raw) == nil {
				expired = append(expired, item)
			}
		}
		_ = rows.Close()
		for _, item := range expired {
			var artifact jobArtifact
			if json.Unmarshal([]byte(item.raw), &artifact) == nil && artifact.Path != "" && pathWithin(a.resultsDir(), artifact.Path) {
				_ = os.Remove(artifact.Path)
			}
			_, _ = a.DB.ExecContext(ctx, `UPDATE jobs SET state=?,result=NULL,updated_at=? WHERE id=? AND state=?`, jobExpired, now, item.id, jobSucceeded)
		}
	}
	used := map[string]bool{}
	jobRows, err := a.DB.QueryContext(ctx, `SELECT payload FROM jobs WHERE state IN (?,?)`, jobQueued, jobRunning)
	if err == nil {
		for jobRows.Next() {
			var raw string
			if jobRows.Scan(&raw) == nil {
				var payload jobPayload
				if json.Unmarshal([]byte(raw), &payload) == nil && payload.Import != nil {
					used[payload.Import.UploadID] = true
				}
			}
		}
		_ = jobRows.Close()
	}
	ttl := a.Config.ResultTTL
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	fileRows, err := a.DB.QueryContext(ctx, `SELECT id,path FROM files WHERE media_type=? AND created_at<?`, importCSVMediaType, now.Add(-ttl))
	if err == nil {
		type expiredUpload struct{ id, path string }
		expired := []expiredUpload{}
		for fileRows.Next() {
			var item expiredUpload
			if fileRows.Scan(&item.id, &item.path) == nil && !used[item.id] {
				expired = append(expired, item)
			}
		}
		_ = fileRows.Close()
		for _, item := range expired {
			if !pathWithin(a.filesDir(), item.path) {
				continue
			}
			removeErr := os.Remove(item.path)
			if removeErr == nil || errors.Is(removeErr, os.ErrNotExist) {
				_, _ = a.DB.ExecContext(ctx, `DELETE FROM files WHERE id=?`, item.id)
			}
		}
	}
	_, _ = a.DB.ExecContext(ctx, `DELETE FROM doc_tickets WHERE expires_at<?`, now)
	_, _ = a.DB.ExecContext(ctx, `DELETE FROM doc_sessions WHERE expires_at<?`, now)
	_, _ = a.DB.ExecContext(ctx, `DELETE FROM sessions WHERE refresh_expires<?`, now)
	_, _ = a.DB.ExecContext(ctx, `DELETE FROM audit WHERE created_at<?`, now.Add(-90*24*time.Hour))
	_, _ = a.DB.ExecContext(ctx, `DELETE FROM query_logs WHERE created_at<?`, now.Add(-90*24*time.Hour))
	_ = a.CleanupScreenFiles(ctx, now)
}
