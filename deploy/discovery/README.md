# RightData discovery reference service

This stateless Node.js service publishes short-lived Iroh endpoint records. It stores no business credentials, access tokens, or backend URLs. State is held in memory because clients renew every 20 seconds and each effective lease lasts at most 60 seconds.

## 当前部署

正式发现地址为 `https://39.106.128.14`。v0.1.7 客户端默认使用该地址；首次升级会为旧版空发现地址填入默认值，已有自定义地址保留，之后仍可手动清空。

服务部署在该主机的 `/opt/rightdata/discovery`，由 `rightdata-discovery.service` 管理单个只读、非 root Node 容器，监听 `127.0.0.1:18090`。运行镜像固定为 `node@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`（Node 22.23.4），限额为每 IP 每分钟 600 次、每个 JSON 请求 16 KiB。

现有 OpenResty 443 站点通过 `nginx-locations.inc` 只转发 `/v1/instances/` 和 `/rightdata-discovery/healthz`，覆盖 X-Forwarded-For 为真实来源 IP。使用既有 Let's Encrypt IP 证书、`snap.certbot.renew.timer` 和续期重载脚本，不新增公网监听端口。内部签名路径保持原样。

部署时上传 `server.mjs`、`rightdata-discovery-container.service`、`nginx-locations.inc` 和 `install-container.sh` 到 `/opt/rightdata/discovery/`，确认固定镜像已拉取，再运行 `bash /opt/rightdata/discovery/install-container.sh`。脚本会保存部署前站点配置、验证 nginx 配置后重载，并校验公网健康响应确为 JSON。

验证命令：`node test/client/discovery-live.mjs https://39.106.128.14`。它使用临时身份和随机实例空间检查可信 TLS、注册、查询、续租、重放拒绝、无效签名拒绝及注销，并把结果保存到 `test/results/discovery-live.json`。临时登记在结束时删除。

发现服务不等同于业务中继。当前生产业务地址为 `http://192.168.3.123:8003`，支持内网直连；release 版本的 peer 转发要求业务后端使用受信任的 HTTPS，不能通过关闭证书验证来绕过。登记签名证明节点私钥所有权，不代表实例成员授权；公开实例下的注册污染与容量滥用仍依赖限流和容量上限控制。

## Protocol

`endpointId` is the lowercase 64-character hex encoding of the raw 32-byte Ed25519 public key. `expiresAt` is an integer Unix timestamp in milliseconds. Requests must satisfy `now < expiresAt <= now + 90000`; the service caps the stored lease at `now + 60000`.

Registration uses `PUT /v1/instances/{instanceId}/nodes/{endpointId}`:

```json
{
  "protocol": "rightdata/relay/1",
  "endpointId": "<64 lowercase hex characters>",
  "directAddresses": ["192.168.1.20:4433", "[2001:db8::20]:4433"],
  "relayUrl": "https://relay.example.com",
  "expiresAt": 1790000000000,
  "signature": "<standard padded Base64>"
}
```

Direct addresses must be sorted, unique numeric IP socket strings. Loopback and private addresses are valid. Hostnames are rejected and the service never resolves DNS for direct addresses. `relayUrl` is optional and must be HTTPS without embedded credentials or a fragment.

Unregister with `DELETE` on the same endpoint path and body:

```json
{
  "protocol": "rightdata/relay/1",
  "endpointId": "<same endpoint id>",
  "expiresAt": 1790000000000,
  "signature": "<standard padded Base64>"
}
```

Sign these UTF-8 bytes with Ed25519:

```text
UPPERCASE_METHOD + "\n" + canonical_path + "\n" + decimal_expiresAt + "\n" + canonical_json(payload_without_signature)
```

Canonical JSON sorts object keys by Unicode code point, preserves array order, uses JSON scalar encoding, and contains no whitespace. The canonical path has no query string. Reusing a valid signature before its timestamp expires returns `409 replayed_signature`.

`GET /v1/instances/{instanceId}/nodes` returns:

```json
{
  "protocol": "rightdata/discovery/1",
  "instanceId": "example",
  "generatedAt": 1790000000000,
  "nodes": [
    {
      "protocol": "rightdata/relay/1",
      "endpointId": "<endpoint id>",
      "directAddresses": ["192.168.1.20:4433"],
      "relayUrl": "https://relay.example.com/",
      "expiresAt": 1790000060000
    }
  ]
}
```

