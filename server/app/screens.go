package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime/multipart"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type screenVersionRecord struct {
	ScreenVersion
	Path      string
	CreatedBy string
}

const screenVersionColumns = `v.screen_id,v.version,v.manifest,v.path,v.size,v.sha256,v.created_by,v.created_at`

type screenRowScanner interface{ Scan(...any) error }

func scanScreenVersion(row screenRowScanner) (screenVersionRecord, error) {
	var item screenVersionRecord
	var screenID, version, manifest string
	if err := row.Scan(&screenID, &version, &manifest, &item.Path, &item.SizeBytes, &item.SHA256, &item.CreatedBy, &item.CreatedAt); err != nil {
		return item, err
	}
	if json.Unmarshal([]byte(manifest), &item.ScreenManifest) != nil || item.ScreenID != screenID || item.Version != version || item.ContainerAPIVersion != ScreenContainerAPIVersion || item.SizeBytes <= 0 || len(item.SHA256) != 64 {
		return item, Error(500, "invalid_screen_record", "大屏版本记录无效")
	}
	item.CreatedAt = item.CreatedAt.UTC()
	item.DownloadURL = "/api/v1/screens/" + url.PathEscape(screenID) + "/versions/" + url.PathEscape(version) + "/download"
	return item, nil
}

func (a *App) screensDir() string { return filepath.Join(a.Config.DataDir, "screens") }

func requireScreenManager(user *User) error {
	if user == nil || user.Disabled {
		return Error(401, "unauthenticated", "请先登录")
	}
	if !HasPermission(user, "config.write") {
		return Error(403, "forbidden", "没有大屏管理权限")
	}
	return nil
}

// The system database has one connection. A mutation checks both current authority
// and the resource in its transaction, without trying to acquire authMu afterward.
func checkScreenMutation(ctx context.Context, tx *sql.Tx, actorID, screenID string) error {
	var permissions string
	var disabled bool
	err := tx.QueryRowContext(ctx, `SELECT permissions,disabled FROM users WHERE id=?`, actorID).Scan(&permissions, &disabled)
	if errors.Is(err, sql.ErrNoRows) || disabled {
		return Error(401, "unauthenticated", "用户会话已失效")
	}
	if err != nil {
		return err
	}
	user := &User{ID: actorID}
	if json.Unmarshal([]byte(permissions), &user.Permissions) != nil || !HasPermission(user, "config.write") {
		return Error(403, "forbidden", "没有大屏管理权限")
	}
	var kind string
	err = tx.QueryRowContext(ctx, `SELECT kind FROM configs WHERE id=?`, screenID).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return Error(404, "resource_not_found", "资源不存在")
	}
	if err != nil {
		return err
	}
	if kind != "screen" {
		return Error(409, "screen_resource_required", "目标资源不是数据大屏")
	}
	return nil
}

func (a *App) screenConfig(ctx context.Context, id string) error {
	cfg, _, err := a.resource(ctx, id)
	if err != nil {
		return err
	}
	if cfg.Kind != "screen" {
		return Error(409, "screen_resource_required", "目标资源不是数据大屏")
	}
	return nil
}

type screenContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r screenContextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}

func (a *App) openScreenFile(ctx context.Context, item screenVersionRecord, verifyDigest bool) (*os.File, error) {
	if !pathWithin(a.screensDir(), item.Path) || requireRegularFile(item.Path) != nil {
		return nil, Error(503, "screen_file_unavailable", "大屏资源包暂不可用")
	}
	file, err := os.Open(item.Path)
	if err != nil {
		return nil, Error(503, "screen_file_unavailable", "大屏资源包暂不可用")
	}
	info, statErr := file.Stat()
	pathInfo, pathErr := os.Lstat(item.Path)
	if statErr != nil || pathErr != nil || !info.Mode().IsRegular() || !pathInfo.Mode().IsRegular() || !os.SameFile(info, pathInfo) || info.Size() != item.SizeBytes {
		file.Close()
		return nil, Error(503, "screen_file_unavailable", "大屏资源包暂不可用")
	}
	if verifyDigest {
		hash := sha256.New()
		n, copyErr := io.Copy(hash, screenContextReader{ctx, io.LimitReader(file, item.SizeBytes+1)})
		if copyErr != nil {
			file.Close()
			return nil, copyErr
		}
		if n != item.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != item.SHA256 {
			file.Close()
			return nil, Error(503, "screen_file_unavailable", "大屏资源包完整性校验失败")
		}
		if _, err = file.Seek(0, io.SeekStart); err != nil {
			file.Close()
			return nil, err
		}
	}
	return file, nil
}

