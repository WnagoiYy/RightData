package app

import (
	"context"
	"embed"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gogf/gf/v2/errors/gcode"
	"github.com/gogf/gf/v2/errors/gerror"
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/net/goai"
)

//go:embed assets/swagger-ui-bundle.js assets/swagger-ui.css
var swaggerAssets embed.FS

type requestIDKey struct{}

func RequestID(ctx context.Context) string { id, _ := ctx.Value(requestIDKey{}).(string); return id }

type Envelope struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Data      any    `json:"data"`
	RequestID string `json:"requestId"`
}

func writeError(r *ghttp.Request, err error) {
	status, code, message := 500, "internal_error", "操作失败，请使用请求标识查询服务日志"
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		status, code, message = apiErr.Status, apiErr.Code, apiErr.Message
	} else if errors.Is(err, context.DeadlineExceeded) {
		status, code, message = 408, "timeout", "操作超时"
	} else if errors.Is(err, context.Canceled) {
		status, code, message = 409, "canceled", "操作已取消"
	} else if gerror.Code(err) == gcode.CodeValidationFailed || gerror.Code(err) == gcode.CodeInvalidParameter {
		status, code, message = 400, "invalid_request", "请求参数无效"
	}
	r.Response.WriteHeader(status)
	r.Response.WriteJson(Envelope{code, message, nil, RequestID(r.Context())})
}
func responseMiddleware(r *ghttp.Request) {
	r.Middleware.Next()
	if err := r.GetError(); err != nil {
		writeError(r, err)
		return
	}
	if r.Response.Status == http.StatusNoContent {
		return
	}
	if r.Response.BufferLength() > 0 || r.Response.Header().Get("Content-Type") == "application/octet-stream" || r.Response.Header().Get("Content-Type") == "application/x-ndjson" {
		return
	}
	r.Response.WriteJson(Envelope{"ok", "", r.GetHandlerResponse(), RequestID(r.Context())})
}

type rateWindow struct {
	start time.Time
	count int
}

