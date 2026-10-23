package app

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/gogf/gf/v2/frame/g"
)

const passwordIterations = 210000

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, 32)
	if err != nil {
		return "", err
	}
	return "pbkdf2-sha256$" + base64.StdEncoding.EncodeToString(salt) + "$" + base64.StdEncoding.EncodeToString(key), nil
}
func verifyPassword(hash, password string) bool {
	parts := strings.Split(hash, "$")
	if len(parts) != 3 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	salt, e := base64.StdEncoding.DecodeString(parts[1])
	if e != nil {
		return false
	}
	want, e := base64.StdEncoding.DecodeString(parts[2])
	if e != nil {
		return false
	}
	key, e := pbkdf2.Key(sha256.New, password, salt, passwordIterations, 32)
	return e == nil && subtle.ConstantTimeCompare(want, key) == 1
}
func (a *App) UserByID(ctx context.Context, id string) (*User, error) {
	u := &User{}
	var permissions string
	err := a.DB.QueryRowContext(ctx, "SELECT id,username,permissions,disabled FROM users WHERE id=?", id).Scan(&u.ID, &u.Username, &permissions, &u.Disabled)
	if err != nil || u.Disabled {
		return nil, Error(401, "unauthenticated", "登录已失效")
	}
	if json.Unmarshal([]byte(permissions), &u.Permissions) != nil {
		return nil, Error(401, "unauthenticated", "登录已失效")
	}
	return u, nil
}

type sessionContextKey struct{}

func (a *App) authenticate(ctx context.Context, token string) (context.Context, error) {
	var id, user string
	err := a.DB.QueryRowContext(ctx, "SELECT id,user_id FROM sessions WHERE access_hash=? AND NOT revoked AND access_expires>?", tokenHash(token), time.Now().UTC()).Scan(&id, &user)
	if err != nil {
		return ctx, Error(401, "unauthenticated", "登录已失效")
	}
	u, err := a.UserByID(ctx, user)
	if err != nil {
		return ctx, err
	}
	return context.WithValue(WithUser(ctx, u), sessionContextKey{}, id), nil
}

type AuthController struct{ App *App }
type LoginReq struct {
	g.Meta   `path:"/api/v1/auth/login" method:"post" tags:"认证" summary:"登录"`
	Username string `json:"username" v:"required|length:1,100"`
	Password string `json:"password" v:"required|length:1,256"`
	Remember *bool  `json:"remember"`
}
type SessionResult struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int    `json:"expiresIn"`
	User         *User  `json:"user"`
}

