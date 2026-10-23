use crate::error::{ErrorKind, Result, TransportError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[cfg(windows)]
const PIPE_NAME: &str = r"\\.\pipe\rightdata-network-v1";
const PROTOCOL_VERSION: u8 = 1;
const MAX_FRAME_SIZE: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub server_url: String,
    pub discovery_url: Option<String>,
    pub bound_instance_id: Option<String>,
    pub allow_public_relay: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ServiceStatus {
    pub running: bool,
    pub enabled: bool,
    pub auto_start: bool,
    pub device_id: String,
    pub server_url: String,
    pub discovery_url: Option<String>,
    pub bound_instance_id: Option<String>,
    pub allow_public_relay: bool,
    pub proxy_url: Option<String>,
    pub proxy_token: Option<String>,
    pub mode: String,
    pub ready: bool,
    pub peer_id: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipeRequest<'a> {
    v: u8,
    id: String,
    op: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<&'a ServiceConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auto_start: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PipeResponse {
    v: u8,
    id: String,
    ok: bool,
    data: Option<Value>,
    error: Option<ServiceError>,
}

#[derive(Deserialize)]
struct ServiceError {
    code: String,
    message: String,
}

pub async fn status() -> Result<ServiceStatus> {
    call("status", None, None, None, None, None).await
}

pub async fn configure(config: &ServiceConfig) -> Result<ServiceStatus> {
    call("configure", Some(config), None, None, None, None).await
}

#[allow(dead_code)]
pub async fn set_enabled(enabled: bool) -> Result<ServiceStatus> {
    call(
        if enabled { "start" } else { "stop" },
        None,
        Some(enabled),
        None,
        None,
        None,
    )
    .await
}

#[allow(dead_code)]
pub async fn set_auto_start(auto_start: bool) -> Result<ServiceStatus> {
    call("autostart", None, None, Some(auto_start), None, None).await
}

pub async fn logs(limit: usize, offset: usize) -> Result<Value> {
    call("logs", None, None, None, Some(limit.min(100)), Some(offset)).await
}

impl From<ServiceStatus> for crate::models::NetworkServiceView {
    fn from(status: ServiceStatus) -> Self {
        Self {
            running: status.running,
            enabled: status.enabled,
            auto_start: status.auto_start,
            device_id: status.device_id,
            mode: status.mode,
            ready: status.ready,
            peer_id: status.peer_id,
        }
    }
}

async fn call<T: for<'de> Deserialize<'de>>(
    op: &str,
    config: Option<&ServiceConfig>,
    enabled: Option<bool>,
    auto_start: Option<bool>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<T> {
    let id = Uuid::new_v4().to_string();
    let request = PipeRequest {
        v: PROTOCOL_VERSION,
        id: id.clone(),
        op,
        config,
        enabled,
        auto_start,
        limit,
        offset,
    };
    let bytes = serde_json::to_vec(&request)
        .map_err(|_| TransportError::storage("无法编码本机网络服务请求"))?;
    if bytes.len() > MAX_FRAME_SIZE {
        return Err(TransportError::validation(
            "service_request_too_large",
            "本机网络服务请求过大",
        ));
    }
    let timeout = if matches!(op, "status" | "start") {
        std::time::Duration::from_secs(12)
    } else {
        std::time::Duration::from_secs(8)
    };
    let response = tokio::time::timeout(timeout, exchange(&bytes, op))
        .await
        .map_err(|_| service_timeout())??;
    let response: PipeResponse = serde_json::from_slice(&response)
        .map_err(|_| TransportError::storage("本机网络服务响应格式无效"))?;
    if response.v != PROTOCOL_VERSION || response.id != id {
        return Err(TransportError::new(
            ErrorKind::Network,
            "service_protocol_mismatch",
            "本机网络服务协议不匹配",
        ));
    }
    if !response.ok {
        let error = response.error.unwrap_or(ServiceError {
            code: "service_failed".into(),
            message: "本机网络服务操作失败".into(),
        });
        return Err(TransportError::new(
            ErrorKind::Network,
            error.code,
            error.message,
        ));
    }
    serde_json::from_value(response.data.unwrap_or(Value::Null))
        .map_err(|_| TransportError::storage("本机网络服务响应缺少数据"))
}

#[cfg(windows)]
async fn exchange(request: &[u8], op: &str) -> Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ClientOptions;

    let (pipe_name, custom_pipe) = pipe_target()?;
    let allow_scm_start = should_start_installed_service(op, custom_pipe);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut scm_start_attempted = false;
    let mut pipe = None;
    loop {
        match ClientOptions::new().open(&pipe_name) {
            Ok(client) => {
                pipe = Some(client);
                break;
            }
            Err(error)
                if error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_PIPE_BUSY as i32) =>
            {
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(error)
                if error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND as i32)
                    && allow_scm_start =>
            {
                if !scm_start_attempted {
                    start_installed_service()?;
                    scm_start_attempted = true;
                }
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Err(_) => break,
        }
    }
    let mut pipe = pipe.ok_or_else(service_unavailable)?;
    pipe.write_u32(request.len() as u32)
        .await
        .map_err(|_| service_unavailable())?;
    pipe.write_all(request)
        .await
        .map_err(|_| service_unavailable())?;
    pipe.flush().await.map_err(|_| service_unavailable())?;
    let length = pipe.read_u32().await.map_err(|_| service_unavailable())? as usize;
    if length == 0 || length > MAX_FRAME_SIZE {
        return Err(TransportError::new(
            ErrorKind::Network,
            "service_response_too_large",
            "本机网络服务响应大小无效",
        ));
    }
    let mut response = vec![0_u8; length];
    pipe.read_exact(&mut response)
        .await
        .map_err(|_| service_unavailable())?;
    Ok(response)
}

#[cfg(windows)]
fn pipe_target() -> Result<(String, bool)> {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os("RIGHTDATA_NETWORK_PIPE") {
        let value = value.to_string_lossy().into_owned();
        if !value.starts_with(r"\\.\pipe\rightdata-") || value.len() > 200 {
            return Err(TransportError::validation(
                "invalid_network_pipe",
                "RIGHTDATA_NETWORK_PIPE 名称无效",
            ));
        }
        return Ok((value, true));
    }
    Ok((PIPE_NAME.to_string(), false))
}

fn should_start_installed_service(op: &str, custom_pipe: bool) -> bool {
    !custom_pipe && matches!(op, "status" | "start")
}

#[cfg(windows)]
fn start_installed_service() -> Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_SERVICE_ALREADY_RUNNING, GetLastError};
    use windows_sys::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS,
        SERVICE_START, StartServiceW,
    };

    let manager = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
    if manager.is_null() {
        return Err(service_start_error(unsafe { GetLastError() }));
    }
    let service_name = OsStr::new("RightDataNetwork")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let service = unsafe {
        OpenServiceW(
            manager,
            service_name.as_ptr(),
            SERVICE_QUERY_STATUS | SERVICE_START,
        )
    };
    let open_error = service.is_null().then(|| unsafe { GetLastError() });
    unsafe {
        CloseServiceHandle(manager);
    }
    if let Some(error) = open_error {
        return Err(service_start_error(error));
    }
    let started = unsafe { StartServiceW(service, 0, std::ptr::null()) };
    let error = (started == 0).then(|| unsafe { GetLastError() });
    unsafe {
        CloseServiceHandle(service);
    }
    match error {
        None | Some(ERROR_SERVICE_ALREADY_RUNNING) => Ok(()),
        Some(error) => Err(service_start_error(error)),
    }
}

