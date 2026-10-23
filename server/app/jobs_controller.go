package app

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

type JobsController struct{ App *App }

type CreateImportJobReq struct {
	g.Meta `path:"/api/v1/import-jobs" method:"post" tags:"Jobs" summary:"Create CSV import job"`
	ImportJobSpec
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
}
type CreateImportJobRes struct {
	JobID string `json:"jobId"`
	State string `json:"state"`
}
type CreateExportJobReq struct {
	g.Meta `path:"/api/v1/export-jobs" method:"post" tags:"Jobs" summary:"Create NDJSON export job"`
	ExportJobSpec
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
}
type CreateExportJobRes struct {
	JobID string `json:"jobId"`
	State string `json:"state"`
}
type GetJobReq struct {
	g.Meta `path:"/api/v1/jobs/{id}" method:"get" tags:"Jobs" summary:"Get job"`
	ID     string `json:"id" in:"path" v:"required"`
}
type GetJobRes struct {
	Job
	ClientReport *ClientReport `json:"clientReport,omitempty"`
}
type CancelJobReq struct {
	g.Meta `path:"/api/v1/jobs/{id}/cancel" method:"post" tags:"Jobs" summary:"Cancel job"`
	ID     string `json:"id" in:"path" v:"required"`
}
type CancelJobRes struct{ Job }
type DownloadJobReq struct {
	g.Meta `path:"/api/v1/jobs/{id}/download" method:"get" tags:"Jobs" summary:"Download export result"`
	ID     string `json:"id" in:"path" v:"required"`
}
type DownloadJobRes struct{}

func requestIdempotencyKey(ctx context.Context, body string) string {
	if request := ghttp.RequestFromCtx(ctx); request != nil {
		if value := strings.TrimSpace(request.Header.Get("Idempotency-Key")); value != "" {
			return value
		}
	}
	return strings.TrimSpace(body)
}

func (c *JobsController) CreateImportJob(ctx context.Context, req *CreateImportJobReq) (*CreateImportJobRes, error) {
	user, err := Require(ctx, "data.write")
	if err != nil {
		return nil, err
	}
	upload, err := c.App.storedFile(ctx, req.UploadID)
	if err != nil {
		return nil, err
	}
	if upload.OwnerID != user.ID || upload.MediaType != importCSVMediaType {
		return nil, Error(403, "upload_access_denied", "导入上传不可用")
	}
	payload := jobPayload{Import: &req.ImportJobSpec, UploadSHA256: upload.SHA256}
	job, err := c.App.submitJob(ctx, user, "import", req.DatasetID, requestIdempotencyKey(ctx, req.IdempotencyKey), payload)
	if err != nil {
		return nil, safePublicError(err, "创建导入任务失败")
	}
	c.App.Audit(ctx, user.ID, "job", "submit_import", job.ID, "success", 0)
	return &CreateImportJobRes{JobID: job.ID, State: job.State}, nil
}

func (c *JobsController) CreateExportJob(ctx context.Context, req *CreateExportJobReq) (*CreateExportJobRes, error) {
	user, err := Require(ctx, "data.export")
	if err != nil {
		return nil, err
	}
	if _, err = c.App.AuthorizeTable(ctx, req.DatasetID, req.Table, "export", req.Fields); err != nil {
		return nil, err
	}
	payload := jobPayload{Export: &req.ExportJobSpec}
	job, err := c.App.submitJob(ctx, user, "export", req.DatasetID, requestIdempotencyKey(ctx, req.IdempotencyKey), payload)
	if err != nil {
		return nil, safePublicError(err, "创建导出任务失败")
	}
	c.App.Audit(ctx, user.ID, "job", "submit_export", job.ID, "success", 0)
	return &CreateExportJobRes{JobID: job.ID, State: job.State}, nil
}