func (c *AuthController) Login(ctx context.Context, r *LoginReq) (*SessionResult, error) {
	a := c.App
	a.authMu.Lock()
	defer a.authMu.Unlock()
	var id, hash string
	err := a.DB.QueryRowContext(ctx, "SELECT id,password_hash FROM users WHERE username=? AND NOT disabled", r.Username).Scan(&id, &hash)
	// Hash work also runs for an unknown account, avoiding a fast username oracle.
	if err != nil {
		hash = "pbkdf2-sha256$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	}
	valid := verifyPassword(hash, r.Password)
	if err != nil || !valid {
		a.Audit(ctx, "", "auth", "login", "", "denied", 0)
		return nil, Error(401, "invalid_credentials", "用户名或密码错误")
	}
	u, err := a.UserByID(ctx, id)
	if err != nil {
		return nil, err
	}
	result := &SessionResult{NewID(), NewID(), 900, u}
	days := 30
	if r.Remember != nil && !*r.Remember {
		days = 1
	}
	_, err = a.DB.ExecContext(ctx, "INSERT INTO sessions VALUES (?,?,?,?,?,?,false)", NewID(), id, tokenHash(result.AccessToken), tokenHash(result.RefreshToken), time.Now().UTC().Add(15*time.Minute), time.Now().UTC().Add(time.Duration(days)*24*time.Hour))
	outcome := "ok"
	if err != nil {
		outcome = "failed"
	}
	a.Audit(ctx, id, "auth", "login", id, outcome, 0)
	return result, err
}

type RefreshReq struct {
	g.Meta       `path:"/api/v1/auth/refresh" method:"post" tags:"认证" summary:"轮换会话恢复凭据"`
	RefreshToken string `json:"refreshToken" v:"required|length:1,128"`
}

func (c *AuthController) Refresh(ctx context.Context, r *RefreshReq) (*SessionResult, error) {
	a := c.App
	a.authMu.Lock()
	defer a.authMu.Unlock()
	var id, userID string
	err := a.DB.QueryRowContext(ctx, "SELECT id,user_id FROM sessions WHERE refresh_hash=? AND NOT revoked AND refresh_expires>?", tokenHash(r.RefreshToken), time.Now().UTC()).Scan(&id, &userID)
	if err != nil {
		return nil, Error(401, "unauthenticated", "会话恢复凭据已失效")
	}
	u, err := a.UserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	result := &SessionResult{NewID(), NewID(), 900, u}
	_, err = a.DB.ExecContext(ctx, "UPDATE sessions SET access_hash=?,refresh_hash=?,access_expires=? WHERE id=?", tokenHash(result.AccessToken), tokenHash(result.RefreshToken), time.Now().UTC().Add(15*time.Minute), id)
	return result, err
}

type LogoutReq struct {
	g.Meta `path:"/api/v1/auth/logout" method:"post" tags:"认证" summary:"注销当前业务会话"`
}
type Empty struct{}

func (c *AuthController) Logout(ctx context.Context, r *LogoutReq) (*Empty, error) {
	id, _ := ctx.Value(sessionContextKey{}).(string)
	_, err := c.App.DB.ExecContext(ctx, "UPDATE sessions SET revoked=true WHERE id=?", id)
	return &Empty{}, err
}

type MeReq struct {
	g.Meta `path:"/api/v1/auth/me" method:"get" tags:"认证" summary:"当前用户"`
}
type MeRes struct {
	*User
	AuthzRevision string `json:"authzRevision"`
}

func (c *AuthController) Me(ctx context.Context, r *MeReq) (*MeRes, error) {
	current := CurrentUser(ctx)
	if current == nil {
		return nil, Error(401, "unauthenticated", "请先登录")
	}
	c.App.authMu.Lock()
	defer c.App.authMu.Unlock()
	user, err := c.App.UserByID(ctx, current.ID)
	if err != nil {
		return nil, err
	}
	revision, err := c.App.AuthorizationRevision(ctx)
	if err != nil {
		return nil, err
	}
	return &MeRes{User: user, AuthzRevision: revision}, nil
}

type ChangePasswordReq struct {
	g.Meta      `path:"/api/v1/auth/password" method:"put" tags:"认证" summary:"修改密码并撤销所有会话"`
	OldPassword string `json:"oldPassword" v:"required"`
	NewPassword string `json:"newPassword" v:"required|length:12,256"`
}

func (c *AuthController) ChangePassword(ctx context.Context, r *ChangePasswordReq) (*Empty, error) {
	a := c.App
	a.authMu.Lock()
	defer a.authMu.Unlock()
	u := CurrentUser(ctx)
	var hash string
	if err := a.DB.QueryRowContext(ctx, "SELECT password_hash FROM users WHERE id=?", u.ID).Scan(&hash); err != nil {
		return nil, err
	}
	if !verifyPassword(hash, r.OldPassword) {
		return nil, Error(403, "invalid_password", "原密码不正确")
	}
	hash, err := hashPassword(r.NewPassword)
	if err != nil {
		return nil, err
	}
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "UPDATE users SET password_hash=? WHERE id=?", hash, u.ID); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE sessions SET revoked=true WHERE user_id=?", u.ID); err != nil {
		return nil, err
	}
	return &Empty{}, tx.Commit()
}

type UsersReq struct {
	g.Meta `path:"/api/v1/users" method:"get" tags:"系统管理" summary:"用户列表"`
}
type UsersRes struct {
	Items []*User `json:"items"`
}

func (c *AuthController) Users(ctx context.Context, r *UsersReq) (*UsersRes, error) {
	if _, err := Require(ctx, "users.manage"); err != nil {
		return nil, err
	}
	rows, err := c.App.DB.QueryContext(ctx, "SELECT id,username,permissions,disabled FROM users ORDER BY username")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := &UsersRes{Items: []*User{}}
	for rows.Next() {
		u := &User{}
		var p string
		if err = rows.Scan(&u.ID, &u.Username, &p, &u.Disabled); err != nil {
			return nil, err
		}
		json.Unmarshal([]byte(p), &u.Permissions)
		res.Items = append(res.Items, u)
	}
	return res, rows.Err()
}

