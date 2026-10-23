package app

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"
)

type Config struct {
	Address               string
	DataDir               string
	AdminUsername         string
	AdminPassword         string
	QueryTimeout          time.Duration
	TaskTimeout           time.Duration
	MaxUploadBytes        int64
	MaxResultRows         int
	MaxConcurrentTasks    int
	MaxConcurrentRequests int
	ResultTTL             time.Duration
	CookieSecure          bool
}

type App struct {
	DB             *sql.DB
	Config         Config
	InstanceID     string
	EngineVersion  string
	systemPassword string
	mu             sync.Mutex
	handles        map[string]*Database
	authMu         sync.Mutex
	taskMu         sync.Mutex
	tasks          map[string]context.CancelFunc
	taskSlots      chan struct{}
	wg             sync.WaitGroup
	ctx            context.Context
	cancel         context.CancelFunc
	closed         bool
	unlock         func()
}

type Database struct {
	DB       *sql.DB
	Mu       sync.Mutex
	Path     string
	Password string
}
type User struct {
	ID          string   `json:"id"`
	Username    string   `json:"username"`
	Permissions []string `json:"permissions"`
	Disabled    bool     `json:"disabled"`
}
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string                  { return e.Message }
func Error(status int, code, message string) error { return &APIError{status, code, message} }
func HasPermission(u *User, permission string) bool {
	if u == nil || u.Disabled {
		return false
	}
	for _, p := range u.Permissions {
		if p == "*" || p == permission {
			return true
		}
	}
	return false
}

type userContextKey struct{}

func CurrentUser(ctx context.Context) *User { u, _ := ctx.Value(userContextKey{}).(*User); return u }
func WithUser(ctx context.Context, u *User) context.Context {
	return context.WithValue(ctx, userContextKey{}, u)
}
func Require(ctx context.Context, permission string) (*User, error) {
	u := CurrentUser(ctx)
	if u == nil {
		return nil, Error(401, "unauthenticated", "请先登录")
	}
	if !HasPermission(u, permission) {
		return nil, Error(403, "forbidden", "没有操作权限")
	}
	return u, nil
}
func IsAPIError(err error) bool { var e *APIError; return errors.As(err, &e) }

// DatasetDB opens only server-registered business files. Callers apply table/row/column policy.
func (a *App) DatasetDB(ctx context.Context, id string) (*Database, error) {
	return a.datasetDB(ctx, id)
}

func (a *App) Audit(ctx context.Context, userID, category, action, target, outcome string, duration time.Duration) {
	logCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, _ = a.DB.ExecContext(logCtx, `INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, NewID(), time.Now().UTC(), userID, category, action, target, outcome, duration.Milliseconds(), RequestID(ctx))
}

type querySourceKey struct{}
type queryKindKey struct{}

func QuerySource(ctx context.Context) string {
	s, _ := ctx.Value(querySourceKey{}).(string)
	if s == "" {
		return "api"
	}
	return s
}
func WithQueryKind(ctx context.Context, kind string) context.Context {
	return context.WithValue(ctx, queryKindKey{}, kind)
}
func QueryKind(ctx context.Context) string {
	k, _ := ctx.Value(queryKindKey{}).(string)
	if k == "" {
		return "structured"
	}
	return k
}
func (a *App) QueryAudit(ctx context.Context, datasetID, table, kind, sqlTemplate, outcome string, duration time.Duration) {
	u := CurrentUser(ctx)
	if u == nil {
		return
	}
	logCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, _ = a.DB.ExecContext(logCtx, `INSERT INTO query_logs VALUES (?,?,?,?,?,?,?,?,?,?,?)`, NewID(), time.Now().UTC(), u.ID, datasetID, table, QuerySource(ctx), kind, sqlTemplate, outcome, duration.Milliseconds(), RequestID(ctx))
}