func (c *JobsController) GetJob(ctx context.Context, req *GetJobReq) (*GetJobRes, error) {
	user, err := Require(ctx, "jobs.read")
	if err != nil {
		return nil, err
	}
	job, err := c.App.readJob(ctx, req.ID)
	if err != nil {
		return nil, safePublicError(err, "读取任务失败")
	}
	if job.ActorID != user.ID && !HasPermission(user, "system.manage") {
		return nil, Error(403, "forbidden", "不能查看其他用户的任务")
	}
	var clientReport *ClientReport
	if job.Kind == "export" {
		clientReport, err = c.App.ClientReportForJob(ctx, job.ActorID, job.ID)
		if err != nil {
			return nil, safePublicError(err, "读取客户端导出报告失败")
		}
	}
	job.ActorID = ""
	return &GetJobRes{Job: job, ClientReport: clientReport}, nil
}

func (c *JobsController) CancelJob(ctx context.Context, req *CancelJobReq) (*CancelJobRes, error) {
	user, err := Require(ctx, "jobs.cancel")
	if err != nil {
		return nil, err
	}
	job, err := c.App.cancelJob(ctx, user, req.ID)
	if err != nil {
		return nil, safePublicError(err, "取消任务失败")
	}
	job.ActorID = ""
	return &CancelJobRes{Job: job}, nil
}

func (c *JobsController) DownloadJob(ctx context.Context, req *DownloadJobReq) (*DownloadJobRes, error) {
	user, err := Require(ctx, "data.export")
	if err != nil {
		return nil, err
	}
	job, err := c.App.readJob(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	if job.ActorID != user.ID && !HasPermission(user, "system.manage") {
		return nil, Error(403, "forbidden", "不能下载其他用户的任务结果")
	}
	if job.Kind != "export" || job.State != jobSucceeded {
		return nil, Error(409, "result_not_ready", "导出结果尚不可下载")
	}
	if time.Now().UTC().After(job.ExpiresAt) {
		return nil, Error(410, "result_expired", "导出结果已过期")
	}
	var payload jobPayload
	if json.Unmarshal(job.Payload, &payload) != nil || payload.Export == nil {
		return nil, Error(500, "invalid_job_payload", "导出任务参数损坏")
	}
	if _, err = c.App.AuthorizeTable(ctx, payload.Export.DatasetID, payload.Export.Table, "export", payload.Export.Fields); err != nil {
		return nil, err
	}
	if _, err = c.App.AuthorizeTable(ctx, payload.Export.DatasetID, payload.Export.Table, "read", payload.Export.Fields); err != nil {
		return nil, err
	}
	var raw string
	if err = c.App.DB.QueryRowContext(ctx, `SELECT result FROM jobs WHERE id=?`, job.ID).Scan(&raw); err != nil {
		return nil, Error(404, "result_missing", "导出结果不存在")
	}
	var artifact jobArtifact
	if json.Unmarshal([]byte(raw), &artifact) != nil || artifact.Path == "" || !pathWithin(c.App.resultsDir(), artifact.Path) || requireRegularFile(artifact.Path) != nil {
		return nil, Error(404, "result_missing", "导出结果不存在")
	}
	currentRevision, revisionErr := c.App.AuthorizationRevision(ctx)
	if revisionErr != nil {
		return nil, Error(500, "authorization_unavailable", "无法核对导出结果授权")
	}
	if artifact.AuthzRevision == "" || artifact.AuthzRevision != currentRevision {
		return nil, Error(403, "export_authorization_changed", "导出授权已变化，请重新创建导出任务")
	}
	request := ghttp.RequestFromCtx(ctx)
	request.Response.Header().Set("Cache-Control", "private, no-store")
	request.Response.Header().Set("X-Content-Type-Options", "nosniff")
	request.Response.Header().Set("ETag", `"`+artifact.SHA256+`"`)
	request.Response.ServeFileDownload(artifact.Path, contentDispositionName(artifact.Name))
	c.App.Audit(ctx, user.ID, "job", "download", job.ID, "success", 0)
	return &DownloadJobRes{}, nil
}