func (a *App) UploadScreenVersion(ctx context.Context, user *User, screenID string, upload *multipart.FileHeader) (ScreenVersion, error) {
	if err := requireScreenManager(user); err != nil {
		return ScreenVersion{}, err
	}
	if err := a.screenConfig(ctx, screenID); err != nil {
		return ScreenVersion{}, err
	}
	maxBytes := ScreenMaxArchiveBytes
	if a.Config.MaxUploadBytes > 0 && a.Config.MaxUploadBytes < maxBytes {
		maxBytes = a.Config.MaxUploadBytes
	}
	temporary, size, digest, err := copyUploadToTemp(upload, a.screensDir(), ".zip", maxBytes)
	if err != nil {
		return ScreenVersion{}, err
	}
	keepFile := false
	defer func() {
		if !keepFile {
			_ = os.Remove(temporary)
		}
	}()
	manifest, err := ValidateScreenBundle(ctx, temporary, screenID)
	if err != nil {
		return ScreenVersion{}, err
	}
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return ScreenVersion{}, err
	}
	defer tx.Rollback()
	if err = checkScreenMutation(ctx, tx, user.ID, screenID); err != nil {
		return ScreenVersion{}, err
	}
	existing, err := scanScreenVersion(tx.QueryRowContext(ctx, `SELECT `+screenVersionColumns+` FROM screen_versions v WHERE screen_id=? AND version=?`, screenID, manifest.Version))
	if err == nil {
		if existing.SHA256 != digest || existing.SizeBytes != size {
			return ScreenVersion{}, Error(409, "screen_version_exists", "该大屏版本已经存在且内容不同")
		}
		file, openErr := a.openScreenFile(ctx, existing, true)
		if openErr != nil {
			return ScreenVersion{}, openErr
		}
		file.Close()
		return existing.ScreenVersion, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ScreenVersion{}, err
	}
	path := filepath.Join(a.screensDir(), NewID()+".zip")
	if err = persistScreenBundle(temporary, path); err != nil {
		return ScreenVersion{}, Error(500, "storage_unavailable", "保存大屏资源包失败")
	}
	temporary = path
	createdAt := time.Now().UTC().Truncate(time.Microsecond)
	encoded, _ := json.Marshal(manifest)
	_, err = tx.ExecContext(ctx, `INSERT INTO screen_versions(screen_id,version,manifest,path,size,sha256,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)`, screenID, manifest.Version, string(encoded), path, size, digest, user.ID, createdAt)
	if err != nil {
		return ScreenVersion{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?)`, NewID(), createdAt, user.ID, "screen", "upload", screenID+":"+manifest.Version, "success", 0, RequestID(ctx)); err != nil {
		return ScreenVersion{}, err
	}
	// A failed COMMIT may have an unknown outcome. Preserve the immutable file in
	// that case; deleting a potentially committed version would break its receipt.
	keepFile = true
	if err = tx.Commit(); err != nil {
		return ScreenVersion{}, err
	}
	return ScreenVersion{ScreenManifest: manifest, SHA256: digest, SizeBytes: size, CreatedAt: createdAt, DownloadURL: "/api/v1/screens/" + url.PathEscape(screenID) + "/versions/" + manifest.Version + "/download"}, nil
}

func (a *App) screenPublication(ctx context.Context, screenID string) (ScreenPublication, error) {
	var publication ScreenPublication
	var version, manifest, path, digest, actor string
	var size int64
	var createdAt, publishedAt time.Time
	err := a.DB.QueryRowContext(ctx, `SELECT v.version,v.manifest,v.path,v.size,v.sha256,v.created_by,v.created_at,p.revision,p.published_at FROM screen_publications p JOIN screen_versions v ON v.screen_id=p.screen_id AND v.version=p.version WHERE p.screen_id=?`, screenID).
		Scan(&version, &manifest, &path, &size, &digest, &actor, &createdAt, &publication.PublishRevision, &publishedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return publication, nil
	}
	if err != nil {
		return publication, err
	}
	var content ScreenManifest
	if json.Unmarshal([]byte(manifest), &content) != nil || content.ScreenID != screenID || content.Version != version || content.ContainerAPIVersion != ScreenContainerAPIVersion || publication.PublishRevision < 1 {
		return publication, Error(500, "invalid_screen_record", "大屏发布记录无效")
	}
	item := screenVersionRecord{ScreenVersion: ScreenVersion{ScreenManifest: content, SHA256: digest, SizeBytes: size, CreatedAt: createdAt.UTC(), DownloadURL: "/api/v1/screens/" + url.PathEscape(screenID) + "/versions/" + url.PathEscape(version) + "/download"}, Path: path, CreatedBy: actor}
	file, err := a.openScreenFile(ctx, item, false)
	if err != nil {
		return publication, err
	}
	file.Close()
	publication.PublishedVersion = &item.ScreenVersion
	publishedAt = publishedAt.UTC()
	publication.PublishedAt = &publishedAt
	return publication, nil
}

func (a *App) ListScreenVersions(ctx context.Context, user *User, screenID string, limit, offset int) ([]ScreenVersion, ScreenPublication, error) {
	if err := requireScreenManager(user); err != nil {
		return nil, ScreenPublication{}, err
	}
	if err := a.screenConfig(ctx, screenID); err != nil {
		return nil, ScreenPublication{}, err
	}
	if limit == 0 {
		limit = 20
	}
	if limit < 0 || limit > 100 || offset < 0 {
		return nil, ScreenPublication{}, Error(400, "invalid_page", "分页参数无效")
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT `+screenVersionColumns+` FROM screen_versions v WHERE screen_id=? ORDER BY CAST(split_part(version,'.',1) AS UBIGINT) DESC,CAST(split_part(version,'.',2) AS UBIGINT) DESC,CAST(split_part(version,'.',3) AS UBIGINT) DESC LIMIT ? OFFSET ?`, screenID, limit, offset)
	if err != nil {
		return nil, ScreenPublication{}, err
	}
	items := []ScreenVersion{}
	for rows.Next() {
		item, scanErr := scanScreenVersion(rows)
		if scanErr != nil {
			rows.Close()
			return nil, ScreenPublication{}, scanErr
		}
		items = append(items, item.ScreenVersion)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, ScreenPublication{}, err
	}
	publication, err := a.screenPublication(ctx, screenID)
	return items, publication, err
}

