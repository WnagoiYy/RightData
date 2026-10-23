package cmd

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gcmd"
	"server/app"
)

var (
	Main = gcmd.Command{
		Name:  "main",
		Usage: "main",
		Brief: "start http server",
		Func: func(ctx context.Context, parser *gcmd.Parser) (err error) {
			value := func(env, key, fallback string) string {
				if v := os.Getenv(env); v != "" {
					return v
				}
				return g.Cfg().MustGet(ctx, key, fallback).String()
			}
			positive := func(env, key, fallback string) (int64, error) {
				s := value(env, key, fallback)
				n, e := strconv.ParseInt(s, 10, 64)
				if e != nil || n <= 0 {
					return 0, fmt.Errorf("%s 必须是正整数", env)
				}
				return n, nil
			}
			dataDir := value("RIGHTDATA_DATA_DIR", "rightdata.dataDir", "data")
			if os.Getenv("RIGHTDATA_PRINT_INITIAL_PASSWORD") == "1" {
				password, e := app.InitialPassword(dataDir)
				if e != nil {
					return e
				}
				fmt.Println(password)
				return nil
			}
			querySeconds, e := positive("RIGHTDATA_QUERY_SECONDS", "rightdata.querySeconds", "30")
			if e != nil {
				return e
			}
			taskSeconds, e := positive("RIGHTDATA_TASK_SECONDS", "rightdata.taskSeconds", "900")
			if e != nil {
				return e
			}
			maxUpload, e := positive("RIGHTDATA_MAX_UPLOAD_BYTES", "rightdata.maxUploadBytes", "52428800")
			if e != nil {
				return e
			}
			maxRows, e := positive("RIGHTDATA_MAX_RESULT_ROWS", "rightdata.maxResultRows", "10000")
			if e != nil {
				return e
			}
			taskCount, e := positive("RIGHTDATA_TASK_CONCURRENCY", "rightdata.taskConcurrency", "2")
			if e != nil {
				return e
			}
			requestCount, e := positive("RIGHTDATA_REQUEST_CONCURRENCY", "rightdata.requestConcurrency", "32")
			if e != nil {
				return e
			}
			ttl, e := positive("RIGHTDATA_RESULT_TTL_SECONDS", "rightdata.resultTTLSeconds", "86400")
			if e != nil {
				return e
			}
			secure, e := strconv.ParseBool(value("RIGHTDATA_COOKIE_SECURE", "rightdata.cookieSecure", "true"))
			if e != nil {
				return fmt.Errorf("cookieSecure 必须为布尔值")
			}
			a, e := app.Open(ctx, app.Config{Address: value("RIGHTDATA_ADDRESS", "server.address", "127.0.0.1:8003"), DataDir: dataDir, AdminUsername: value("RIGHTDATA_ADMIN_USERNAME", "rightdata.adminUsername", "admin"), AdminPassword: os.Getenv("RIGHTDATA_ADMIN_PASSWORD"), QueryTimeout: time.Duration(querySeconds) * time.Second, TaskTimeout: time.Duration(taskSeconds) * time.Second, MaxUploadBytes: maxUpload, MaxResultRows: int(maxRows), MaxConcurrentTasks: int(taskCount), MaxConcurrentRequests: int(requestCount), ResultTTL: time.Duration(ttl) * time.Second, CookieSecure: secure})
			if e != nil {
				return e
			}
			defer a.Close()
			uploadTemp := filepath.Join(a.Config.DataDir, "http-temp")
			if e = os.MkdirAll(uploadTemp, 0700); e != nil {
				return e
			}
			for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
				if e = os.Setenv(name, uploadTemp); e != nil {
					return e
				}
			}
			app.NewServer(a).Run()
			return nil
		},
	}
)
