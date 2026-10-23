package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/gogf/gf/v2/frame/g"
)

type ConfigController struct{ App *App }
type SharedConfig struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	Name      string          `json:"name"`
	Body      json.RawMessage `json:"body"`
	OwnerID   string          `json:"ownerId"`
	Version   int64           `json:"version"`
	UpdatedAt time.Time       `json:"updatedAt"`
}
type ConfigListReq struct {
	g.Meta `path:"/api/v1/configs" method:"get" tags:"共享配置" summary:"共享配置列表"`
	Kind   string `json:"kind" in:"query"`
}
type ConfigListRes struct {
	Items []SharedConfig `json:"items"`
}

func (c *ConfigController) List(ctx context.Context, r *ConfigListReq) (*ConfigListRes, error) {
	u, err := Require(ctx, "config.read")
	if err != nil {
		return nil, err
	}
	rows, err := c.App.DB.QueryContext(ctx, "SELECT id,kind,name,body,owner_id,version,updated_at FROM configs WHERE (?='' OR kind=?) AND (? OR kind='query') ORDER BY updated_at DESC LIMIT 1000", r.Kind, r.Kind, HasPermission(u, "config.write"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := &ConfigListRes{Items: []SharedConfig{}}
	for rows.Next() {
		var cfg SharedConfig
		var body string
		if err = rows.Scan(&cfg.ID, &cfg.Kind, &cfg.Name, &body, &cfg.OwnerID, &cfg.Version, &cfg.UpdatedAt); err != nil {
			return nil, err
		}
		cfg.Body = json.RawMessage(body)
		res.Items = append(res.Items, cfg)
	}
	return res, rows.Err()
}

type ConfigSaveReq struct {
	g.Meta         `path:"/api/v1/configs/{id}" method:"put" tags:"共享配置" summary:"按版本保存共享配置"`
	ID             string          `json:"id" in:"path" v:"required|length:1,100"`
	Kind           string          `json:"kind" v:"required|in:report,dashboard,h5,screen,query,settings,menu,role"`
	Name           string          `json:"name" v:"required|length:1,200"`
	Body           json.RawMessage `json:"body"`
	Version        int64           `json:"version"`
	IdempotencyKey string          `p:"Idempotency-Key" in:"header" json:"-"`
}

func (c *ConfigController) Save(ctx context.Context, r *ConfigSaveReq) (*SharedConfig, error) {
	u, err := Require(ctx, "config.write")
	if err != nil {
		return nil, err
	}
	if !json.Valid(r.Body) || len(r.Body) > 1<<20 {
		return nil, Error(400, "invalid_config", "配置必须是有效且不超过1MiB的JSON")
	}
	if err = validateResourceConfig(r.Kind, r.Body); err != nil {
		return nil, err
	}
	r.IdempotencyKey = requestIdempotencyKey(ctx, r.IdempotencyKey)
	if r.IdempotencyKey == "" || len(r.IdempotencyKey) > 200 {
		return nil, Error(400, "idempotency_required", "需要有效的 Idempotency-Key")
	}
	payload, _ := json.Marshal(r)
	fingerprint := tokenHash(string(payload))
	key := "config:" + u.ID + ":" + r.IdempotencyKey
	c.App.authMu.Lock()
	defer c.App.authMu.Unlock()
	tx, err := c.App.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var oldFingerprint, oldResult string
	err = tx.QueryRowContext(ctx, "SELECT fingerprint,result FROM _rd_operations WHERE key=?", key).Scan(&oldFingerprint, &oldResult)
	if err == nil {
		if oldFingerprint != fingerprint {
			return nil, Error(409, "idempotency_conflict", "同一幂等标识不能用于不同请求")
		}
		var result SharedConfig
		if json.Unmarshal([]byte(oldResult), &result) != nil {
			return nil, Error(500, "invalid_operation", "操作记录不可读")
		}
		return &result, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var current int64
	ownerID := u.ID
	err = tx.QueryRowContext(ctx, "SELECT version,owner_id FROM configs WHERE id=?", r.ID).Scan(&current, &ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		ownerID = u.ID
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if current != r.Version {
		return nil, Error(409, "version_conflict", "配置已更新，请重新读取后保存")
	}
	result := &SharedConfig{r.ID, r.Kind, r.Name, r.Body, ownerID, current + 1, time.Now().UTC()}
	_, err = tx.ExecContext(ctx, `INSERT INTO configs VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,body=excluded.body,version=excluded.version,updated_at=excluded.updated_at`, result.ID, result.Kind, result.Name, string(result.Body), result.OwnerID, result.Version, result.UpdatedAt)
	if err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(result)
	if _, err = tx.ExecContext(ctx, "INSERT INTO _rd_operations VALUES (?,?,?,?,?)", key, u.ID, fingerprint, string(encoded), time.Now().UTC()); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

type ConfigDeleteReq struct {
	g.Meta  `path:"/api/v1/configs/{id}" method:"delete" tags:"共享配置" summary:"按版本删除共享配置"`
	ID      string `json:"id" in:"path"`
	Version int64  `json:"version" in:"query" v:"min:1"`
}

func (c *ConfigController) Delete(ctx context.Context, r *ConfigDeleteReq) (*Empty, error) {
	if _, err := Require(ctx, "config.write"); err != nil {
		return nil, err
	}
	res, err := c.App.DB.ExecContext(ctx, "DELETE FROM configs WHERE id=? AND version=?", r.ID, r.Version)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, Error(409, "version_conflict", "配置不存在或版本已更新")
	}
	return &Empty{}, nil
}

type DefinitionExecuteReq struct {
	g.Meta `path:"/api/v1/configs/{id}/execute" method:"post" tags:"共享配置" summary:"以当前用户数据权限执行查询定义"`
	ID     string         `json:"id" in:"path"`
	Params map[string]any `json:"params"`
}
type queryDefinition struct {
	DatasetID   string        `json:"datasetId"`
	SQL         string        `json:"sql"`
	Query       *QueryRequest `json:"query"`
	Permissions []string      `json:"permissions"`
}

func (c *ConfigController) Execute(ctx context.Context, r *DefinitionExecuteReq) (*QueryResult, error) {
	if _, err := Require(ctx, "config.read"); err != nil {
		return nil, err
	}
	return c.App.executeDefinition(ctx, r.ID, r.Params)
}

func (a *App) executeDefinition(ctx context.Context, id string, params map[string]any) (*QueryResult, error) {
	var body string
	if err := a.DB.QueryRowContext(ctx, "SELECT body FROM configs WHERE id=? AND kind='query'", id).Scan(&body); err != nil {
		return nil, Error(404, "definition_not_found", "查询定义不存在")
	}
	var def queryDefinition
	if json.Unmarshal([]byte(body), &def) != nil {
		return nil, Error(400, "invalid_definition", "查询定义无效")
	}
	if !hasAllPermissions(CurrentUser(ctx), def.Permissions) {
		return nil, Error(403, "definition_forbidden", "没有查询定义访问权限")
	}
	var query QueryRequest
	if def.SQL != "" {
		ctx = WithQueryKind(ctx, "controlled_sql")
		q, err := ParseControlledSelect(def.SQL, params, def.DatasetID)
		if err != nil {
			return nil, err
		}
		query = q
	} else if def.Query != nil {
		query = *def.Query
		if query.DatasetID == "" {
			query.DatasetID = def.DatasetID
		}
	} else {
		return nil, Error(400, "invalid_definition", "查询定义缺少取数条件")
	}
	result, err := a.Query(ctx, query)
	return &result, err
}

type GrantReq struct {
	g.Meta     `path:"/api/v1/users/{userId}/grants" method:"put" tags:"系统管理" summary:"设置数据集表级行列授权"`
	UserID     string   `json:"userId" in:"path"`
	DatasetID  string   `json:"datasetId" v:"required"`
	Table      string   `json:"table" v:"required"`
	Operations []string `json:"operations"`
	Columns    []string `json:"columns"`
	RowFilter  *Filter  `json:"rowFilter"`
}

func (c *ConfigController) Grant(ctx context.Context, r *GrantReq) (*Empty, error) {
	if _, err := Require(ctx, "users.manage"); err != nil {
		return nil, err
	}
	if r.Table != "*" {
		if err := validatePublicIdentifier(r.Table, "表"); err != nil {
			return nil, err
		}
	}
	if _, err := c.App.UserByID(ctx, r.UserID); err != nil {
		return nil, Error(404, "user_not_found", "用户不存在或已禁用")
	}
	if _, err := c.App.DatasetDB(ctx, r.DatasetID); err != nil {
		return nil, err
	}
	for _, op := range r.Operations {
		if op != "read" && op != "write" && op != "schema" && op != "export" {
			return nil, Error(400, "invalid_operation", "授权操作无效")
		}
	}
	for _, col := range r.Columns {
		if col != "*" {
			if err := validatePublicIdentifier(col, "字段"); err != nil {
				return nil, err
			}
		}
	}
	ops, _ := json.Marshal(r.Operations)
	cols, _ := json.Marshal(r.Columns)
	filter, _ := json.Marshal(r.RowFilter)
	c.App.authMu.Lock()
	defer c.App.authMu.Unlock()
	tx, err := c.App.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO grants VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,dataset_id,table_name) DO UPDATE SET operations=excluded.operations,columns_json=excluded.columns_json,row_filter=excluded.row_filter`, r.UserID, r.DatasetID, r.Table, string(ops), string(cols), string(filter))
	if err != nil {
		return nil, err
	}
	if err = bumpAuthorization(ctx, tx); err != nil {
		return nil, err
	}
	return &Empty{}, tx.Commit()
}

type GrantsListReq struct {
	g.Meta `path:"/api/v1/users/{userId}/grants" method:"get" tags:"系统管理" summary:"查询用户数据授权"`
	UserID string `json:"userId" in:"path"`
}
type GrantRecord struct {
	DatasetID  string          `json:"datasetId"`
	Table      string          `json:"table"`
	Operations json.RawMessage `json:"operations"`
	Columns    json.RawMessage `json:"columns"`
	RowFilter  json.RawMessage `json:"rowFilter"`
}
type GrantsListRes struct {
	Items []GrantRecord `json:"items"`
}

func (c *ConfigController) Grants(ctx context.Context, r *GrantsListReq) (*GrantsListRes, error) {
	if _, err := Require(ctx, "users.manage"); err != nil {
		return nil, err
	}
	rows, err := c.App.DB.QueryContext(ctx, "SELECT dataset_id,table_name,operations,columns_json,row_filter FROM grants WHERE user_id=?", r.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := &GrantsListRes{Items: []GrantRecord{}}
	for rows.Next() {
		var record GrantRecord
		var ops, cols, filter string
		if err = rows.Scan(&record.DatasetID, &record.Table, &ops, &cols, &filter); err != nil {
			return nil, err
		}
		record.Operations = json.RawMessage(ops)
		record.Columns = json.RawMessage(cols)
		record.RowFilter = json.RawMessage(filter)
		res.Items = append(res.Items, record)
	}
	return res, rows.Err()
}

type AuditReq struct {
	g.Meta   `path:"/api/v1/logs" method:"get" tags:"运行状态" summary:"审计及访问日志"`
	Category string `json:"category" in:"query"`
	Limit    int    `json:"limit" in:"query"`
	Offset   int    `json:"offset" in:"query"`
}
type AuditRecord struct {
	ID         string    `json:"id"`
	CreatedAt  time.Time `json:"createdAt"`
	ActorID    string    `json:"actorId"`
	Category   string    `json:"category"`
	Action     string    `json:"action"`
	Target     string    `json:"target"`
	Outcome    string    `json:"outcome"`
	DurationMS int64     `json:"durationMs"`
	RequestID  string    `json:"requestId"`
}
type AuditRes struct {
	Items []AuditRecord `json:"items"`
}

func (c *ConfigController) Logs(ctx context.Context, r *AuditReq) (*AuditRes, error) {
	if _, err := Require(ctx, "logs.read"); err != nil {
		return nil, err
	}
	if r.Limit <= 0 {
		r.Limit = 100
	}
	if r.Limit > 1000 || r.Offset < 0 {
		return nil, Error(400, "invalid_page", "分页参数无效")
	}
	rows, err := c.App.DB.QueryContext(ctx, "SELECT id,created_at,actor_id,category,action,target,outcome,duration_ms,request_id FROM audit WHERE (?='' OR category=?) ORDER BY created_at DESC LIMIT ? OFFSET ?", r.Category, r.Category, r.Limit, r.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := &AuditRes{Items: []AuditRecord{}}
	for rows.Next() {
		var item AuditRecord
		if err = rows.Scan(&item.ID, &item.CreatedAt, &item.ActorID, &item.Category, &item.Action, &item.Target, &item.Outcome, &item.DurationMS, &item.RequestID); err != nil {
			return nil, err
		}
		res.Items = append(res.Items, item)
	}
	return res, rows.Err()
}
