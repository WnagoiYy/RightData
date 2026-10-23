package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/gogf/gf/v2/frame/g"
)

// ResourcePolicy is read from the same saved JSON document as the resource layout.
// A missing enabled flag keeps incomplete drafts out of ordinary viewing.
type ResourcePolicy struct {
	Enabled       bool     `json:"enabled"`
	Permissions   []string `json:"permissions"`
	DefinitionIDs []string `json:"definitionIds"`
}

type MenuPolicy struct {
	Enabled      bool     `json:"enabled"`
	Permissions  []string `json:"permissions"`
	ParentID     string   `json:"parentId"`
	Order        int      `json:"order"`
	ResourceID   string   `json:"resourceId"`
	ResourceKind string   `json:"resourceKind"`
}

func isResourceKind(kind string) bool {
	return kind == "report" || kind == "dashboard" || kind == "h5" || kind == "screen"
}

func hasAllPermissions(user *User, permissions []string) bool {
	if user == nil || user.Disabled {
		return false
	}
	for _, permission := range permissions {
		if !HasPermission(user, permission) {
			return false
		}
	}
	return true
}

func validateResourceConfig(kind string, body json.RawMessage) error {
	if !isResourceKind(kind) && kind != "menu" {
		return nil
	}
	if !strings.HasPrefix(strings.TrimSpace(string(body)), "{") {
		return Error(400, "invalid_resource", "资源和菜单配置必须是JSON对象")
	}
	var policy ResourcePolicy
	if err := json.Unmarshal(body, &policy); err != nil || len(policy.Permissions) > 100 || len(policy.DefinitionIDs) > 100 {
		return Error(400, "invalid_resource", "资源权限或查询定义配置无效")
	}
	for _, permission := range policy.Permissions {
		if strings.TrimSpace(permission) == "" || len(permission) > 100 {
			return Error(400, "invalid_resource", "资源权限标识无效")
		}
	}
	for _, id := range policy.DefinitionIDs {
		if id == "" || len(id) > 100 {
			return Error(400, "invalid_resource", "查询定义标识无效")
		}
	}
	if kind == "menu" {
		var menu MenuPolicy
		if err := json.Unmarshal(body, &menu); err != nil || len(menu.ParentID) > 100 || len(menu.ResourceID) > 100 || (menu.ResourceID != "" && !isResourceKind(menu.ResourceKind)) || (menu.ResourceID == "" && menu.ResourceKind != "") {
			return Error(400, "invalid_resource", "菜单资源绑定无效")
		}
	}
	return nil
}

func (a *App) resource(ctx context.Context, id string) (*SharedConfig, ResourcePolicy, error) {
	var cfg SharedConfig
	var body string
	var policy ResourcePolicy
	err := a.DB.QueryRowContext(ctx, `SELECT id,kind,name,body,owner_id,version,updated_at FROM configs WHERE id=? AND kind IN ('report','dashboard','h5','screen')`, id).
		Scan(&cfg.ID, &cfg.Kind, &cfg.Name, &body, &cfg.OwnerID, &cfg.Version, &cfg.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, policy, Error(404, "resource_not_found", "资源不存在")
	}
	if err != nil {
		return nil, policy, err
	}
	cfg.Body = json.RawMessage(body)
	if validateResourceConfig(cfg.Kind, cfg.Body) != nil || json.Unmarshal(cfg.Body, &policy) != nil {
		return nil, policy, Error(409, "invalid_resource", "资源配置不可用")
	}
	return &cfg, policy, nil
}

type menuRecord struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	MenuPolicy
}

func (a *App) menuRecords(ctx context.Context) (map[string]menuRecord, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT id,name,body FROM configs WHERE kind='menu'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := map[string]menuRecord{}
	for rows.Next() {
		var record menuRecord
		var body string
		if err = rows.Scan(&record.ID, &record.Name, &body); err != nil {
			return nil, err
		}
		if validateResourceConfig("menu", json.RawMessage(body)) == nil && json.Unmarshal([]byte(body), &record.MenuPolicy) == nil {
			records[record.ID] = record
		}
	}
	return records, rows.Err()
}

