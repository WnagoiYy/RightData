package app

import (
	"context"
	"fmt"
	"net/http"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

type ScreensController struct{ App *App }

type UploadScreenVersionReq struct {
	g.Meta `path:"/api/v1/screens/{id}/versions" method:"post" mime:"multipart/form-data" tags:"数据大屏" summary:"校验并上传不可变大屏版本"`
	ID     string            `p:"id" in:"path" v:"required|length:1,100"`
	File   *ghttp.UploadFile `p:"file" type:"file" v:"required"`
}

type ListScreenVersionsReq struct {
	g.Meta `path:"/api/v1/screens/{id}/versions" method:"get" tags:"数据大屏" summary:"列出大屏版本与当前发布状态"`
	ID     string `json:"id" in:"path" v:"required|length:1,100"`
	Limit  int    `json:"limit" in:"query"`
	Offset int    `json:"offset" in:"query"`
}

type ListScreenVersionsRes struct {
	Items []ScreenVersion `json:"items"`
	ScreenPublication
}

type PublishScreenReq struct {
	g.Meta           `path:"/api/v1/screens/{id}/publish" method:"post" tags:"数据大屏" summary:"按发布修订号切换或回退大屏版本"`
	ID               string `json:"id" in:"path" v:"required|length:1,100"`
	Version          string `json:"version" v:"required"`
	ExpectedRevision int64  `json:"expectedRevision"`
	IdempotencyKey   string `p:"Idempotency-Key" in:"header" json:"-"`
}

type DownloadScreenVersionReq struct {
	g.Meta  `path:"/api/v1/screens/{id}/versions/{version}/download" method:"get" tags:"数据大屏" summary:"按当前资源权限下载大屏静态包"`
	ID      string `json:"id" in:"path" v:"required|length:1,100"`
	Version string `json:"version" in:"path" v:"required"`
}
type DownloadScreenVersionRes struct{}

func (c *ScreensController) Upload(ctx context.Context, req *UploadScreenVersionReq) (*ScreenVersion, error) {
	user, err := Require(ctx, "config.write")
	if err != nil {
		return nil, err
	}
	if req.File == nil || req.File.FileHeader == nil {
		return nil, Error(400, "file_required", "请选择大屏 ZIP 资源包")
	}
	version, err := c.App.UploadScreenVersion(ctx, user, req.ID, req.File.FileHeader)
	if err != nil {
		return nil, safePublicError(err, "上传大屏版本失败")
	}
	return &version, nil
}

func (c *ScreensController) Versions(ctx context.Context, req *ListScreenVersionsReq) (*ListScreenVersionsRes, error) {
	user, err := Require(ctx, "config.write")
	if err != nil {
		return nil, err
	}
	items, publication, err := c.App.ListScreenVersions(ctx, user, req.ID, req.Limit, req.Offset)
	if err != nil {
		return nil, safePublicError(err, "读取大屏版本失败")
	}
	return &ListScreenVersionsRes{Items: items, ScreenPublication: publication}, nil
}

func (c *ScreensController) Publish(ctx context.Context, req *PublishScreenReq) (*ScreenPublication, error) {
	user, err := Require(ctx, "config.write")
	if err != nil {
		return nil, err
	}
	publication, err := c.App.PublishScreen(ctx, user, req.ID, req.Version, req.ExpectedRevision, requestIdempotencyKey(ctx, req.IdempotencyKey))
	if err != nil {
		return nil, safePublicError(err, "发布大屏版本失败")
	}
	return &publication, nil
}

func (c *ScreensController) Download(ctx context.Context, req *DownloadScreenVersionReq) (*DownloadScreenVersionRes, error) {
	item, err := c.App.screenVersionForDownload(ctx, req.ID, req.Version)
	if err != nil {
		return nil, safePublicError(err, "下载大屏版本失败")
	}
	file, err := c.App.openScreenFile(ctx, item, false)
	if err != nil {
		return nil, safePublicError(err, "下载大屏版本失败")
	}
	defer file.Close()
	request := ghttp.RequestFromCtx(ctx)
	filename := "screen-" + item.Version + ".zip"
	request.Response.Header().Set("Content-Type", "application/zip")
	request.Response.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	request.Response.Header().Set("Accept-Ranges", "bytes")
	request.Response.Header().Set("ETag", `"`+item.SHA256+`"`)
	request.Response.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(request.Response.RawWriter(), request.Request, filename, item.CreatedAt, file)
	return &DownloadScreenVersionRes{}, nil
}
