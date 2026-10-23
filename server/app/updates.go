package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	clientUpdatePlatform = "windows"
	clientUpdateArch     = "x64"
)

var stableSemverPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type stableSemver struct {
	major uint64
	minor uint64
	patch uint64
}

func parseStableSemver(value string) (stableSemver, error) {
	var parsed stableSemver
	if len(value) > 64 {
		return parsed, Error(400, "invalid_version", "版本必须是稳定的 SemVer 版本")
	}
	parts := stableSemverPattern.FindStringSubmatch(value)
	if parts == nil {
		return parsed, Error(400, "invalid_version", "版本必须是稳定的 SemVer 版本")
	}
	values := []*uint64{&parsed.major, &parsed.minor, &parsed.patch}
	for index, destination := range values {
		number, err := strconv.ParseUint(parts[index+1], 10, 64)
		if err != nil {
			return stableSemver{}, Error(400, "invalid_version", "版本必须是稳定的 SemVer 版本")
		}
		*destination = number
	}
	return parsed, nil
}

func (version stableSemver) compare(other stableSemver) int {
	left := [...]uint64{version.major, version.minor, version.patch}
	right := [...]uint64{other.major, other.minor, other.patch}
	for index := range left {
		if left[index] < right[index] {
			return -1
		}
		if left[index] > right[index] {
			return 1
		}
	}
	return 0
}

type ClientUpdate struct {
	ID          string    `json:"id"`
	Version     string    `json:"version"`
	Platform    string    `json:"platform"`
	Arch        string    `json:"arch"`
	Signature   string    `json:"signature"`
	SHA256      string    `json:"sha256"`
	Size        int64     `json:"size"`
	FileName    string    `json:"fileName"`
	DownloadURL string    `json:"downloadUrl"`
	PublishedAt time.Time `json:"publishedAt"`
}

type clientUpdateRecord struct {
	ClientUpdate
	Path        string
	PublisherID string
	Active      bool
	DisabledAt  sql.NullTime
}

func (a *App) updatesDir() string { return filepath.Join(a.Config.DataDir, "updates") }

func normalizeClientTarget(platform, arch string) (string, string, error) {
	platform = strings.ToLower(strings.TrimSpace(platform))
	arch = strings.ToLower(strings.TrimSpace(arch))
	if platform != clientUpdatePlatform || arch != clientUpdateArch {
		return "", "", Error(400, "unsupported_update_target", "仅支持 Windows x64 客户端更新")
	}
	return platform, arch, nil
}