func (a *App) middleware() ghttp.HandlerFunc {
	var rateMu sync.Mutex
	rates := map[string]rateWindow{}
	requestSlots := make(chan struct{}, a.Config.MaxConcurrentRequests)
	return func(r *ghttp.Request) {
		started := time.Now()
		r.SetCtx(context.WithValue(r.Context(), requestIDKey{}, NewID()))
		r.Response.Header().Set("X-Request-ID", RequestID(r.Context()))
		r.Response.Header().Set("X-Content-Type-Options", "nosniff")
		r.Response.Header().Set("Cache-Control", "no-store")
		r.Response.Header().Set("Referrer-Policy", "no-referrer")
		path := r.URL.Path
		source := r.Header.Get("X-RightData-Source")
		switch source {
		case "workbench", "report", "dashboard", "h5", "import", "export":
		default:
			source = "api"
		}
		r.SetCtx(context.WithValue(r.Context(), querySourceKey{}, source))
		if path != "/api" && !strings.HasPrefix(path, "/api/") {
			r.Response.WriteStatus(404)
			return
		}
		select {
		case requestSlots <- struct{}{}:
			defer func() { <-requestSlots }()
		default:
			writeError(r, Error(429, "server_busy", "当前请求较多，请稍后重试"))
			return
		}
		limit := a.Config.MaxUploadBytes + (1 << 20)
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
			limit = 2 << 20
		}
		if r.ContentLength > limit {
			writeError(r, Error(413, "payload_too_large", "请求内容超过大小限制"))
			return
		}
		r.Request.Body = http.MaxBytesReader(r.Response.Writer, r.Request.Body, limit)
		defer func() {
			if r.MultipartForm != nil {
				_ = r.MultipartForm.RemoveAll()
			}
		}()
		if path == "/api/v1/auth/login" || path == "/api/v1/auth/refresh" {
			host, _, _ := net.SplitHostPort(r.RemoteAddr)
			rateMu.Lock()
			now := time.Now()
			v := rates[host]
			if now.Sub(v.start) > time.Minute {
				v = rateWindow{start: now}
			}
			v.count++
			rates[host] = v
			if len(rates) > 4096 {
				for k, w := range rates {
					if now.Sub(w.start) > time.Minute {
						delete(rates, k)
					}
				}
			}
			rateMu.Unlock()
			if v.count > 30 {
				writeError(r, Error(429, "rate_limit", "请求过于频繁，请稍后再试"))
				return
			}
		}
		public := path == "/api/probe" || path == "/api/v1/auth/login" || path == "/api/v1/auth/refresh" || path == "/api/docs/session"
		docs := path == "/api/api.json" || path == "/api/swagger" || strings.HasPrefix(path, "/api/swagger/")
		if !public {
			var ctx context.Context
			var err error
			auth := r.Header.Get("Authorization")
			if strings.HasPrefix(auth, "Bearer ") {
				ctx, err = a.authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "))
			} else if docs {
				cookie, e := r.Cookie.Get("rd_docs").String(), error(nil)
				if cookie == "" {
					e = Error(401, "unauthenticated", "请先登录")
				}
				if e != nil {
					err = e
				} else {
					ctx, err = a.documentUser(r.Context(), cookie)
				}
			} else {
				err = Error(401, "unauthenticated", "请先登录")
			}
			if err != nil {
				writeError(r, err)
				return
			}
			if docs && !HasPermission(CurrentUser(ctx), "docs.read") {
				writeError(r, Error(403, "forbidden", "没有接口文档查看权限"))
				return
			}
			r.SetCtx(ctx)
		}
		if r.ContentLength > a.Config.MaxUploadBytes+(1<<20) {
			writeError(r, Error(413, "payload_too_large", "上传内容超过大小限制"))
			return
		}
		r.Middleware.Next()
		if !public && !docs {
			userID := ""
			if u := CurrentUser(r.Context()); u != nil {
				userID = u.ID
			}
			outcome := "ok"
			if r.GetError() != nil || r.Response.Status >= 400 {
				outcome = "failed"
			}
			a.Audit(r.Context(), userID, "access", r.Method, path, outcome, time.Since(started))
		}
	}
}