type SaveUserReq struct {
	g.Meta      `path:"/api/v1/users" method:"post" tags:"系统管理" summary:"创建用户"`
	Username    string   `json:"username" v:"required|length:1,100"`
	Password    string   `json:"password" v:"required|length:12,256"`
	Permissions []string `json:"permissions"`
}

func (c *AuthController) CreateUser(ctx context.Context, r *SaveUserReq) (*User, error) {
	if _, err := Require(ctx, "users.manage"); err != nil {
		return nil, err
	}
	if len(r.Permissions) > 100 {
		return nil, Error(400, "invalid_permissions", "权限数量超限")
	}
	u := &User{ID: NewID(), Username: r.Username, Permissions: r.Permissions}
	hash, err := hashPassword(r.Password)
	if err != nil {
		return nil, err
	}
	p, _ := json.Marshal(r.Permissions)
	_, err = c.App.DB.ExecContext(ctx, "INSERT INTO users VALUES (?,?,?,?,false,?)", u.ID, u.Username, hash, string(p), time.Now().UTC())
	if err != nil {
		return nil, Error(409, "user_conflict", "用户已存在或内容无效")
	}
	return u, nil
}

type UpdateUserReq struct {
	g.Meta      `path:"/api/v1/users/{id}" method:"put" tags:"系统管理" summary:"更新用户授权及启用状态"`
	ID          string   `json:"id" in:"path"`
	Permissions []string `json:"permissions"`
	Disabled    bool     `json:"disabled"`
}

func (c *AuthController) UpdateUser(ctx context.Context, r *UpdateUserReq) (*Empty, error) {
	u, err := Require(ctx, "users.manage")
	if err != nil {
		return nil, err
	}
	if u.ID == r.ID {
		return nil, Error(409, "self_admin_change", "不能通过此接口撤销自己的管理权限")
	}
	p, _ := json.Marshal(r.Permissions)
	c.App.authMu.Lock()
	defer c.App.authMu.Unlock()
	tx, err := c.App.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, "UPDATE users SET permissions=?,disabled=? WHERE id=?", string(p), r.Disabled, r.ID)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, Error(404, "user_not_found", "用户不存在")
	}
	if r.Disabled {
		if _, err = tx.ExecContext(ctx, "UPDATE sessions SET revoked=true WHERE user_id=?", r.ID); err != nil {
			return nil, err
		}
	}
	if err = bumpAuthorization(ctx, tx); err != nil {
		return nil, err
	}
	return &Empty{}, tx.Commit()
}

type DocTicketReq struct {
	g.Meta `path:"/api/v1/auth/document-ticket" method:"post" tags:"认证" summary:"申请一次性文档访问票据"`
}
type DocTicketRes struct {
	Ticket    string `json:"ticket"`
	ExpiresIn int    `json:"expiresIn"`
}

func (c *AuthController) DocumentTicket(ctx context.Context, r *DocTicketReq) (*DocTicketRes, error) {
	if _, err := Require(ctx, "docs.read"); err != nil {
		return nil, err
	}
	ticket := NewID()
	id, _ := ctx.Value(sessionContextKey{}).(string)
	_, err := c.App.DB.ExecContext(ctx, "INSERT INTO doc_tickets VALUES (?,?,?,false)", tokenHash(ticket), id, time.Now().UTC().Add(time.Minute))
	return &DocTicketRes{ticket, 60}, err
}

func (a *App) documentUser(ctx context.Context, docToken string) (context.Context, error) {
	var userID, sessionID string
	err := a.DB.QueryRowContext(ctx, `SELECT s.user_id,s.id FROM doc_sessions d JOIN sessions s ON d.session_id=s.id WHERE d.hash=? AND d.expires_at>? AND s.refresh_expires>? AND NOT s.revoked`, tokenHash(docToken), time.Now().UTC(), time.Now().UTC()).Scan(&userID, &sessionID)
	if err != nil {
		return ctx, Error(401, "unauthenticated", "文档会话已失效")
	}
	u, err := a.UserByID(ctx, userID)
	if err != nil {
		return ctx, err
	}
	if !HasPermission(u, "docs.read") {
		return ctx, Error(403, "forbidden", "没有接口文档查看权限")
	}
	return context.WithValue(WithUser(ctx, u), sessionContextKey{}, sessionID), nil
}