Nodes are sorted by endpoint ID. Signatures are never returned. `GET /healthz` is available for local health checks.

## 客户端节点选择

发现服务只返回短租约节点，不发布健康度或负载。客户端网络服务在本机内存中维护每个节点的连接质量：成功建立后端隧道会更新连接延迟 EWMA，活动隧道计入当前 in-flight 负载，连接失败会触发从 250 毫秒开始、最长 8 秒的指数退避。

每次需要 peer 路径时，客户端从未处于退避期的节点中选择“延迟 EWMA + in-flight 负载惩罚”最低者；同分时按 endpoint ID 稳定排序。单次请求最多尝试 3 个不同节点，并继续受 8 秒总连接截止时间约束。失败节点在退避期结束后会重新参与选择，成功后清除连续失败状态。统计不写入发现协议、不跨进程持久化，也不改变 `allowPublicRelay`：关闭公网 relay 时仍只使用发现结果中的直连地址。

桌面客户端发往本机代理的业务请求使用 HTTP/1，并且不保留空闲连接。单个请求及流式响应在同一条隧道上完成；下一个独立请求会新建代理隧道，让网络服务重新按当前健康、延迟和负载评分选择节点。

本机代理连接预算为 15 秒，经代理执行的服务探测总预算为 20 秒，覆盖网络服务最长 8 秒的 peer 建链与节点重试截止时间。仅在调试构建且网络服务不存在时使用的直接请求仍保持 4 秒探测预算。

客户端冷启动时一次有效的本地探测即可进入 direct 模式。已经通过 peer 提供服务时，本地 direct 路径必须连续两次探测成功才切回；其间一次失败会清零确认次数，但不会把仍可用的 peer 状态标记为离线。

## 本机服务开机启动偏好

网络服务把 SCM 当前启动类型与用户选择分开管理。SCM 查询结果用于状态接口的 `autoStart`；用户在客户端明确启用或关闭后，选择写入网络服务数据目录的 `startup.json`，不会混入可能被连接设置整体覆盖的 `network.json`。

发现登记成功后，只有 `startup.json` 尚不存在且 SCM 当前不是自动启动时，服务才应用一次默认自动启动策略。显式保存的 `false` 会阻止后续维护循环重新开启自动启动；显式 `true` 同样持久保留。设置操作先可靠保存用户选择，再修改固定的 `RightDataNetwork` 服务启动类型；SCM 修改失败时接口返回错误，且不会把实际 `autoStart` 状态伪报为成功。损坏或版本不兼容的偏好文件会阻止服务启动，避免把未知状态误当作“从未选择”。

只有由 Windows SCM 调用的服务入口可以查询或修改固定服务的启动类型。独立运行、自定义管道调试和测试进程会收到明确的不支持错误，不会读取或改动已安装的 `RightDataNetwork` 服务。

## Run and test

Requires Node.js 20 or newer and no npm dependencies.

```bash
DISCOVERY_HOST=127.0.0.1 DISCOVERY_PORT=8090 node /opt/rightdata/discovery/server.mjs
node --test test/client/discovery-service.test.mjs
```

The service limits JSON bodies to 16 KiB, requests to 120 per source IP per minute, each instance to 256 nodes, and the process to 10,000 live nodes. Set `DISCOVERY_MAX_BODY_BYTES` or `DISCOVERY_RATE_LIMIT_PER_MINUTE` to lower those limits. Only set `DISCOVERY_TRUST_PROXY=1` when the listener is reachable solely through a trusted local reverse proxy.

## systemd and TLS proxy

Copy `server.mjs` to `/opt/rightdata/discovery/`, copy `rightdata-discovery.service` to `/etc/systemd/system/`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rightdata-discovery
```

Terminate TLS at a reverse proxy and keep Node bound to loopback. An nginx location can proxy the API as follows; configure the certificate with the site's normal ACME workflow.

```nginx
server {
    listen 443 ssl http2;
    server_name discovery.example.com;
    ssl_certificate /etc/letsencrypt/live/discovery.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/discovery.example.com/privkey.pem;

    client_max_body_size 16k;
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_http_version 1.1;
    }
}
```