func NewServer(a *App) *ghttp.Server {
	s := ghttp.GetServer("rightdata-" + NewID())
	s.SetAddr(a.Config.Address)
	s.SetDumpRouterMap(false)
	s.SetAccessLogEnabled(false)
	s.SetErrorLogEnabled(false)
	s.SetClientMaxBodySize(a.Config.MaxUploadBytes + (1 << 20))
	s.SetReadTimeout(60 * time.Second)
	s.SetWriteTimeout(a.Config.TaskTimeout)
	s.SetIdleTimeout(60 * time.Second)
	s.SetOpenApiPath("/api/api.json")
	s.SetSwaggerPath("/api/swagger")
	s.SetSwaggerUITemplate(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>RightData API</title><link rel="stylesheet" href="/api/swagger/assets/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/api/swagger/assets/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/api/api.json",dom_id:"#swagger-ui",persistAuthorization:false,validatorUrl:null});</script></body></html>`)
	s.GetOpenApi().Info.Title = "RightData Data Service"
	s.GetOpenApi().Info.Version = "1.0.0"
	s.GetOpenApi().Components.SecuritySchemes = goai.SecuritySchemes{"BearerAuth": {Value: &goai.SecurityScheme{Type: "http", Scheme: "bearer"}}}
	s.GetOpenApi().Security = &goai.SecurityRequirements{{"BearerAuth": {}}}
	s.BindMiddleware("/*", a.middleware())
	s.BindHandler("GET:/api/swagger/assets/{name}", func(r *ghttp.Request) {
		name := r.Get("name").String()
		if name != "swagger-ui-bundle.js" && name != "swagger-ui.css" {
			r.Response.WriteStatus(404)
			return
		}
		data, e := swaggerAssets.ReadFile("assets/" + name)
		if e != nil {
			r.Response.WriteStatus(404)
			return
		}
		ct := "text/javascript; charset=utf-8"
		if strings.HasSuffix(name, ".css") {
			ct = "text/css; charset=utf-8"
		}
		r.Response.Header().Set("Content-Type", ct)
		r.Response.Write(data)
	})
	s.Group("/", func(group *ghttp.RouterGroup) {
		group.Middleware(responseMiddleware)
		group.Bind(&SystemController{App: a}, &AuthController{App: a}, &ConfigController{App: a}, &DataController{App: a}, &FilesController{App: a}, &JobsController{App: a}, &ResourceController{App: a}, &ScreensController{App: a}, &UpdatesController{App: a})
	})
	return s
}

type SystemController struct{ App *App }
type ProbeReq struct {
	g.Meta `path:"/api/probe" method:"get" tags:"运行状态" summary:"登录前最小服务探测"`
}
type ProbeRes struct {
	Service    string `json:"service"`
	InstanceID string `json:"instanceId"`
	APIVersion string `json:"apiVersion"`
	Ready      bool   `json:"ready"`
}

func (c *SystemController) Probe(ctx context.Context, r *ProbeReq) (*ProbeRes, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	err := c.App.DB.PingContext(ctx)
	return &ProbeRes{"RightData", c.App.InstanceID, "1", err == nil}, nil
}

type HealthReq struct {
	g.Meta `path:"/api/v1/health" method:"get" tags:"运行状态" summary:"受保护的运行详情"`
}
type HealthRes struct {
	ProbeRes
	Engine             string `json:"engine"`
	MaxUploadBytes     int64  `json:"maxUploadBytes"`
	MaxResultRows      int    `json:"maxResultRows"`
	MaxConcurrentTasks int    `json:"maxConcurrentTasks"`
}

func (c *SystemController) Health(ctx context.Context, r *HealthReq) (*HealthRes, error) {
	if _, err := Require(ctx, "system.manage"); err != nil {
		return nil, err
	}
	p, _ := c.Probe(ctx, &ProbeReq{})
	return &HealthRes{*p, c.App.EngineVersion, c.App.Config.MaxUploadBytes, c.App.Config.MaxResultRows, c.App.Config.MaxConcurrentTasks}, nil
}

type DocSessionReq struct {
	g.Meta `path:"/api/docs/session" method:"post" tags:"认证" summary:"以一次性票据建立仅限文档的会话"`
	Ticket string `json:"ticket" v:"required|length:1,128"`
}

func (c *SystemController) DocSession(ctx context.Context, r *DocSessionReq) (*Empty, error) {
	a := c.App
	a.authMu.Lock()
	defer a.authMu.Unlock()
	var sessionID, userID string
	err := a.DB.QueryRowContext(ctx, `SELECT t.session_id,s.user_id FROM doc_tickets t JOIN sessions s ON s.id=t.session_id WHERE t.hash=? AND NOT t.used AND t.expires_at>? AND NOT s.revoked AND s.refresh_expires>?`, tokenHash(r.Ticket), time.Now().UTC(), time.Now().UTC()).Scan(&sessionID, &userID)
	if err != nil {
		return nil, Error(401, "invalid_ticket", "票据已失效")
	}
	u, err := a.UserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !HasPermission(u, "docs.read") {
		return nil, Error(403, "forbidden", "没有接口文档查看权限")
	}
	token := NewID()
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "UPDATE doc_tickets SET used=true WHERE hash=?", tokenHash(r.Ticket)); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO doc_sessions VALUES (?,?,?)", tokenHash(token), sessionID, time.Now().UTC().Add(10*time.Minute)); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	req := g.RequestFromCtx(ctx)
	http.SetCookie(req.Response.Writer, &http.Cookie{Name: "rd_docs", Value: token, Path: "/api", HttpOnly: true, Secure: a.Config.CookieSecure, SameSite: http.SameSiteStrictMode, MaxAge: 600})
	return &Empty{}, nil
}