func (a *App) PublishClientUpdate(ctx context.Context, publisher *User, fileID, version, signature, platform, arch string) (ClientUpdate, error) {
	if publisher == nil || !HasPermission(publisher, "system.manage") {
		return ClientUpdate{}, Error(403, "forbidden", "没有客户端更新发布权限")
	}
	if _, err := parseStableSemver(version); err != nil {
		return ClientUpdate{}, err
	}
	platform, arch, err := normalizeClientTarget(platform, arch)
	if err != nil {
		return ClientUpdate{}, err
	}
	if strings.TrimSpace(signature) == "" || len(signature) > 64<<10 {
		return ClientUpdate{}, Error(400, "invalid_signature", "更新签名不能为空且长度必须有效")
	}
	fileID = strings.TrimSpace(fileID)
	if fileID == "" {
		return ClientUpdate{}, Error(400, "file_required", "请选择更新安装包")
	}
	var existing string
	err = a.DB.QueryRowContext(ctx, `SELECT id FROM client_updates WHERE platform=? AND arch=? AND version=?`, platform, arch, version).Scan(&existing)
	if err == nil {
		return ClientUpdate{}, Error(409, "update_version_exists", "该平台与架构的版本已经发布")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ClientUpdate{}, err
	}

	source, err := a.storedFile(ctx, fileID)
	if err != nil {
		return ClientUpdate{}, err
	}
	if source.OwnerID != publisher.ID {
		return ClientUpdate{}, Error(403, "forbidden", "只能使用发布者自己的文件发布客户端更新")
	}
	if source.MediaType == importCSVMediaType {
		return ClientUpdate{}, Error(400, "invalid_update_file", "导入暂存文件不能作为客户端更新包")
	}
	if source.Size < 0 || requireRegularFile(source.Path) != nil {
		return ClientUpdate{}, Error(404, "file_missing", "更新源文件不可用")
	}
	input, err := os.Open(source.Path)
	if err != nil {
		return ClientUpdate{}, Error(404, "file_missing", "更新源文件不可用")
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return ClientUpdate{}, Error(404, "file_missing", "更新源文件不可用")
	}
	pathInfo, err := os.Lstat(source.Path)
	if err != nil || !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 || !os.SameFile(info, pathInfo) {
		return ClientUpdate{}, Error(409, "source_file_changed", "更新源文件内容已经变化，请重新上传后发布")
	}
	if err = ensurePrivateDir(a.updatesDir()); err != nil {
		return ClientUpdate{}, Error(500, "storage_unavailable", "客户端更新存储不可用")
	}
	id := NewID()
	temporary, err := os.CreateTemp(a.updatesDir(), ".publish-*")
	if err != nil {
		return ClientUpdate{}, Error(500, "storage_unavailable", "客户端更新存储不可用")
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err = temporary.Chmod(0o600); err != nil {
		return ClientUpdate{}, Error(500, "storage_unavailable", "客户端更新存储不可用")
	}
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(input, source.Size+1))
	if copyErr != nil {
		return ClientUpdate{}, Error(500, "storage_unavailable", "复制客户端更新包失败")
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if size != source.Size || !strings.EqualFold(digest, source.SHA256) {
		return ClientUpdate{}, Error(409, "source_file_changed", "更新源文件内容已经变化，请重新上传后发布")
	}
	if err = temporary.Sync(); err != nil {
		return ClientUpdate{}, Error(500, "storage_unavailable", "保存客户端更新包失败")
	}
	if err = temporary.Close(); err != nil {
		return ClientUpdate{}, Error(500, "storage_unavailable", "保存客户端更新包失败")
	}
	destination := filepath.Join(a.updatesDir(), id+".bin")
	if err = os.Rename(temporaryPath, destination); err != nil {
		return ClientUpdate{}, Error(500, "storage_unavailable", "保存客户端更新包失败")
	}
	temporaryPath = destination
	now := time.Now().UTC()
	result := ClientUpdate{
		ID: id, Version: version, Platform: platform, Arch: arch, Signature: signature,
		SHA256: digest, Size: size, FileName: source.Name,
		DownloadURL: "/api/v1/client-updates/" + id + "/download", PublishedAt: now,
	}
	_, err = a.DB.ExecContext(ctx, `INSERT INTO client_updates(id,version,platform,arch,signature,path,size,sha256,file_name,publisher_id,active,created_at,disabled_at) VALUES(?,?,?,?,?,?,?,?,?,?,true,?,NULL)`,
		id, version, platform, arch, signature, destination, size, digest, source.Name, publisher.ID, now)
	if err != nil {
		var duplicate string
		if queryErr := a.DB.QueryRowContext(ctx, `SELECT id FROM client_updates WHERE platform=? AND arch=? AND version=?`, platform, arch, version).Scan(&duplicate); queryErr == nil {
			return ClientUpdate{}, Error(409, "update_version_exists", "该平台与架构的版本已经发布")
		}
		return ClientUpdate{}, err
	}
	committed = true
	return result, nil
}

func (a *App) LatestClientUpdate(ctx context.Context, platform, arch, currentVersion string) (*ClientUpdate, error) {
	current, err := parseStableSemver(currentVersion)
	if err != nil {
		return nil, err
	}
	platform, arch, err = normalizeClientTarget(platform, arch)
	if err != nil {
		return nil, err
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT id,version,signature,path,size,sha256,file_name,created_at FROM client_updates WHERE platform=? AND arch=? AND active=true`, platform, arch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var selected *clientUpdateRecord
	var selectedVersion stableSemver
	for rows.Next() {
		candidate := clientUpdateRecord{ClientUpdate: ClientUpdate{Platform: platform, Arch: arch}}
		if err = rows.Scan(&candidate.ID, &candidate.Version, &candidate.Signature, &candidate.Path, &candidate.Size, &candidate.SHA256, &candidate.FileName, &candidate.PublishedAt); err != nil {
			return nil, err
		}
		parsed, parseErr := parseStableSemver(candidate.Version)
		if parseErr != nil {
			return nil, Error(500, "invalid_update_record", "客户端更新记录无效")
		}
		if parsed.compare(current) <= 0 || selected != nil && parsed.compare(selectedVersion) <= 0 {
			continue
		}
		copy := candidate
		selected = &copy
		selectedVersion = parsed
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if selected == nil {
		return nil, nil
	}
	if !pathWithin(a.updatesDir(), selected.Path) || requireRegularFile(selected.Path) != nil {
		return nil, Error(503, "update_file_unavailable", "客户端更新包暂不可用")
	}
	selected.DownloadURL = "/api/v1/client-updates/" + selected.ID + "/download"
	result := selected.ClientUpdate
	return &result, nil
}

func (a *App) clientUpdateForDownload(ctx context.Context, id string) (clientUpdateRecord, error) {
	var item clientUpdateRecord
	err := a.DB.QueryRowContext(ctx, `SELECT id,version,platform,arch,signature,path,size,sha256,file_name,publisher_id,active,created_at,disabled_at FROM client_updates WHERE id=?`, id).
		Scan(&item.ID, &item.Version, &item.Platform, &item.Arch, &item.Signature, &item.Path, &item.Size, &item.SHA256, &item.FileName, &item.PublisherID, &item.Active, &item.PublishedAt, &item.DisabledAt)
	if errors.Is(err, sql.ErrNoRows) {
		return item, Error(404, "update_not_found", "客户端更新不存在")
	}
	if err != nil {
		return item, err
	}
	if !item.Active {
		return item, Error(404, "update_not_found", "客户端更新不存在")
	}
	if !pathWithin(a.updatesDir(), item.Path) || requireRegularFile(item.Path) != nil {
		return item, Error(404, "update_file_unavailable", "客户端更新包不可用")
	}
	item.DownloadURL = "/api/v1/client-updates/" + item.ID + "/download"
	return item, nil
}

func (a *App) DisableClientUpdate(ctx context.Context, actor *User, id string) error {
	if actor == nil || !HasPermission(actor, "system.manage") {
		return Error(403, "forbidden", "没有客户端更新停用权限")
	}
	result, err := a.DB.ExecContext(ctx, `UPDATE client_updates SET active=false,disabled_at=? WHERE id=? AND active=true`, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 1 {
		return nil
	}
	var exists bool
	if err = a.DB.QueryRowContext(ctx, `SELECT true FROM client_updates WHERE id=?`, id).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
		return Error(404, "update_not_found", "客户端更新不存在")
	}
	return err
}
