use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectionSettings {
    pub server_url: String,
    pub discovery_url: Option<String>,
    pub allow_public_relay: bool,
    pub bound_instance_id: Option<String>,
}

impl Default for ConnectionSettings {
    fn default() -> Self {
        Self {
            server_url: "http://127.0.0.1:8003".to_string(),
            discovery_url: None,
            allow_public_relay: false,
            bound_instance_id: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureInput {
    pub server_url: String,
    #[serde(default)]
    pub discovery_url: Option<String>,
    #[serde(default)]
    pub allow_public_relay: bool,
    #[serde(default)]
    pub rebind_instance: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub mode: ConnectionMode,
    pub instance_id: Option<String>,
    pub api_version: Option<String>,
    pub ready: bool,
    pub peer_available: bool,
    pub latency_ms: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ConnectionMode {
    #[default]
    Disconnected,
    Direct,
    Peer,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub authenticated: bool,
    pub user: Option<Value>,
    pub remember: bool,
    pub expires_in: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportStateView {
    pub settings: ConnectionSettings,
    pub connection: ConnectionStatus,
    pub session: SessionView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeData {
    pub service: String,
    pub instance_id: String,
    pub api_version: String,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    #[serde(flatten)]
    pub probe: ProbeData,
    pub mode: ConnectionMode,
    pub latency_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    pub username: String,
    pub password: String,
    #[serde(default = "default_true")]
    pub remember: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResult {
    pub authenticated: bool,
    pub user: Option<Value>,
    pub expires_in: Option<u64>,
    pub remember: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutResult {
    pub logged_out: bool,
    pub remote_revoked: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequestInput {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub body: Option<Value>,
    pub timeout_ms: Option<u64>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub data: Value,
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadInput {
    pub method: Option<String>,
    pub path: String,
    pub file_path: Option<String>,
    pub bytes: Option<Vec<u8>>,
    pub file_name: Option<String>,
    pub field_name: Option<String>,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    pub media_type: Option<String>,
    pub timeout_ms: Option<u64>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInput {
    pub path: String,
    pub destination_path: Option<String>,
    pub suggested_name: Option<String>,
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadReadInput {
    pub path: String,
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportLogEntry {
    pub id: String,
    pub created_at: String,
    pub action: String,
    pub target: String,
    pub outcome: String,
    pub duration_ms: u64,
    pub request_id: Option<String>,
    pub mode: String,
    pub status: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportLogsInput {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportLogsResult {
    pub items: Vec<TransportLogEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkServiceView {
    pub running: bool,
    pub enabled: bool,
    pub auto_start: bool,
    pub device_id: String,
    pub mode: String,
    pub ready: bool,
    pub peer_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEnabledInput {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAutoStartInput {
    pub auto_start: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub saved: bool,
    pub path: Option<String>,
    pub size: u64,
    pub sha256: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileInput {
    pub suggested_name: String,
    pub bytes: Option<Vec<u8>>,
    pub source_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileResult {
    pub saved: bool,
    pub path: Option<String>,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInput {
    pub resource_id: String,
    pub title: Option<String>,
    #[serde(default)]
    pub draft: Value,
    pub params: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub label: String,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStateResult {
    pub resource: Value,
    pub params: Option<Value>,
}
