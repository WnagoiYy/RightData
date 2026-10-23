package app

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

type FilesController struct{ App *App }

type ListDataFilesReq struct {
	g.Meta `path:"/api/v1/data-files" method:"get" tags:"Data files" summary:"List managed databases"`
}
type ListDataFilesRes struct {
	Items []DataFile `json:"items"`
}
type CreateDataFileReq struct {
	g.Meta   `path:"/api/v1/data-files" method:"post" tags:"Data files" summary:"Create encrypted database"`
	Name     string `json:"name" v:"required"`
	Password string `json:"password"`
}
type CreateDataFileRes struct{ DataFile }
type UploadDataFileReq struct {
	g.Meta   `path:"/api/v1/data-files/upload" method:"post" mime:"multipart/form-data" tags:"Data files" summary:"Upload encrypted database"`
	Name     string            `p:"name" v:"required"`
	Password string            `p:"password" v:"required"`
	File     *ghttp.UploadFile `p:"file" type:"file" v:"required"`
}
type UploadDataFileRes struct{ DataFile }
type DataFilePasswordReq struct {
	g.Meta `path:"/api/v1/data-files/{id}/password" method:"get" tags:"Data files" summary:"Reveal database password"`
	ID     string `json:"id" in:"path" v:"required"`
}
type DataFilePasswordRes struct {
	Password string `json:"password"`
}
type BackupDataFileReq struct {
	g.Meta         `path:"/api/v1/data-files/{id}/backups" method:"post" tags:"Data files" summary:"Create consistent backup"`
	ID             string `json:"id" in:"path" v:"required"`
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
}
type BackupDataFileRes struct {
	JobID string `json:"jobId"`
	State string `json:"state"`
}
type DownloadDataFileReq struct {
	g.Meta `path:"/api/v1/data-files/{id}/download" method:"get" tags:"Data files" summary:"Download database file"`
	ID     string `json:"id" in:"path" v:"required"`
}
type DownloadDataFileRes struct{}
type DeleteDataFileReq struct {
	g.Meta `path:"/api/v1/data-files/{id}" method:"delete" tags:"Data files" summary:"Delete database file"`
	ID     string `json:"id" in:"path" v:"required"`
}
type DeleteDataFileRes struct {
	Deleted bool `json:"deleted"`
}
type CreateConnectionReq struct {
	g.Meta `path:"/api/v1/connections" method:"post" tags:"Data files" summary:"Register database connection"`
	FileID string `json:"fileId" v:"required"`
	Name   string `json:"name" v:"required"`
}
type CreateConnectionRes struct{ FileConnection }
type ListConnectionsReq struct {
	g.Meta `path:"/api/v1/connections" method:"get" tags:"Data files" summary:"List database connections"`
}
type ListConnectionsRes struct {
	Items []FileConnection `json:"items"`
}
type UpdateConnectionReq struct {
	g.Meta `path:"/api/v1/connections/{id}" method:"patch" tags:"Data files" summary:"Rename database connection"`
	ID     string `json:"id" in:"path" v:"required"`
	Name   string `json:"name" v:"required"`
}
type UpdateConnectionRes struct{ FileConnection }
type DeleteConnectionReq struct {
	g.Meta `path:"/api/v1/connections/{id}" method:"delete" tags:"Data files" summary:"Delete database connection reference"`
	ID     string `json:"id" in:"path" v:"required"`
}
type DeleteConnectionRes struct {
	Deleted bool `json:"deleted"`
}