func menuAccessible(user *User, id string, records map[string]menuRecord) bool {
	seen := map[string]bool{}
	for id != "" {
		menu, ok := records[id]
		if !ok || seen[id] || len(seen) >= 64 || !menu.Enabled || !hasAllPermissions(user, menu.Permissions) {
			return false
		}
		seen[id] = true
		id = menu.ParentID
	}
	return len(seen) > 0
}

func (a *App) visibleResource(ctx context.Context, id string) (*SharedConfig, ResourcePolicy, error) {
	u, err := Require(ctx, "resources.read")
	if err != nil {
		return nil, ResourcePolicy{}, err
	}
	cfg, policy, err := a.resource(ctx, id)
	if err != nil {
		return nil, policy, err
	}
	if !policy.Enabled || !hasAllPermissions(u, policy.Permissions) {
		return nil, policy, Error(403, "resource_forbidden", "没有资源访问权限")
	}
	records, err := a.menuRecords(ctx)
	if err != nil {
		return nil, policy, err
	}
	for _, menu := range records {
		if menu.ResourceID == id && menu.ResourceKind == cfg.Kind && menuAccessible(u, menu.ID, records) {
			if cfg.Kind == "screen" {
				publication, err := a.screenPublication(ctx, cfg.ID)
				if err != nil {
					return nil, policy, err
				}
				if publication.PublishedVersion == nil {
					return nil, policy, Error(404, "screen_not_published", "大屏尚未发布")
				}
			}
			return cfg, policy, nil
		}
	}
	return nil, policy, Error(403, "resource_forbidden", "资源没有可访问的菜单入口")
}

type ResourceController struct{ App *App }

type MenuListReq struct {
	g.Meta `path:"/api/v1/menus" method:"get" tags:"资源访问" summary:"当前用户可访问的动态菜单"`
}
type MenuItem struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ParentID     string `json:"parentId"`
	Order        int    `json:"order"`
	ResourceID   string `json:"resourceId"`
	ResourceKind string `json:"resourceKind"`
}
type MenuListRes struct {
	Items []MenuItem `json:"items"`
}

func (c *ResourceController) Menus(ctx context.Context, req *MenuListReq) (*MenuListRes, error) {
	u, err := Require(ctx, "resources.read")
	if err != nil {
		return nil, err
	}
	records, err := c.App.menuRecords(ctx)
	if err != nil {
		return nil, err
	}
	res := &MenuListRes{Items: []MenuItem{}}
	visible := map[string]bool{}
	for _, menu := range records {
		if menu.ResourceID == "" || !menuAccessible(u, menu.ID, records) {
			continue
		}
		cfg, policy, e := c.App.resource(ctx, menu.ResourceID)
		if e != nil || cfg.Kind != menu.ResourceKind || !policy.Enabled || !hasAllPermissions(u, policy.Permissions) {
			continue
		}
		if cfg.Kind == "screen" {
			publication, err := c.App.screenPublication(ctx, cfg.ID)
			if err != nil {
				return nil, err
			}
			if publication.PublishedVersion == nil {
				continue
			}
		}
		for id := menu.ID; id != ""; id = records[id].ParentID {
			visible[id] = true
		}
	}
	for id := range visible {
		menu := records[id]
		res.Items = append(res.Items, MenuItem{menu.ID, menu.Name, menu.ParentID, menu.Order, menu.ResourceID, menu.ResourceKind})
	}
	sort.Slice(res.Items, func(i, j int) bool {
		if res.Items[i].Order != res.Items[j].Order {
			return res.Items[i].Order < res.Items[j].Order
		}
		return res.Items[i].ID < res.Items[j].ID
	})
	return res, nil
}

