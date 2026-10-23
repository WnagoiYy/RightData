package app

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

type UpdatesController struct{ App *App }

type PublishClientUpdateReq struct {
	g.Meta    `path:"/api/v1/client-updates" method:"post" tags:"Client updates" summary:"Publish an immutable client update"`
	FileID    string `json:"fileId" v:"required"`
	Version   string `json:"version" v:"required"`
	Signature string `json:"signature" v:"required"`
	Platform  string `json:"platform" v:"required"`
	Arch      string `json:"arch" v:"required"`
}
type PublishClientUpdateRes struct{ ClientUpdate }

type LatestClientUpdateReq struct {
	g.Meta         `path:"/api/v1/client-updates/latest" method:"get" tags:"Client updates" summary:"Get the latest applicable client update"`
	Platform       string `json:"platform" in:"query" v:"required"`
	Arch           string `json:"arch" in:"query" v:"required"`
	CurrentVersion string `json:"currentVersion" in:"query" v:"required"`
}
type LatestClientUpdateRes struct{ ClientUpdate }

type DownloadClientUpdateReq struct {
	g.Meta `path:"/api/v1/client-updates/{id}/download" method:"get" tags:"Client updates" summary:"Download an immutable client installer"`
	ID     string `json:"id" in:"path" v:"required"`
}
type DownloadClientUpdateRes struct{}

type DisableClientUpdateReq struct {
	g.Meta `path:"/api/v1/client-updates/{id}/disable" method:"post" tags:"Client updates" summary:"Disable a client update"`
	ID     string `json:"id" in:"path" v:"required"`
}
type DisableClientUpdateRes struct {
	Disabled bool `json:"disabled"`
}

func authenticatedUser(ctx context.Context) (*User, error) {
	user := CurrentUser(ctx)
	if user == nil || user.Disabled {
		return nil, Error(401, "unauthenticated", "请先登录")
	}
	return user, nil
}

func (c *UpdatesController) PublishClientUpdate(ctx context.Context, req *PublishClientUpdateReq) (*PublishClientUpdateRes, error) {
	user, err := Require(ctx, "system.manage")
	if err != nil {
		return nil, err
	}
	update, err := c.App.PublishClientUpdate(ctx, user, req.FileID, req.Version, req.Signature, req.Platform, req.Arch)
	if err != nil {
		return nil, safePublicError(err, "发布客户端更新失败")
	}
	c.App.Audit(ctx, user.ID, "client_update", "publish", update.ID, "success", 0)
	return &PublishClientUpdateRes{ClientUpdate: update}, nil
}

func (c *UpdatesController) LatestClientUpdate(ctx context.Context, req *LatestClientUpdateReq) (*LatestClientUpdateRes, error) {
	if _, err := authenticatedUser(ctx); err != nil {
		return nil, err
	}
	update, err := c.App.LatestClientUpdate(ctx, req.Platform, req.Arch, req.CurrentVersion)
	if err != nil {
		return nil, safePublicError(err, "读取客户端更新失败")
	}
	if update == nil {
		request := ghttp.RequestFromCtx(ctx)
		request.Response.WriteStatus(http.StatusNoContent)
		return nil, nil
	}
	return &LatestClientUpdateRes{ClientUpdate: *update}, nil
}

func (c *UpdatesController) DownloadClientUpdate(ctx context.Context, req *DownloadClientUpdateReq) (*DownloadClientUpdateRes, error) {
	if _, err := authenticatedUser(ctx); err != nil {
		return nil, err
	}
	item, err := c.App.clientUpdateForDownload(ctx, req.ID)
	if err != nil {
		return nil, safePublicError(err, "下载客户端更新失败")
	}
	file, err := os.Open(item.Path)
	if err != nil {
		return nil, Error(404, "update_file_unavailable", "客户端更新包不可用")
	}
	defer file.Close()
	request := ghttp.RequestFromCtx(ctx)
	request.Response.Header().Set("Content-Type", "application/octet-stream")
	request.Response.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, contentDispositionName(item.FileName)))
	request.Response.Header().Set("Accept-Ranges", "bytes")
	request.Response.Header().Set("ETag", `"`+item.SHA256+`"`)
	request.Response.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(request.Response.RawWriter(), request.Request, item.FileName, item.PublishedAt, file)
	return &DownloadClientUpdateRes{}, nil
}

func (c *UpdatesController) DisableClientUpdate(ctx context.Context, req *DisableClientUpdateReq) (*DisableClientUpdateRes, error) {
	user, err := Require(ctx, "system.manage")
	if err != nil {
		return nil, err
	}
	if err = c.App.DisableClientUpdate(ctx, user, req.ID); err != nil {
		return nil, safePublicError(err, "停用客户端更新失败")
	}
	c.App.Audit(ctx, user.ID, "client_update", "disable", req.ID, "success", 0)
	return &DisableClientUpdateRes{Disabled: true}, nil
}