#[cfg(windows)]
fn service_start_error(error: u32) -> TransportError {
    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_SERVICE_DISABLED, ERROR_SERVICE_DOES_NOT_EXIST,
    };

    if error == ERROR_SERVICE_DOES_NOT_EXIST {
        return service_unavailable();
    }
    if error == ERROR_SERVICE_DISABLED {
        return TransportError::new(
            ErrorKind::Network,
            "network_service_disabled",
            "本机网络服务已被 Windows 禁用，请联系管理员启用",
        );
    }
    if error == ERROR_ACCESS_DENIED {
        return TransportError::new(
            ErrorKind::Network,
            "network_service_start_denied",
            "当前 Windows 用户无权启动本机网络服务",
        );
    }
    let mut result = TransportError::new(
        ErrorKind::Network,
        "network_service_start_failed",
        format!("无法启动本机网络服务（Windows 错误 {error}）"),
    );
    result.retryable = true;
    result
}

#[cfg(target_os = "macos")]
static MACOS_LAYOUT: std::sync::OnceLock<crate::launch_agent::AgentLayout> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
pub fn initialize_macos(resource_dir: &std::path::Path) -> Result<()> {
    let layout = crate::launch_agent::AgentLayout::current().map_err(macos_service_error)?;
    let mut source = resource_dir.join("rightdata-network-service");
    #[cfg(debug_assertions)]
    if !source.is_file() {
        source = std::env::current_exe().map_err(macos_service_error)?.parent()
            .ok_or_else(service_unavailable)?.join("rightdata-network-service");
    }
    let auto_start = match std::fs::read(layout.root.join("startup.json")) {
        Ok(bytes) => {
            let document: Value = serde_json::from_slice(&bytes)
                .map_err(|_| TransportError::storage("网络服务启动偏好损坏"))?;
            if document.get("version").and_then(Value::as_u64) != Some(1) {
                return Err(TransportError::storage("网络服务启动偏好版本不兼容"));
            }
            document.get("autoStart").and_then(Value::as_bool)
                .ok_or_else(|| TransportError::storage("网络服务启动偏好无效"))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(macos_service_error(error)),
    };
    crate::launch_agent::install_helper(&layout, &source, auto_start).map_err(macos_service_error)?;
    MACOS_LAYOUT.set(layout).map_err(|_| TransportError::storage("网络服务已经初始化"))
}

#[cfg(target_os = "macos")]
fn macos_service_error(error: std::io::Error) -> TransportError {
    TransportError::new(ErrorKind::Network, "network_service_start_failed", format!("无法启动本机网络服务：{error}"))
}

#[cfg(target_os = "macos")]
async fn exchange(request: &[u8], op: &str) -> Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;
    static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let layout = MACOS_LAYOUT.get().ok_or_else(service_unavailable)?;
    let mut socket_path = layout.socket();
    let mut custom_socket = false;
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("RIGHTDATA_NETWORK_SOCKET") {
        socket_path = std::path::PathBuf::from(path);
        if !socket_path.is_absolute() {
            return Err(TransportError::validation("invalid_network_socket", "测试套接字必须是绝对路径"));
        }
        custom_socket = true;
    }
    let mut socket = match UnixStream::connect(&socket_path).await {
        Ok(stream) => stream,
        Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused)
            && should_start_installed_service(op, custom_socket) => {
            let _start_guard = START_LOCK.lock().await;
            if let Ok(stream) = UnixStream::connect(&socket_path).await {
                stream
            } else {
                let layout = layout.clone();
                tokio::task::spawn_blocking(move || crate::launch_agent::start(&layout))
                    .await.map_err(|_| service_unavailable())?.map_err(macos_service_error)?;
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
                loop {
                    if let Ok(stream) = UnixStream::connect(&socket_path).await { break stream; }
                    if tokio::time::Instant::now() >= deadline { return Err(service_unavailable()); }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
        Err(_) => return Err(service_unavailable()),
    };
    if socket.peer_cred().map_err(|_| service_unavailable())?.uid() != unsafe { libc::geteuid() } {
        return Err(TransportError::new(ErrorKind::Network, "network_service_owner_mismatch", "本机网络服务不属于当前用户"));
    }
    socket.write_u32(request.len() as u32).await.map_err(|_| service_unavailable())?;
    socket.write_all(request).await.map_err(|_| service_unavailable())?;
    socket.flush().await.map_err(|_| service_unavailable())?;
    let length = socket.read_u32().await.map_err(|_| service_unavailable())? as usize;
    if length == 0 || length > MAX_FRAME_SIZE {
        return Err(TransportError::new(ErrorKind::Network, "service_response_too_large", "本机网络服务响应大小无效"));
    }
    let mut response = vec![0; length];
    socket.read_exact(&mut response).await.map_err(|_| service_unavailable())?;
    Ok(response)
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn exchange(_request: &[u8], _op: &str) -> Result<Vec<u8>> {
    Err(service_unavailable())
}

fn service_unavailable() -> TransportError {
    let mut error = TransportError::new(
        ErrorKind::Network,
        "network_service_unavailable",
        "本机网络服务不可用",
    );
    error.retryable = true;
    error
}

fn service_timeout() -> TransportError {
    let mut error = TransportError::new(
        ErrorKind::Timeout,
        "network_service_timeout",
        "本机网络服务响应超时",
    );
    error.retryable = true;
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configure_frame_matches_v1_contract_without_credentials() {
        let config = ServiceConfig {
            server_url: "https://rightdata.internal".into(),
            discovery_url: Some("https://discovery.example".into()),
            bound_instance_id: Some("instance-1".into()),
            allow_public_relay: false,
            enabled: true,
        };
        let request = PipeRequest {
            v: PROTOCOL_VERSION,
            id: "request-1".into(),
            op: "configure",
            config: Some(&config),
            enabled: None,
            auto_start: None,
            limit: None,
            offset: None,
        };
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["v"], 1);
        assert_eq!(value["op"], "configure");
        assert_eq!(value["config"]["boundInstanceId"], "instance-1");
        assert_eq!(value["config"]["enabled"], true);
        assert!(value.get("proxyToken").is_none());
    }

    #[test]
    fn scm_start_is_limited_to_default_pipe_status_and_explicit_start() {
        assert!(should_start_installed_service("status", false));
        assert!(should_start_installed_service("start", false));
        assert!(!should_start_installed_service("configure", false));
        assert!(!should_start_installed_service("status", true));
        assert!(!should_start_installed_service("start", true));
    }

    #[cfg(windows)]
    #[test]
    fn scm_errors_preserve_debug_fallback_and_admin_policy() {
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_SERVICE_DISABLED, ERROR_SERVICE_DOES_NOT_EXIST,
        };

        assert_eq!(
            service_start_error(ERROR_SERVICE_DOES_NOT_EXIST).code,
            "network_service_unavailable"
        );
        assert_eq!(
            service_start_error(ERROR_SERVICE_DISABLED).code,
            "network_service_disabled"
        );
        assert_eq!(
            service_start_error(ERROR_ACCESS_DENIED).code,
            "network_service_start_denied"
        );
    }
}
