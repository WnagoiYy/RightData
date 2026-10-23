// Local smoke check for an already running service. No business data is changed.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"server/app"
)

func main() {
	base := os.Getenv("RIGHTDATA_SMOKE_URL")
	if base == "" {
		base = "http://127.0.0.1:8003"
	}
	dataDir := os.Getenv("RIGHTDATA_DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	password, err := app.InitialPassword(dataDir)
	if err != nil {
		panic("无法读取本地初始凭据，请仅在首次初始化的本机实例使用此检查")
	}
	client := &http.Client{Timeout: 15 * time.Second}
	call := func(method, path, token string, body any) map[string]any {
		raw, _ := json.Marshal(body)
		request, e := http.NewRequest(method, base+path, bytes.NewReader(raw))
		if e != nil {
			panic(e)
		}
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, e := client.Do(request)
		if e != nil {
			panic(e)
		}
		defer response.Body.Close()
		raw, e = io.ReadAll(response.Body)
		if e != nil {
			panic(e)
		}
		if response.StatusCode != 200 {
			panic(fmt.Sprintf("%s %s status=%d", method, path, response.StatusCode))
		}
		var envelope struct {
			Code string         `json:"code"`
			Data map[string]any `json:"data"`
		}
		if json.Unmarshal(raw, &envelope) != nil || envelope.Code != "ok" {
			panic("接口返回不是成功JSON信封")
		}
		fmt.Printf("PASS %s %s\n", method, path)
		return envelope.Data
	}
	probe := call("GET", "/api/probe", "", nil)
	if probe["ready"] != true {
		panic("服务未就绪")
	}
	username := os.Getenv("RIGHTDATA_ADMIN_USERNAME")
	if username == "" {
		username = "admin"
	}
	login := call("POST", "/api/v1/auth/login", "", map[string]any{"username": username, "password": password, "remember": false})
	token, ok := login["accessToken"].(string)
	if !ok {
		panic("缺少会话")
	}
	defer call("POST", "/api/v1/auth/logout", token, nil)
	me := call("GET", "/api/v1/auth/me", token, nil)
	if revision, ok := me["authzRevision"].(string); !ok || revision == "" {
		panic("当前实例未加载授权版本字段")
	}
	call("GET", "/api/v1/health", token, nil)
	call("GET", "/api/v1/client-events", token, nil)
	request, err := http.NewRequest("GET", base+"/api/api.json", nil)
	if err != nil {
		panic(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		panic(err)
	}
	defer response.Body.Close()
	var specification struct {
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&specification) != nil {
		panic("无法读取当前实例的接口规范")
	}
	for _, path := range []string{"/api/v1/menus", "/api/v1/resources/{id}", "/api/v1/resources/preview", "/api/v1/client-updates/latest"} {
		if _, exists := specification.Paths[path]; !exists {
			panic("当前实例未加载新增接口：" + path)
		}
	}
	for path, method := range map[string]string{
		"/api/v1/datasets/{datasetId}/schema:mutate":                 "post",
		"/api/v1/datasets/{datasetId}/tables/{table}/records:mutate": "post",
		"/api/v1/configs/{id}":                                       "put",
	} {
		var operations map[string]struct {
			Parameters []struct {
				Name string `json:"name"`
				In   string `json:"in"`
			} `json:"parameters"`
		}
		if json.Unmarshal(specification.Paths[path], &operations) != nil {
			panic("无法解析接口参数：" + path)
		}
		found := false
		for _, parameter := range operations[method].Parameters {
			found = found || parameter.In == "header" && parameter.Name == "Idempotency-Key"
		}
		if !found {
			panic("当前实例未加载幂等请求头修复：" + path)
		}
	}
	fmt.Println("PASS GET /api/api.json (resource/update routes and idempotency headers)")
}
