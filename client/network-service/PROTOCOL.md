# RightData network protocol v1

The service owns transport and device identity. Tauri owns each user's business session. The service does not store passwords, business tokens, bodies or database results.

## Local control

Windows named pipe: `\\.\pipe\rightdata-network-v1`. Test instances select another pipe with `RIGHTDATA_NETWORK_PIPE`. Remote pipe clients are rejected. The DACL grants access only to SYSTEM, Administrators and the installation-bound controller SID, excluding permission to create pipe instances. Other interactive users cannot change the shared target or read the loopback proxy credential. Each connection carries one request and one response. A frame is a 4-byte big-endian length followed by UTF-8 JSON, at most 64 KiB.

Request: `{ "v":1, "id":"uuid", "op":"status|configure|start|stop|autostart|logs", "config":{}, "autoStart":false, "limit":50, "offset":0 }`.

Response: `{ "v":1, "id":"same uuid", "ok":true, "data":{} }`, or `{ "v":1, "id":"same uuid", "ok":false, "error":{"code":"...","message":"..."} }`.

`configure` takes `{serverUrl, discoveryUrl?, boundInstanceId?, allowPublicRelay}`. `stop` pauses local transport and registration without terminating the control pipe; `start` resumes it. `autostart` changes only the SCM startup configuration. `status` and configuration commands return `{running,enabled,autoStart,deviceId,serverUrl,discoveryUrl,boundInstanceId,allowPublicRelay,proxyUrl,proxyToken,mode,ready,peerId?,lastError?}`.

The proxy token is for the native caller only. Do not send it to the WebView or persist it in browser storage. Configure reqwest with the loopback proxy and HTTP Basic credentials `rightdata:<proxyToken>`. The proxy accepts only the configured backend host and port; HTTP requests additionally require an `/api` path. HTTPS is tunneled end to end. Production peer transport rejects plain HTTP. A debug build can opt in for isolated tests with `RIGHTDATA_ALLOW_INSECURE_PEER_TEST=1`.

## Peer streams

ALPN: `rightdata/relay/1`. Device identities are independent, persisted iroh Ed25519 keys. Each bidirectional stream starts with a framed JSON request `{v:1,op:"tcp-tunnel",expectedInstanceId:"...",targetAlias:"backend"}`. The node verifies that its directly reachable backend probe matches its configured instance and the requested instance. A successful framed reply is `{v:1,ok:true}`; the remaining stream is a TCP byte tunnel to that fixed backend. There is no caller-provided host, port or URL. An iroh device identity is not a business authorization: first-time external clients can reach the login endpoint through a node, and the backend authenticates every business request inside TLS. Peer setup, per-device connections and streams have separate concurrency limits from local traffic, with setup and idle timeouts. A stream retains its selected node for its lifetime.

When public business relay is disabled, the iroh endpoint has no relay transport or external address lookup and only dials registered direct addresses from the configured discovery service. Enabling public relay explicitly creates a separate endpoint configuration with relay transport. Tauri validates the backend HTTPS certificate through the tunnel, then validates `/api/probe` before sending business credentials.

## Discovery

Signed registration and lookup use `/v1/instances/{instanceId}/nodes/{endpointId}` and the parent collection. Leases last 60 seconds and refresh every 20 seconds. See `deploy/discovery/README.md` for the canonical signature format. Discovery receives neither backend URLs nor business credentials. A node registers only while its own backend is directly ready. Expired leases disappear automatically.