type UploadFileReq struct {
	g.Meta    `path:"/api/v1/files" method:"post" mime:"multipart/form-data" tags:"Files" summary:"Upload file"`
	Name      string            `p:"name"`
	MediaType string            `p:"mediaType"`
	File      *ghttp.UploadFile `p:"file" type:"file" v:"required"`
}
type UploadFileRes struct{ StoredFile }
type UploadImportReq struct {
	g.Meta  `path:"/api/v1/uploads" method:"post" mime:"multipart/form-data" tags:"Jobs" summary:"Upload strict CSV for import"`
	Purpose string            `p:"purpose" v:"required|in:import"`
	File    *ghttp.UploadFile `p:"file" type:"file" v:"required"`
}
type UploadImportRes struct {
	UploadID  string    `json:"uploadId"`
	FileName  string    `json:"fileName"`
	Size      int64     `json:"sizeBytes"`
	SHA256    string    `json:"sha256"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type ListFilesReq struct {
	g.Meta `path:"/api/v1/files" method:"get" tags:"Files" summary:"List files"`
}
type ListFilesRes struct {
	Items []StoredFile `json:"items"`
}
type UpdateFileReq struct {
	g.Meta    `path:"/api/v1/files/{id}" method:"patch" tags:"Files" summary:"Update file metadata"`
	ID        string `json:"id" in:"path" v:"required"`
	Name      string `json:"name"`
	MediaType string `json:"mediaType"`
}
type UpdateFileRes struct{ StoredFile }
type ReplaceFileReq struct {
	g.Meta `path:"/api/v1/files/{id}/content" method:"put" mime:"multipart/form-data" tags:"Files" summary:"Replace file content"`
	ID     string            `p:"id" in:"path" v:"required"`
	File   *ghttp.UploadFile `p:"file" type:"file" v:"required"`
}
type ReplaceFileRes struct{ StoredFile }
type DownloadFileReq struct {
	g.Meta `path:"/api/v1/files/{id}/download" method:"get" tags:"Files" summary:"Download file"`
	ID     string `json:"id" in:"path" v:"required"`
}
type DownloadFileRes struct{}
type DeleteFileReq struct {
	g.Meta `path:"/api/v1/files/{id}" method:"delete" tags:"Files" summary:"Delete file"`
	ID     string `json:"id" in:"path" v:"required"`
}
type DeleteFileRes struct {
	Deleted bool `json:"deleted"`
}

func (c *FilesController) ListDataFiles(ctx context.Context, _ *ListDataFilesReq) (*ListDataFilesRes, error) {
	user, err := Require(ctx, "datasets.manage")
	if err != nil {
		return nil, err
	}
	items, err := c.App.listDataFiles(ctx, user)
	if err != nil {
		return nil, safePublicError(err, "读取数据库文件失败")
	}
	return &ListDataFilesRes{Items: items}, nil
}

func (c *FilesController) CreateDataFile(ctx context.Context, req *CreateDataFileReq) (*CreateDataFileRes, error) {
	user, err := Require(ctx, "datasets.manage")
	if err != nil {
		return nil, err
	}
	start := time.Now()
	item, err := c.App.createDataFile(ctx, user.ID, req.Name, req.Password)
	outcome := "success"
	if err != nil {
		outcome = "failed"
	}
	c.App.Audit(ctx, user.ID, "data_file", "create", item.ID, outcome, time.Since(start))
	if err != nil {
		return nil, safePublicError(err, "创建数据库失败")
	}
	return &CreateDataFileRes{DataFile: item}, nil
}

func (c *FilesController) UploadDataFile(ctx context.Context, req *UploadDataFileReq) (*UploadDataFileRes, error) {
	user, err := Require(ctx, "datasets.manage")
	if err != nil {
		return nil, err
	}
	if req.File == nil || req.File.FileHeader == nil {
		return nil, Error(400, "file_required", "请选择数据库文件")
	}
	start := time.Now()
	item, err := c.App.registerUploadedDatabase(ctx, user.ID, req.Name, req.Password, req.File.FileHeader)
	outcome := "success"
	if err != nil {
		outcome = "failed"
	}
	c.App.Audit(ctx, user.ID, "data_file", "upload", item.ID, outcome, time.Since(start))
	if err != nil {
		return nil, safePublicError(err, "上传数据库失败")
	}
	return &UploadDataFileRes{DataFile: item}, nil
}

func (c *FilesController) DataFilePassword(ctx context.Context, req *DataFilePasswordReq) (*DataFilePasswordRes, error) {
	user, err := Require(ctx, "datasets.password")
	if err != nil {
		return nil, err
	}
	item, err := c.App.dataFile(ctx, req.ID)
	if err != nil {
		return nil, safePublicError(err, "读取数据库密码失败")
	}
	if !canAccessDataFile(user, item) {
		return nil, Error(403, "forbidden", "不能读取其他用户的数据库密码")
	}
	c.App.Audit(ctx, user.ID, "data_file", "password_reveal", item.ID, "success", 0)
	return &DataFilePasswordRes{Password: item.Password}, nil
}

func (c *FilesController) BackupDataFile(ctx context.Context, req *BackupDataFileReq) (*BackupDataFileRes, error) {
	user, err := Require(ctx, "datasets.manage")
	if err != nil {
		return nil, err
	}
	source, err := c.App.dataFile(ctx, req.ID)
	if err != nil {
		return nil, safePublicError(err, "读取数据库文件失败")
	}
	if !canAccessDataFile(user, source) {
		return nil, Error(403, "forbidden", "不能备份其他用户的数据库文件")
	}
	if source.Kind == "backup" {
		return nil, Error(409, "backup_source_invalid", "备份文件不能再次生成备份")
	}
	start := time.Now()
	job, err := c.App.submitJob(ctx, user, "backup", source.ID, requestIdempotencyKey(ctx, req.IdempotencyKey), jobPayload{Backup: &BackupJobSpec{SourceID: source.ID, BackupID: NewID()}})
	outcome := "success"
	if err != nil {
		outcome = "failed"
	}
	c.App.Audit(ctx, user.ID, "data_file", "backup", req.ID, outcome, time.Since(start))
	if err != nil {
		return nil, safePublicError(err, "生成数据库备份失败")
	}
	return &BackupDataFileRes{JobID: job.ID, State: job.State}, nil
}

func (c *FilesController) DownloadDataFile(ctx context.Context, req *DownloadDataFileReq) (*DownloadDataFileRes, error) {
	user, err := Require(ctx, "datasets.download")
	if err != nil {
		return nil, err
	}
	item, err := c.App.dataFile(ctx, req.ID)
	if err != nil {
		return nil, safePublicError(err, "读取数据库文件失败")
	}
	if !canAccessDataFile(user, item) {
		return nil, Error(403, "forbidden", "不能下载其他用户的数据库文件")
	}
	path, name := item.Path, item.Name
	var temporary string
	if item.Kind != "backup" {
		backup, backupErr := c.App.createBackup(ctx, user, item.ID)
		if backupErr != nil {
			return nil, safePublicError(backupErr, "生成下载快照失败")
		}
		backupRecord, readErr := c.App.dataFile(ctx, backup.ID)
		if readErr != nil {
			return nil, safePublicError(readErr, "读取下载快照失败")
		}
		path, name, temporary = backupRecord.Path, item.Name, backupRecord.ID
	}
	if err = requireRegularFile(path); err != nil {
		return nil, Error(404, "file_missing", "数据库文件不可用")
	}
	r := ghttp.RequestFromCtx(ctx)
	r.Response.Header().Set("Cache-Control", "no-store")
	r.Response.Header().Set("X-Content-Type-Options", "nosniff")
	r.Response.ServeFileDownload(path, contentDispositionName(name))
	c.App.Audit(ctx, user.ID, "data_file", "download", item.ID, "success", 0)
	if temporary != "" {
		_ = c.App.deleteDataFile(context.WithoutCancel(ctx), user, temporary)
	}
	return &DownloadDataFileRes{}, nil
}

func (c *FilesController) DeleteDataFile(ctx context.Context, req *DeleteDataFileReq) (*DeleteDataFileRes, error) {
	user, err := Require(ctx, "datasets.manage")
	if err != nil {
		return nil, err
	}
	err = c.App.deleteDataFile(ctx, user, req.ID)
	outcome := "success"
	if err != nil {
		outcome = "failed"
	}
	c.App.Audit(ctx, user.ID, "data_file", "delete", req.ID, outcome, 0)
	if err != nil {
		return nil, safePublicError(err, "删除数据库文件失败")
	}
	return &DeleteDataFileRes{Deleted: true}, nil
}

func (c *FilesController) CreateConnection(ctx context.Context, req *CreateConnectionReq) (*CreateConnectionRes, error) {
	user, err := Require(ctx, "datasets.manage")
	if err != nil {
		return nil, err
	}
	item, err := c.App.registerConnection(ctx, user, req.FileID, req.Name)
	if err != nil {
		return nil, safePublicError(err, "登记数据库连接失败")
	}
	c.App.Audit(ctx, user.ID, "connection", "create", item.ID, "success", 0)
	return &CreateConnectionRes{FileConnection: item}, nil
}

func (c *FilesController) ListConnections(ctx context.Context, _ *ListConnectionsReq) (*ListConnectionsRes, error) {
	user, err := Require(ctx, "datasets.manage")
	if err != nil {
		return nil, err
	}
	items, err := c.App.listConnections(ctx, user)
	if err != nil {
		return nil, safePublicError(err, "读取数据库连接失败")
	}
	return &ListConnectionsRes{Items: items}, nil
}

func (c *FilesController) UpdateConnection(ctx context.Context, req *UpdateConnectionReq) (*UpdateConnectionRes, error) {
	user, err := Require(ctx, "datasets.manage")
	if err != nil {
		return nil, err
	}
	item, err := c.App.renameConnection(ctx, user, req.ID, req.Name)
	if err != nil {
		return nil, safePublicError(err, "更新数据库连接失败")
	}
	c.App.Audit(ctx, user.ID, "connection", "rename", item.ID, "success", 0)
	return &UpdateConnectionRes{FileConnection: item}, nil
}

func (c *FilesController) DeleteConnection(ctx context.Context, req *DeleteConnectionReq) (*DeleteConnectionRes, error) {
	user, err := Require(ctx, "datasets.manage")
	if err != nil {
		return nil, err
	}
	err = c.App.deleteConnection(ctx, user, req.ID)
	if err != nil {
		return nil, safePublicError(err, "删除数据库连接失败")
	}
	c.App.Audit(ctx, user.ID, "connection", "delete", req.ID, "success", 0)
	return &DeleteConnectionRes{Deleted: true}, nil
}

func (c *FilesController) UploadFile(ctx context.Context, req *UploadFileReq) (*UploadFileRes, error) {
	user, err := Require(ctx, "files.write")
	if err != nil {
		return nil, err
	}
	if req.File == nil || req.File.FileHeader == nil {
		return nil, Error(400, "file_required", "请选择上传文件")
	}
	name := req.Name
	if strings.TrimSpace(name) == "" && req.File != nil {
		name = req.File.Filename
	}
	mediaType := strings.TrimSpace(req.MediaType)
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	item, err := c.App.storeFile(ctx, user.ID, name, mediaType, req.File.FileHeader)
	if err != nil {
		return nil, safePublicError(err, "上传文件失败")
	}
	return &UploadFileRes{StoredFile: item}, nil
}

func (c *FilesController) UploadImport(ctx context.Context, req *UploadImportReq) (*UploadImportRes, error) {
	user, err := Require(ctx, "data.write")
	if err != nil {
		return nil, err
	}
	if req.File == nil || req.File.FileHeader == nil || !strings.EqualFold(filepath.Ext(req.File.Filename), ".csv") {
		return nil, Error(400, "csv_required", "导入上传仅支持 CSV 文件")
	}
	item, err := c.App.storeFile(ctx, user.ID, req.File.Filename, importCSVMediaType, req.File.FileHeader)
	if err != nil {
		return nil, safePublicError(err, "上传导入文件失败")
	}
	ttl := c.App.Config.ResultTTL
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	return &UploadImportRes{UploadID: item.ID, FileName: item.Name, Size: item.Size, SHA256: item.SHA256, ExpiresAt: item.CreatedAt.Add(ttl)}, nil
}

func (c *FilesController) ListFiles(ctx context.Context, _ *ListFilesReq) (*ListFilesRes, error) {
	user, err := Require(ctx, "files.read")
	if err != nil {
		return nil, err
	}
	query := `SELECT id,name,path,owner_id,size,sha256,media_type,created_at,updated_at FROM files WHERE owner_id=? AND media_type<>? ORDER BY updated_at DESC,id`
	args := []any{user.ID, importCSVMediaType}
	if HasPermission(user, "system.manage") {
		query = `SELECT id,name,path,owner_id,size,sha256,media_type,created_at,updated_at FROM files WHERE media_type<>? ORDER BY updated_at DESC,id`
		args = []any{importCSVMediaType}
	}
	rows, err := c.App.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, safePublicError(err, "读取文件失败")
	}
	defer rows.Close()
	items := []StoredFile{}
	for rows.Next() {
		var rec storedFileRecord
		if err = rows.Scan(&rec.ID, &rec.Name, &rec.Path, &rec.OwnerID, &rec.Size, &rec.SHA256, &rec.MediaType, &rec.CreatedAt, &rec.UpdatedAt); err != nil {
			return nil, safePublicError(err, "读取文件失败")
		}
		items = append(items, rec.StoredFile)
	}
	if err = rows.Err(); err != nil {
		return nil, safePublicError(err, "读取文件失败")
	}
	return &ListFilesRes{Items: items}, nil
}

func (c *FilesController) UpdateFile(ctx context.Context, req *UpdateFileReq) (*UpdateFileRes, error) {
	user, err := Require(ctx, "files.write")
	if err != nil {
		return nil, err
	}
	item, err := c.App.storedFile(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	if !canAccessOwnedFile(user, item.OwnerID) {
		return nil, Error(403, "forbidden", "不能修改其他用户的文件")
	}
	name := item.Name
	if strings.TrimSpace(req.Name) != "" {
		name = filepath.Base(strings.TrimSpace(req.Name))
		if name == "." || len(name) > 255 {
			return nil, Error(400, "invalid_file_name", "文件名无效")
		}
	}
	media := item.MediaType
	if strings.TrimSpace(req.MediaType) != "" {
		media = strings.TrimSpace(req.MediaType)
	}
	if item.MediaType == importCSVMediaType {
		media = importCSVMediaType
	}
	now := time.Now().UTC()
	_, err = c.App.DB.ExecContext(ctx, `UPDATE files SET name=?,media_type=?,updated_at=? WHERE id=?`, name, media, now, item.ID)
	if err != nil {
		return nil, safePublicError(err, "更新文件失败")
	}
	item.Name, item.MediaType, item.UpdatedAt = name, media, now
	return &UpdateFileRes{StoredFile: item.StoredFile}, nil
}

func (c *FilesController) ReplaceFile(ctx context.Context, req *ReplaceFileReq) (*ReplaceFileRes, error) {
	user, err := Require(ctx, "files.write")
	if err != nil {
		return nil, err
	}
	if req.File == nil || req.File.FileHeader == nil {
		return nil, Error(400, "file_required", "请选择替换文件")
	}
	item, err := c.App.replaceStoredFile(ctx, user, req.ID, req.File.FileHeader)
	if err != nil {
		return nil, safePublicError(err, "替换文件失败")
	}
	return &ReplaceFileRes{StoredFile: item}, nil
}

func (c *FilesController) DownloadFile(ctx context.Context, req *DownloadFileReq) (*DownloadFileRes, error) {
	user, err := Require(ctx, "files.read")
	if err != nil {
		return nil, err
	}
	item, err := c.App.storedFile(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	if item.MediaType == importCSVMediaType || !canAccessOwnedFile(user, item.OwnerID) {
		return nil, Error(403, "forbidden", "不能下载该文件")
	}
	if err = requireRegularFile(item.Path); err != nil {
		return nil, Error(404, "file_missing", "文件不可用")
	}
	r := ghttp.RequestFromCtx(ctx)
	r.Response.Header().Set("Cache-Control", "private, no-store")
	r.Response.Header().Set("X-Content-Type-Options", "nosniff")
	r.Response.ServeFileDownload(item.Path, contentDispositionName(item.Name))
	return &DownloadFileRes{}, nil
}

func (c *FilesController) DeleteFile(ctx context.Context, req *DeleteFileReq) (*DeleteFileRes, error) {
	user, err := Require(ctx, "files.write")
	if err != nil {
		return nil, err
	}
	err = c.App.deleteStoredFile(ctx, user, req.ID)
	if err != nil {
		return nil, safePublicError(err, "删除文件失败")
	}
	return &DeleteFileRes{Deleted: true}, nil
}