type ResourceViewReq struct {
	g.Meta `path:"/api/v1/resources/{id}" method:"get" tags:"资源访问" summary:"校验动态菜单绑定后查看已启用资源"`
	ID     string `json:"id" in:"path" v:"required|length:1,100"`
}
type ResourceViewRes struct {
	SharedConfig
	*ScreenPublication
}

func (c *ResourceController) View(ctx context.Context, req *ResourceViewReq) (*ResourceViewRes, error) {
	cfg, _, err := c.App.visibleResource(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	res := &ResourceViewRes{SharedConfig: *cfg}
	if cfg.Kind == "screen" {
		publication, err := c.App.screenPublication(ctx, cfg.ID)
		if err != nil {
			return nil, err
		}
		if publication.PublishedVersion == nil {
			return nil, Error(404, "screen_not_published", "大屏尚未发布")
		}
		res.ScreenPublication = &publication
	}
	return res, nil
}

type ResourceExecuteReq struct {
	g.Meta       `path:"/api/v1/resources/{id}/execute" method:"post" tags:"资源访问" summary:"按当前资源、菜单和数据权限执行绑定查询"`
	ID           string         `json:"id" in:"path" v:"required|length:1,100"`
	DefinitionID string         `json:"definitionId" v:"required|length:1,100"`
	Params       map[string]any `json:"params"`
}

func (c *ResourceController) Execute(ctx context.Context, req *ResourceExecuteReq) (*QueryResult, error) {
	cfg, policy, err := c.App.visibleResource(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	if !containsDefinition(policy, req.DefinitionID) {
		return nil, Error(403, "definition_forbidden", "查询定义未绑定到此资源")
	}
	ctx = context.WithValue(ctx, querySourceKey{}, cfg.Kind)
	return c.App.executeDefinition(ctx, req.DefinitionID, req.Params)
}
func containsDefinition(policy ResourcePolicy, id string) bool {
	for _, definition := range policy.DefinitionIDs {
		if definition == id {
			return true
		}
	}
	return false
}

type ResourcePreviewReq struct {
	g.Meta       `path:"/api/v1/resources/preview" method:"post" tags:"资源访问" summary:"按配置权限预览已保存或未保存资源"`
	ID           string          `json:"id"`
	Kind         string          `json:"kind"`
	Body         json.RawMessage `json:"body"`
	DefinitionID string          `json:"definitionId"`
	Params       map[string]any  `json:"params"`
}
type ResourcePreviewRes struct {
	Body json.RawMessage `json:"body"`
	Data *QueryResult    `json:"data,omitempty"`
}

func (c *ResourceController) Preview(ctx context.Context, req *ResourcePreviewReq) (*ResourcePreviewRes, error) {
	if _, err := Require(ctx, "config.write"); err != nil {
		return nil, err
	}
	var policy ResourcePolicy
	body := req.Body
	if len(body) == 0 {
		cfg, savedPolicy, err := c.App.resource(ctx, req.ID)
		if err != nil {
			return nil, err
		}
		body, policy = cfg.Body, savedPolicy
		ctx = context.WithValue(ctx, querySourceKey{}, cfg.Kind)
	} else {
		if !isResourceKind(req.Kind) || len(body) > 1<<20 {
			return nil, Error(400, "invalid_resource", "预览资源无效")
		}
		if err := validateResourceConfig(req.Kind, body); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(body, &policy); err != nil {
			return nil, Error(400, "invalid_resource", "预览资源无效")
		}
		ctx = context.WithValue(ctx, querySourceKey{}, req.Kind)
	}
	res := &ResourcePreviewRes{Body: body}
	if req.DefinitionID != "" {
		if !containsDefinition(policy, req.DefinitionID) {
			return nil, Error(403, "definition_forbidden", "查询定义未绑定到预览资源")
		}
		var err error
		res.Data, err = c.App.executeDefinition(ctx, req.DefinitionID, req.Params)
		if err != nil {
			return nil, err
		}
	}
	return res, nil
}