func (a *App) PublishScreen(ctx context.Context, user *User, screenID, version string, expectedRevision int64, idempotencyKey string) (ScreenPublication, error) {
	if err := requireScreenManager(user); err != nil {
		return ScreenPublication{}, err
	}
	if _, err := parseStableSemver(version); err != nil {
		return ScreenPublication{}, err
	}
	if expectedRevision < 0 || expectedRevision == math.MaxInt64 {
		return ScreenPublication{}, Error(400, "invalid_revision", "发布修订号无效")
	}
	if strings.TrimSpace(idempotencyKey) == "" || len(idempotencyKey) > 200 {
		return ScreenPublication{}, Error(400, "idempotency_required", "需要有效的 Idempotency-Key")
	}
	requestBody, _ := json.Marshal(struct {
		ScreenID         string
		Version          string
		ExpectedRevision int64
	}{screenID, version, expectedRevision})
	fingerprint := tokenHash(string(requestBody))
	key := "screen-publish:" + user.ID + ":" + idempotencyKey
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return ScreenPublication{}, err
	}
	defer tx.Rollback()
	if err = checkScreenMutation(ctx, tx, user.ID, screenID); err != nil {
		return ScreenPublication{}, err
	}
	var previousFingerprint, previousResult string
	err = tx.QueryRowContext(ctx, `SELECT fingerprint,result FROM _rd_operations WHERE key=?`, key).Scan(&previousFingerprint, &previousResult)
	if err == nil {
		if previousFingerprint != fingerprint {
			return ScreenPublication{}, Error(409, "idempotency_conflict", "同一幂等标识不能用于不同请求")
		}
		var previous ScreenPublication
		if json.Unmarshal([]byte(previousResult), &previous) != nil {
			return ScreenPublication{}, Error(500, "invalid_operation", "操作记录不可读")
		}
		return previous, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ScreenPublication{}, err
	}
	var revision int64
	err = tx.QueryRowContext(ctx, `SELECT revision FROM screen_publications WHERE screen_id=?`, screenID).Scan(&revision)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return ScreenPublication{}, err
	}
	if revision != expectedRevision {
		return ScreenPublication{}, Error(409, "version_conflict", "发布版本已更新，请重新读取后操作")
	}
	item, err := scanScreenVersion(tx.QueryRowContext(ctx, `SELECT `+screenVersionColumns+` FROM screen_versions v WHERE screen_id=? AND version=?`, screenID, version))
	if errors.Is(err, sql.ErrNoRows) {
		return ScreenPublication{}, Error(404, "screen_version_not_found", "大屏版本不存在")
	}
	if err != nil {
		return ScreenPublication{}, err
	}
	file, err := a.openScreenFile(ctx, item, true)
	if err != nil {
		return ScreenPublication{}, err
	}
	file.Close()
	now := time.Now().UTC().Truncate(time.Microsecond)
	result := ScreenPublication{PublishedVersion: &item.ScreenVersion, PublishRevision: revision + 1, PublishedAt: &now}
	_, err = tx.ExecContext(ctx, `INSERT INTO screen_publications(screen_id,version,revision,published_by,published_at) VALUES(?,?,?,?,?) ON CONFLICT(screen_id) DO UPDATE SET version=excluded.version,revision=excluded.revision,published_by=excluded.published_by,published_at=excluded.published_at`, screenID, version, result.PublishRevision, user.ID, now)
	if err != nil {
		return ScreenPublication{}, err
	}
	encoded, _ := json.Marshal(result)
	if _, err = tx.ExecContext(ctx, `INSERT INTO _rd_operations VALUES(?,?,?,?,?)`, key, user.ID, fingerprint, string(encoded), now); err != nil {
		return ScreenPublication{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?)`, NewID(), now, user.ID, "screen", "publish", screenID+":"+version, "success", 0, RequestID(ctx)); err != nil {
		return ScreenPublication{}, err
	}
	if err = tx.Commit(); err != nil {
		return ScreenPublication{}, err
	}
	return result, nil
}

func (a *App) screenVersionForDownload(ctx context.Context, screenID, version string) (screenVersionRecord, error) {
	user, err := authenticatedUser(ctx)
	if err != nil {
		return screenVersionRecord{}, err
	}
	if _, err = parseStableSemver(version); err != nil {
		return screenVersionRecord{}, err
	}
	if HasPermission(user, "config.write") {
		if err = a.screenConfig(ctx, screenID); err != nil {
			return screenVersionRecord{}, err
		}
	} else {
		cfg, _, viewErr := a.visibleResource(ctx, screenID)
		if viewErr != nil {
			return screenVersionRecord{}, viewErr
		}
		if cfg.Kind != "screen" {
			return screenVersionRecord{}, Error(404, "resource_not_found", "资源不存在")
		}
		publication, pubErr := a.screenPublication(ctx, screenID)
		if pubErr != nil {
			return screenVersionRecord{}, pubErr
		}
		if publication.PublishedVersion == nil || publication.PublishedVersion.Version != version {
			return screenVersionRecord{}, Error(404, "screen_version_not_published", "该版本不是当前发布版本")
		}
	}
	item, err := scanScreenVersion(a.DB.QueryRowContext(ctx, `SELECT `+screenVersionColumns+` FROM screen_versions v WHERE screen_id=? AND version=?`, screenID, version))
	if errors.Is(err, sql.ErrNoRows) {
		return item, Error(404, "screen_version_not_found", "大屏版本不存在")
	}
	return item, err
}
