package server_test

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gogf/gf/v2/net/ghttp"
)

func TestStreamResponsesDoNotAppendJSON(t *testing.T) {
	buffered := make(chan int, 3)
	a, base, client := screenStartServer(t, func(server *ghttp.Server) {
		server.BindHookHandler("/*", ghttp.HookBeforeOutput, func(r *ghttp.Request) {
			if strings.HasSuffix(r.URL.Path, "/download") {
				buffered <- r.Response.BufferLength()
			}
		})
	})
	admin := screenLogin(t, client, base, "admin", screenAdminPassword)
	screenInsertConfig(t, a, "response-check", "screen", "Response check", map[string]any{"enabled": true})
	bundle, _ := screenValidBundle(t, "response-check", "1.0.0", []byte("<html>response check</html>"))
	screenUpload(t, client, base, admin.AccessToken, "response-check", bundle, http.StatusOK)
	for _, status := range []int{http.StatusOK, http.StatusPartialContent, http.StatusNotModified} {
		headers := map[string]string{}
		if status == http.StatusPartialContent {
			headers["Range"] = "bytes=0-15"
		}
		if status == http.StatusNotModified {
			headers["If-None-Match"] = `"` + screenSHA256(bundle) + `"`
		}
		response := screenDownload(t, client, base, admin.AccessToken, "response-check", "1.0.0", headers, status)
		if status == http.StatusOK && !bytes.Equal(response.Body, bundle) {
			t.Fatal("download differs from the immutable ZIP")
		}
		if status == http.StatusNotModified && len(response.Body) != 0 {
			t.Fatal("304 response must have no body")
		}
		select {
		case n := <-buffered:
			if n != 0 {
				t.Errorf("HTTP %d: middleware appended %d bytes after a committed response", status, n)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("response hook did not run")
		}
	}
}
