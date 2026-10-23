use crate::client_events::{ClientEventOutcome, ClientEventQueue};
use crate::error::{ErrorKind, Result, TransportError};
use crate::models::*;
use crate::network_service::{self, ServiceConfig};
use crate::screen::{ScreenManager, ScreenPrepareInput, ScreenPrepareResult, ScreenReleaseInput};
use crate::transport::{AppState, build_api_url, parse_api_response, validate_command_api_path};
use crate::updater::{UpdateCheckResult, UpdateDownloadResult, UpdateInstallResult, UpdateManager};
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

const MAX_MEMORY_UPLOAD: usize = 50 * 1024 * 1024;
const MAX_MEMORY_SAVE: usize = 256 * 1024 * 1024;
const MAX_PREVIEW_STATE: usize = 1024 * 1024;
const MAX_DOWNLOAD_SIZE: u64 = 8 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_READ_SIZE: u64 = 64 * 1024 * 1024;

#[derive(Default)]
pub struct PreviewStore(std::sync::Mutex<BTreeMap<String, PreviewStateResult>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEventInput {
    pub job_id: String,
    pub outcome: ClientEventOutcome,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateVersionInput {
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEventStatus {
    pub pending: usize,
    pub rejected: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl PreviewStore {
    fn insert(&self, label: String, value: PreviewStateResult) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| TransportError::storage("无法保存预览状态"))?
            .insert(label, value);
        Ok(())
    }

    fn get(&self, label: &str) -> Result<PreviewStateResult> {
        self.0
            .lock()
            .map_err(|_| TransportError::storage("无法读取预览状态"))?
            .get(label)
            .cloned()
            .ok_or_else(|| TransportError::validation("preview_state_missing", "预览状态已失效"))
    }

    fn remove(&self, label: &str) {
        if let Ok(mut values) = self.0.lock() {
            values.remove(label);
        }
    }

    fn clear(&self) {
        if let Ok(mut values) = self.0.lock() {
            values.clear();
        }
    }
}

#[tauri::command]
pub async fn transport_get_state(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<TransportStateView> {
    require_trusted_window(&window)?;
    Ok(state.state_view().await)
}

#[tauri::command]
pub async fn transport_get_logs(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    request: TransportLogsInput,
) -> Result<TransportLogsResult> {
    require_main_window(&window)?;
    let limit = request.limit.unwrap_or(50).clamp(1, 200);
    let offset = request.offset.unwrap_or_default().min(10_000);
    let mut all = state.transport_logs().await;
    let service_fetch = (offset + limit + all.len()).min(2_000);
    let mut service_offset = 0;
    while service_offset < service_fetch {
        let page_size = (service_fetch - service_offset).min(100);
        let Ok(page) = network_service::logs(page_size, service_offset).await else {
            break;
        };
        let values = page
            .get("items")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = values.len();
        all.extend(values.iter().filter_map(service_log_entry));
        if count < page_size {
            break;
        }
        service_offset += count;
    }
    all.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    let items = all.into_iter().skip(offset).take(limit).collect();
    Ok(TransportLogsResult { items })
}

fn service_log_entry(value: &serde_json::Value) -> Option<TransportLogEntry> {
    Some(TransportLogEntry {
        id: value.get("id")?.as_str()?.to_string(),
        created_at: value.get("createdAt")?.as_str()?.to_string(),
        action: value.get("action")?.as_str()?.to_string(),
        target: value.get("target")?.as_str()?.to_string(),
        outcome: value.get("outcome")?.as_str()?.to_string(),
        duration_ms: value.get("durationMs")?.as_u64()?,
        request_id: value
            .get("requestId")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        mode: value
            .get("mode")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("disconnected")
            .to_string(),
        status: value
            .get("status")
            .and_then(serde_json::Value::as_u64)
            .and_then(|status| u16::try_from(status).ok()),
    })
}

#[tauri::command]
pub async fn transport_configure(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    previews: tauri::State<'_, PreviewStore>,
    screens: tauri::State<'_, ScreenManager>,
    request: ConfigureInput,
) -> Result<TransportStateView> {
    require_main_window(&window)?;
    let previous = state.state_view().await.settings;
    let service_status = network_service::status().await;
    if let Ok(status) = &service_status {
        let previous_instance = (!request.rebind_instance
            && previous.server_url.trim_end_matches('/')
                == request.server_url.trim().trim_end_matches('/'))
        .then(|| previous.bound_instance_id.clone())
        .flatten();
        network_service::configure(&ServiceConfig {
            server_url: request.server_url.clone(),
            discovery_url: request.discovery_url.clone(),
            bound_instance_id: previous_instance,
            allow_public_relay: request.allow_public_relay,
            enabled: status.enabled,
        })
        .await?;
    } else if let Err(error) = &service_status
        && (!cfg!(debug_assertions) || error.code != "network_service_unavailable")
    {
        return Err(error.clone());
    }

    let result = state.configure(request).await?;
    if let Ok(status) = service_status {
        network_service::configure(&ServiceConfig {
            server_url: result.settings.server_url.clone(),
            discovery_url: result.settings.discovery_url.clone(),
            bound_instance_id: result.settings.bound_instance_id.clone(),
            allow_public_relay: result.settings.allow_public_relay,
            enabled: status.enabled,
        })
        .await?;
    }
    if !result.session.authenticated {
        clear_preview_windows(&app, &previews);
    }
    screens.clear();
    Ok(result)
}

#[tauri::command]
pub async fn network_service_get_state(window: WebviewWindow) -> Result<NetworkServiceView> {
    require_main_window(&window)?;
    network_service::status().await.map(Into::into)
}

#[tauri::command]
pub async fn network_service_set_enabled(
    window: WebviewWindow,
    request: ServiceEnabledInput,
) -> Result<NetworkServiceView> {
    require_main_window(&window)?;
    network_service::set_enabled(request.enabled)
        .await
        .map(Into::into)
}

#[tauri::command]
pub async fn network_service_set_autostart(
    window: WebviewWindow,
    request: ServiceAutoStartInput,
) -> Result<NetworkServiceView> {
    require_main_window(&window)?;
    network_service::set_auto_start(request.auto_start)
        .await
        .map(Into::into)
}

#[tauri::command]
pub async fn export_event_enqueue(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    queue: tauri::State<'_, ClientEventQueue>,
    request: ExportEventInput,
) -> Result<()> {
    require_main_window(&window)?;
    let (binding, _) = state.client_event_context().await?;
    queue.enqueue_export(&binding, &request.job_id, request.outcome)?;
    let _ = flush_pending_client_events(&app).await;
    Ok(())
}

#[tauri::command]
pub fn export_event_status(
    window: WebviewWindow,
    queue: tauri::State<'_, ClientEventQueue>,
) -> Result<ExportEventStatus> {
    require_main_window(&window)?;
    let diagnostics = queue.diagnostics()?;
    let last_error = diagnostics
        .initialization_error
        .or_else(|| diagnostics.last_rejection.map(|rejection| rejection.reason));
    Ok(ExportEventStatus {
        pending: diagnostics.pending,
        rejected: diagnostics.rejected,
        last_error,
    })
}

#[tauri::command]
pub async fn client_update_check(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    updater: tauri::State<'_, UpdateManager>,
) -> Result<UpdateCheckResult> {
    require_main_window(&window)?;
    let (client, settings, token) = state.update_context().await?;
    updater
        .check(
            &client,
            &settings.server_url,
            token.as_deref(),
            env!("CARGO_PKG_VERSION"),
        )
        .await
}

#[tauri::command]
pub async fn client_update_download(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    updater: tauri::State<'_, UpdateManager>,
    request: UpdateVersionInput,
) -> Result<UpdateDownloadResult> {
    require_main_window(&window)?;
    let (client, _, token) = state.update_context().await?;
    updater
        .download(&client, token.as_deref(), &request.version)
        .await
}

#[tauri::command]
pub async fn client_update_install(
    window: WebviewWindow,
    updater: tauri::State<'_, UpdateManager>,
    request: UpdateVersionInput,
) -> Result<UpdateInstallResult> {
    require_main_window(&window)?;
    updater.install(&request.version).await
}

pub async fn flush_pending_client_events(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let queue = app.state::<ClientEventQueue>();
    let (binding, _) = match state.client_event_context().await {
        Ok(context) => context,
        Err(error) if error.status == Some(401) => return Ok(()),
        Err(error) => return Err(error),
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    for event in queue.ready(&binding, now_ms, 20)? {
        let body = serde_json::to_value(&event)
            .map_err(|_| TransportError::storage("无法编码客户端事件"))?;
        let started = std::time::Instant::now();
        let result = state
            .api_request(ApiRequestInput {
                method: "POST".into(),
                path: "/api/v1/client-events".into(),
                query: BTreeMap::new(),
                headers: BTreeMap::new(),
                body: Some(body),
                timeout_ms: Some(20_000),
                idempotency_key: Some(event.event_id.clone()),
            })
            .await;
        match result {
            Ok(response)
                if response
                    .data
                    .pointer("/data/eventId")
                    .and_then(serde_json::Value::as_str)
                    == Some(event.event_id.as_str()) =>
            {
                queue.acknowledge(&event.event_id)?;
                state
                    .record_transport(
                        "CLIENT_EVENT",
                        "/api/v1/client-events",
                        Some(response.status),
                        response.request_id,
                        true,
                        started.elapsed(),
                    )
                    .await;
            }
            Ok(_) => {
                queue.mark_retry(&event.event_id, now_ms)?;
                break;
            }
            Err(error)
                if error
                    .status
                    .is_some_and(|status| (400..500).contains(&status))
                    && error.status != Some(401)
                    && error.status != Some(408)
                    && error.status != Some(429) =>
            {
                let reason = format!("{}: {}", error.code, error.message);
                queue.reject_permanent(&event.event_id, &reason, now_ms)?;
                state
                    .record_transport(
                        "CLIENT_EVENT_REJECTED",
                        &error.code,
                        error.status,
                        error.request_id,
                        false,
                        started.elapsed(),
                    )
                    .await;
            }
            Err(_) => {
                queue.mark_retry(&event.event_id, now_ms)?;
                break;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn transport_probe(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<ProbeResult> {
    require_main_window(&window)?;
    state.probe_current().await
}

#[tauri::command]
pub async fn auth_login(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    previews: tauri::State<'_, PreviewStore>,
    screens: tauri::State<'_, ScreenManager>,
    request: LoginInput,
) -> Result<AuthResult> {
    require_main_window(&window)?;
    let result = state.login(request).await?;
    clear_preview_windows(&app, &previews);
    screens.clear();
    Ok(result)
}

#[tauri::command]
pub async fn auth_restore(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<AuthResult> {
    require_main_window(&window)?;
    state.restore().await
}

#[tauri::command]
pub async fn auth_logout(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    previews: tauri::State<'_, PreviewStore>,
    screens: tauri::State<'_, ScreenManager>,
) -> Result<LogoutResult> {
    require_main_window(&window)?;
    let result = state.logout().await?;
    screens.clear();
    previews.clear();
    for (label, preview) in app.webview_windows() {
        if label.starts_with("preview-") {
            let _ = preview.close();
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn api_request(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    previews: tauri::State<'_, PreviewStore>,
    screens: tauri::State<'_, ScreenManager>,
    request: ApiRequestInput,
) -> Result<ApiResponse> {
    require_trusted_window(&window)?;
    let method = request.method.clone();
    let path = request.path.clone();
    let started = std::time::Instant::now();
    let result = state.api_request(request).await;
    let status = result
        .as_ref()
        .map(|value| value.status)
        .unwrap_or_else(|error| error.status.unwrap_or_default());
    let request_id = result
        .as_ref()
        .map(|value| value.request_id.clone())
        .unwrap_or_else(|error| error.request_id.clone());
    state
        .record_transport(
            &method,
            &path,
            (status != 0).then_some(status),
            request_id,
            result.is_ok(),
            started.elapsed(),
        )
        .await;
    if result
        .as_ref()
        .is_err_and(|error| error.status == Some(401))
    {
        notify_session_expired(&app, &previews, &screens);
    }
    result
}

#[tauri::command]
pub async fn api_upload(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    previews: tauri::State<'_, PreviewStore>,
    screens: tauri::State<'_, ScreenManager>,
    request: UploadInput,
) -> Result<ApiResponse> {
    require_trusted_window(&window)?;
    let log_method = request.method.clone().unwrap_or_else(|| "POST".into());
    let log_path = request.path.clone();
    let log_started = std::time::Instant::now();
    if request.file_path.is_some() && window.label() != "main" {
        return Err(TransportError::new(
            ErrorKind::Auth,
            "window_not_allowed",
            "预览窗口不能读取本地文件路径",
        ));
    }
    let source_count =
        usize::from(request.file_path.is_some()) + usize::from(request.bytes.is_some());
    if source_count != 1 {
        return Err(TransportError::validation(
            "invalid_upload_source",
            "上传必须且只能提供文件路径或文件字节",
        ));
    }
    if request
        .bytes
        .as_ref()
        .is_some_and(|bytes| bytes.len() > MAX_MEMORY_UPLOAD)
    {
        return Err(TransportError::validation(
            "upload_too_large",
            "内存上传最多支持 50 MB",
        ));
    }
    let (settings, token) = state.settings_and_token().await?;
    let url = build_api_url(&settings.server_url, &request.path, &BTreeMap::new())?;
    validate_command_api_path(url.path())?;
    let method = match request
        .method
        .as_deref()
        .unwrap_or("POST")
        .to_ascii_uppercase()
        .as_str()
    {
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        _ => {
            return Err(TransportError::validation(
                "invalid_upload_method",
                "上传仅支持 POST 或 PUT",
            ));
        }
    };
    let form = upload_form(&request).await?;
    let client = state.client().await?;
    let mut builder = client
        .request(method, url)
        .bearer_auth(token)
        .multipart(form);
    if let Some(key) = request.idempotency_key.as_deref() {
        validate_short_value(key, "幂等标识")?;
        builder = builder.header("Idempotency-Key", key);
    }
    let response = builder
        .timeout(request_timeout(request.timeout_ms))
        .send()
        .await
        .map_err(TransportError::from_reqwest);
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            state.mark_disconnected(&error).await;
            return Err(error);
        }
    };
    if response.status() == StatusCode::UNAUTHORIZED {
        let _ = response.bytes().await;
        if let Err(error) = state.refresh_after_unauthorized().await {
            if error.status == Some(401) {
                notify_session_expired(&app, &previews, &screens);
            }
            return Err(error);
        }
        return Err(TransportError::server(
            409,
            "request_not_replayed",
            "登录已续期，请重新提交上传",
            None,
        ));
    }
    let result = parse_api_response(response).await;
    let status = result
        .as_ref()
        .map(|value| value.status)
        .unwrap_or_else(|error| error.status.unwrap_or_default());
    let request_id = result
        .as_ref()
        .map(|value| value.request_id.clone())
        .unwrap_or_else(|error| error.request_id.clone());
    state
        .record_transport(
            &log_method,
            &log_path,
            (status != 0).then_some(status),
            request_id,
            result.is_ok(),
            log_started.elapsed(),
        )
        .await;
    result
}

#[tauri::command]
pub async fn api_download(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    previews: tauri::State<'_, PreviewStore>,
    screens: tauri::State<'_, ScreenManager>,
    request: DownloadInput,
) -> Result<DownloadResult> {
    require_trusted_window(&window)?;
    let log_path = request.path.clone();
    let log_started = std::time::Instant::now();
    if request.destination_path.is_some() && window.label() != "main" {
        return Err(TransportError::new(
            ErrorKind::Auth,
            "window_not_allowed",
            "预览窗口不能指定本地保存路径",
        ));
    }
    let (destination, dialog_selected) = match request.destination_path.as_deref() {
        Some(value) => (validate_destination(value)?, false),
        None => match choose_save_path(&app, request.suggested_name.as_deref())? {
            Some(path) => (path, true),
            None => {
                return Ok(DownloadResult {
                    saved: false,
                    path: None,
                    size: 0,
                    sha256: None,
                    request_id: None,
                });
            }
        },
    };
    if destination.exists() && !request.overwrite && !dialog_selected {
        return Err(TransportError::validation(
            "destination_exists",
            "目标文件已存在",
        ));
    }
    let (settings, token) = state.settings_and_token().await?;
    let url = build_api_url(&settings.server_url, &request.path, &BTreeMap::new())?;
    validate_command_api_path(url.path())?;
    let client = state.client().await?;
    let response = client
        .get(url)
        .bearer_auth(token)
        .timeout(request_timeout(request.timeout_ms))
        .send()
        .await
        .map_err(TransportError::from_reqwest);
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            state.mark_disconnected(&error).await;
            return Err(error);
        }
    };
    if response.status() == StatusCode::UNAUTHORIZED {
        let _ = response.bytes().await;
        let token = match state.refresh_after_unauthorized().await {
            Ok(token) => token,
            Err(error) => {
                if error.status == Some(401) {
                    notify_session_expired(&app, &previews, &screens);
                }
                return Err(error);
            }
        };
        let url = build_api_url(&settings.server_url, &request.path, &BTreeMap::new())?;
        let client = state.client().await?;
        let response = client
            .get(url)
            .bearer_auth(token)
            .timeout(request_timeout(request.timeout_ms))
            .send()
            .await
            .map_err(TransportError::from_reqwest)?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let error = parse_api_response(response)
                .await
                .expect_err("401 response must be an error");
            state.clear_session().await?;
            notify_session_expired(&app, &previews, &screens);
            return Err(error);
        }
        let result = download_response(response, destination, true).await;
        let status = result
            .as_ref()
            .map(|_| 200)
            .ok()
            .or_else(|| result.as_ref().err().and_then(|error| error.status));
        let request_id = result
            .as_ref()
            .ok()
            .and_then(|value| value.request_id.clone())
            .or_else(|| {
                result
                    .as_ref()
                    .err()
                    .and_then(|error| error.request_id.clone())
            });
        state
            .record_transport(
                "GET",
                &log_path,
                status,
                request_id,
                result.is_ok(),
                log_started.elapsed(),
            )
            .await;
        return result;
    }
    let result =
        download_response(response, destination, request.overwrite || dialog_selected).await;
    let status = result
        .as_ref()
        .map(|_| 200)
        .ok()
        .or_else(|| result.as_ref().err().and_then(|error| error.status));
    let request_id = result
        .as_ref()
        .ok()
        .and_then(|value| value.request_id.clone())
        .or_else(|| {
            result
                .as_ref()
                .err()
                .and_then(|error| error.request_id.clone())
        });
    state
        .record_transport(
            "GET",
            &log_path,
            status,
            request_id,
            result.is_ok(),
            log_started.elapsed(),
        )
        .await;
    result
}

#[tauri::command]
pub async fn api_download_read(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    previews: tauri::State<'_, PreviewStore>,
    screens: tauri::State<'_, ScreenManager>,
    request: DownloadReadInput,
) -> Result<tauri::ipc::Response> {
    require_main_window(&window)?;
    let limit = request.max_bytes.unwrap_or(MAX_DOWNLOAD_READ_SIZE);
    if limit == 0 || limit > MAX_DOWNLOAD_READ_SIZE {
        return Err(TransportError::validation(
            "invalid_download_limit",
            "读取下载的大小限制必须在 1 字节至 64 MB 之间",
        ));
    }
    let (settings, mut token) = state.settings_and_token().await?;
    let url = build_api_url(&settings.server_url, &request.path, &BTreeMap::new())?;
    validate_export_download_path(url.path())?;
    let started = std::time::Instant::now();
    let client = state.client().await?;
    let mut response = client
        .get(url.clone())
        .bearer_auth(&token)
        .timeout(request_timeout(None))
        .send()
        .await
        .map_err(TransportError::from_reqwest)?;
    if response.status() == StatusCode::UNAUTHORIZED {
        let _ = response.bytes().await;
        token = match state.refresh_after_unauthorized().await {
            Ok(value) => value,
            Err(error) => {
                if error.status == Some(401) {
                    notify_session_expired(&app, &previews, &screens);
                }
                return Err(error);
            }
        };
        let client = state.client().await?;
        response = client
            .get(url)
            .bearer_auth(&token)
            .timeout(request_timeout(None))
            .send()
            .await
            .map_err(TransportError::from_reqwest)?;
    }
    let http_status = response.status().as_u16();
    let result = read_download_response(response, limit).await;
    if result
        .as_ref()
        .is_err_and(|error| error.status == Some(401))
    {
        state.clear_session().await?;
        notify_session_expired(&app, &previews, &screens);
    }
    state
        .record_transport(
            "GET",
            &request.path,
            Some(http_status),
            result
                .as_ref()
                .err()
                .and_then(|error| error.request_id.clone()),
            result.is_ok(),
            started.elapsed(),
        )
        .await;
    result.map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn desktop_save_file(
    window: WebviewWindow,
    app: AppHandle,
    request: SaveFileInput,
) -> Result<SaveFileResult> {
    require_trusted_window(&window)?;
    if request.source_path.is_some() && window.label() != "main" {
        return Err(TransportError::new(
            ErrorKind::Auth,
            "window_not_allowed",
            "预览窗口不能读取本地文件路径",
        ));
    }
    let source_count =
        usize::from(request.bytes.is_some()) + usize::from(request.source_path.is_some());
    if source_count != 1 {
        return Err(TransportError::validation(
            "invalid_save_source",
            "保存必须且只能提供文件字节或源文件路径",
        ));
    }
    if request
        .bytes
        .as_ref()
        .is_some_and(|bytes| bytes.len() > MAX_MEMORY_SAVE)
    {
        return Err(TransportError::validation(
            "file_too_large",
            "内存保存最多支持 256 MB",
        ));
    }
    let Some(destination) = choose_save_path(&app, Some(&request.suggested_name))? else {
        return Ok(SaveFileResult {
            saved: false,
            path: None,
            size: 0,
        });
    };
    let temporary = temporary_path(&destination);
    let result = async {
        let size = if let Some(bytes) = request.bytes.as_ref() {
            tokio::fs::write(&temporary, bytes)
                .await
                .map_err(|_| TransportError::storage("无法写入目标文件"))?;
            bytes.len() as u64
        } else {
            let source = request.source_path.as_deref().ok_or_else(|| {
                TransportError::validation("invalid_save_source", "缺少源文件路径")
            })?;
            validate_source_file(source)?;
            tokio::fs::copy(source, &temporary)
                .await
                .map_err(|_| TransportError::storage("无法复制源文件"))?
        };
        commit_file(&temporary, &destination, true).await?;
        Ok::<u64, TransportError>(size)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    let size = result?;
    Ok(SaveFileResult {
        saved: true,
        path: Some(destination.to_string_lossy().into_owned()),
        size,
    })
}

#[tauri::command]
pub fn app_exit(window: WebviewWindow, app: AppHandle) -> Result<()> {
    require_main_window(&window)?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn preview_open(
    window: WebviewWindow,
    app: AppHandle,
    previews: tauri::State<'_, PreviewStore>,
    screens: tauri::State<'_, ScreenManager>,
    request: PreviewInput,
) -> Result<PreviewResult> {
    require_main_window(&window)?;
    let resource_id = request.resource_id.trim();
    if resource_id.is_empty() || resource_id.len() > 256 {
        return Err(TransportError::validation(
            "invalid_resource_id",
            "预览资源标识无效",
        ));
    }
    let digest = Sha256::digest(resource_id.as_bytes());
    let label = format!("preview-{}", &hex::encode(digest)[..16]);
    let state_size = serde_json::to_vec(&serde_json::json!({
        "resource": &request.draft,
        "params": &request.params,
    }))
    .map_err(|_| TransportError::validation("invalid_preview_state", "预览内容无法编码"))?
    .len();
    if state_size > MAX_PREVIEW_STATE {
        return Err(TransportError::validation(
            "preview_state_too_large",
            "预览草稿和参数合计不能超过 1 MB",
        ));
    }
    previews.insert(
        label.clone(),
        PreviewStateResult {
            resource: request.draft,
            params: request.params,
        },
    )?;
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.emit("rightdata:preview-updated", ());
        existing.show().map_err(|_| {
            TransportError::new(ErrorKind::Storage, "preview_failed", "无法显示预览窗口")
        })?;
        existing.set_focus().map_err(|_| {
            TransportError::new(ErrorKind::Storage, "preview_failed", "无法激活预览窗口")
        })?;
        return Ok(PreviewResult {
            label,
            created: false,
        });
    }
    let encoded: String = url::form_urlencoded::byte_serialize(resource_id.as_bytes()).collect();
    let route = format!("index.html?preview={encoded}");
    let title = request.title.as_deref().unwrap_or("预览");
    let mut preview_builder =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(route.into()));
    if let Some(args) = crate::debug_browser_args() {
        preview_builder = preview_builder.additional_browser_args(&args);
    }
    let preview = preview_builder
        .title(title)
        .inner_size(1280.0, 800.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|_| {
            TransportError::new(ErrorKind::Storage, "preview_failed", "无法创建预览窗口")
        })?;
    let app_on_close = app.clone();
    let label_on_close = label.clone();
    let screens_on_close = screens.inner().clone();
    preview.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(store) = app_on_close.try_state::<PreviewStore>() {
                store.remove(&label_on_close);
            }
            screens_on_close.clear_window(&label_on_close);
        }
    });
    Ok(PreviewResult {
        label,
        created: true,
    })
}

#[tauri::command]
pub async fn preview_get_state(
    window: WebviewWindow,
    previews: tauri::State<'_, PreviewStore>,
) -> Result<PreviewStateResult> {
    if !window.label().starts_with("preview-") {
        return Err(TransportError::new(
            ErrorKind::Auth,
            "window_not_allowed",
            "仅预览窗口可以读取预览草稿",
        ));
    }
    previews.get(window.label())
}

#[tauri::command]
pub async fn screen_prepare(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    screens: tauri::State<'_, ScreenManager>,
    request: ScreenPrepareInput,
) -> Result<ScreenPrepareResult> {
    require_trusted_window(&window)?;
    let result = screens.prepare(&state, window.label(), request).await;
    if result
        .as_ref()
        .is_err_and(|error| error.status == Some(401))
    {
        screens.clear();
    }
    result
}

#[tauri::command]
pub fn screen_release(
    window: WebviewWindow,
    screens: tauri::State<'_, ScreenManager>,
    request: ScreenReleaseInput,
) -> Result<()> {
    require_trusted_window(&window)?;
    screens.release(window.label(), &request.base_url)
}

async fn upload_form(request: &UploadInput) -> Result<reqwest::multipart::Form> {
    let field_name = request.field_name.as_deref().unwrap_or("file");
    validate_short_value(field_name, "上传字段名")?;
    let mut part = if let Some(path) = request.file_path.as_deref() {
        validate_source_file(path)?;
        reqwest::multipart::Part::file(path)
            .await
            .map_err(|_| TransportError::validation("file_unreadable", "无法读取上传文件"))?
    } else {
        reqwest::multipart::Part::bytes(request.bytes.clone().unwrap_or_default())
    };
    if let Some(name) = request.file_name.as_deref() {
        part = part.file_name(safe_file_name(name)?);
    }
    if let Some(media_type) = request.media_type.as_deref() {
        part = part
            .mime_str(media_type)
            .map_err(|_| TransportError::validation("invalid_media_type", "文件媒体类型无效"))?;
    }
    let mut form = reqwest::multipart::Form::new().part(field_name.to_string(), part);
    for (name, value) in &request.fields {
        validate_short_value(name, "表单字段名")?;
        if value.len() > 64 * 1024 {
            return Err(TransportError::validation(
                "field_too_large",
                "上传表单字段过大",
            ));
        }
        form = form.text(name.clone(), value.clone());
    }
    Ok(form)
}

async fn download_response(
    response: reqwest::Response,
    destination: PathBuf,
    overwrite: bool,
) -> Result<DownloadResult> {
    let status = response.status().as_u16();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    if !(200..300).contains(&status) {
        return parse_api_response(response).await.map(|_| unreachable!());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOWNLOAD_SIZE)
    {
        return Err(TransportError::server(
            status,
            "download_too_large",
            "下载文件超过 8 GB 限制",
            request_id,
        ));
    }
    let temporary = temporary_path(&destination);
    let result = async {
        let mut file = tokio::fs::File::create(&temporary)
            .await
            .map_err(|_| TransportError::storage("无法创建目标文件"))?;
        let mut stream = response.bytes_stream();
        let mut size = 0_u64;
        let mut digest = Sha256::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(TransportError::from_reqwest)?;
            size = size.saturating_add(chunk.len() as u64);
            if size > MAX_DOWNLOAD_SIZE {
                return Err(TransportError::server(
                    status,
                    "download_too_large",
                    "下载文件超过 8 GB 限制",
                    request_id.clone(),
                ));
            }
            file.write_all(&chunk)
                .await
                .map_err(|_| TransportError::storage("无法写入下载文件"))?;
            digest.update(&chunk);
        }
        file.flush()
            .await
            .map_err(|_| TransportError::storage("无法提交下载文件"))?;
        drop(file);
        commit_file(&temporary, &destination, overwrite).await?;
        Ok::<(u64, String), TransportError>((size, hex::encode(digest.finalize())))
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    let (size, sha256) = result?;
    Ok(DownloadResult {
        saved: true,
        path: Some(destination.to_string_lossy().into_owned()),
        size,
        sha256: Some(sha256),
        request_id,
    })
}

async fn read_download_response(response: reqwest::Response, limit: u64) -> Result<Vec<u8>> {
    let status = response.status().as_u16();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    if !(200..300).contains(&status) {
        return parse_api_response(response).await.map(|_| unreachable!());
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(TransportError::server(
            status,
            "download_too_large",
            "下载结果超过读取限制",
            request_id,
        ));
    }
    let mut output = Vec::with_capacity(response.content_length().unwrap_or_default() as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(TransportError::from_reqwest)?;
        if (output.len() as u64).saturating_add(chunk.len() as u64) > limit {
            return Err(TransportError::server(
                status,
                "download_too_large",
                "下载结果超过读取限制",
                request_id,
            ));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn validate_export_download_path(path: &str) -> Result<()> {
    let segments: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    if segments.len() != 5
        || segments[0] != "api"
        || segments[1] != "v1"
        || segments[2] != "jobs"
        || segments[4] != "download"
        || segments[3].is_empty()
        || segments[3].len() > 128
        || !segments[3]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(TransportError::validation(
            "invalid_download_path",
            "仅读取导出任务下载结果",
        ));
    }
    Ok(())
}

fn choose_save_path(app: &AppHandle, suggested_name: Option<&str>) -> Result<Option<PathBuf>> {
    let mut dialog = app.dialog().file();
    if let Some(name) = suggested_name {
        dialog = dialog.set_file_name(safe_file_name(name)?);
    }
    let Some(path) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    path.into_path()
        .map(Some)
        .map_err(|_| TransportError::validation("invalid_destination", "目标文件路径无效"))
}

fn validate_source_file(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || !path.is_file() {
        return Err(TransportError::validation(
            "file_unreadable",
            "源文件不存在或不可读取",
        ));
    }
    Ok(path)
}

fn validate_destination(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(TransportError::validation(
            "invalid_destination",
            "目标文件路径无效",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| TransportError::validation("invalid_destination", "目标文件路径无效"))?;
    if !parent.is_dir() {
        return Err(TransportError::validation(
            "invalid_destination",
            "目标目录不存在",
        ));
    }
    Ok(path)
}

fn safe_file_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty()
        || name.len() > 240
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\0'])
    {
        return Err(TransportError::validation(
            "invalid_file_name",
            "文件名无效",
        ));
    }
    Ok(name.to_string())
}

fn validate_short_value(value: &str, label: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.contains(['\r', '\n', '\0']) {
        return Err(TransportError::validation(
            "invalid_value",
            format!("{label}无效"),
        ));
    }
    Ok(())
}

fn temporary_path(destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    destination.with_file_name(format!(".{name}.rightdata-{}.part", uuid::Uuid::new_v4()))
}

async fn commit_file(temporary: &Path, destination: &Path, overwrite: bool) -> Result<()> {
    if destination.exists() {
        if !overwrite {
            return Err(TransportError::validation(
                "destination_exists",
                "目标文件已存在",
            ));
        }
        tokio::fs::remove_file(destination)
            .await
            .map_err(|_| TransportError::storage("无法替换目标文件"))?;
    }
    tokio::fs::rename(temporary, destination)
        .await
        .map_err(|_| TransportError::storage("无法提交目标文件"))
}

fn request_timeout(value: Option<u64>) -> Duration {
    Duration::from_millis(
        value
            .unwrap_or(15 * 60 * 1_000)
            .clamp(1_000, 60 * 60 * 1_000),
    )
}

fn require_main_window(window: &WebviewWindow) -> Result<()> {
    if window.label() != "main" {
        return Err(TransportError::new(
            ErrorKind::Auth,
            "window_not_allowed",
            "当前窗口不能执行此操作",
        ));
    }
    Ok(())
}

fn require_trusted_window(window: &WebviewWindow) -> Result<()> {
    if window.label() != "main" && !window.label().starts_with("preview-") {
        return Err(TransportError::new(
            ErrorKind::Auth,
            "window_not_allowed",
            "当前窗口不能执行此操作",
        ));
    }
    Ok(())
}

fn clear_preview_windows(app: &AppHandle, previews: &PreviewStore) {
    previews.clear();
    for (label, preview) in app.webview_windows() {
        if label.starts_with("preview-") {
            let _ = preview.close();
        }
    }
}

fn notify_session_expired(app: &AppHandle, previews: &PreviewStore, screens: &ScreenManager) {
    clear_preview_windows(app, previews);
    screens.clear();
    let _ = app.emit_to(
        "main",
        "auth-session-expired",
        serde_json::json!({ "code": "unauthenticated" }),
    );
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::models::{ApiRequestInput, ConfigureInput, LoginInput, UploadInput};
    use serde_json::Value;
    use std::env;

    #[tokio::test]
    #[ignore = "requires the isolated RightData server and explicit test credentials"]
    async fn live_server_transport_contract() {
        let server_url = env::var("RIGHTDATA_TEST_SERVER")
            .unwrap_or_else(|_| "http://127.0.0.1:18003".to_string());
        let username = env::var("RIGHTDATA_TEST_USERNAME")
            .expect("RIGHTDATA_TEST_USERNAME must name an isolated test account");
        let password = env::var("RIGHTDATA_TEST_PASSWORD")
            .expect("RIGHTDATA_TEST_PASSWORD must contain the isolated test password");
        let runtime_base = env::var_os("RIGHTDATA_TEST_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../..")
                    .join("test/runtime/client-native")
            });
        std::fs::create_dir_all(&runtime_base).unwrap();
        let runtime = runtime_base.join(format!("transport-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(runtime.clone()).unwrap();

        let configured = state
            .configure(ConfigureInput {
                server_url,
                discovery_url: None,
                allow_public_relay: false,
                rebind_instance: false,
            })
            .await
            .unwrap();
        assert_eq!(configured.connection.mode, ConnectionMode::Direct);
        assert!(configured.connection.instance_id.is_some());

        let auth = state
            .login(LoginInput {
                username,
                password,
                remember: true,
            })
            .await
            .unwrap();
        assert!(auth.authenticated);
        let me = state
            .api_request(ApiRequestInput {
                method: "GET".into(),
                path: "/api/v1/auth/me".into(),
                query: BTreeMap::new(),
                headers: BTreeMap::new(),
                body: None,
                timeout_ms: None,
                idempotency_key: None,
            })
            .await
            .unwrap();
        assert_eq!(me.status, 200);

        let upload_request = UploadInput {
            method: Some("POST".into()),
            path: "/api/v1/files".into(),
            file_path: None,
            bytes: Some(b"rightdata native transport integration".to_vec()),
            file_name: Some("transport-smoke.txt".into()),
            field_name: Some("file".into()),
            fields: BTreeMap::from([
                ("name".into(), "transport-smoke.txt".into()),
                ("mediaType".into(), "text/plain".into()),
            ]),
            media_type: Some("text/plain".into()),
            timeout_ms: None,
            idempotency_key: None,
        };
        let (settings, token) = state.settings_and_token().await.unwrap();
        let upload_url =
            build_api_url(&settings.server_url, &upload_request.path, &BTreeMap::new()).unwrap();
        let upload = state
            .client()
            .await
            .unwrap()
            .post(upload_url)
            .bearer_auth(&token)
            .multipart(upload_form(&upload_request).await.unwrap())
            .send()
            .await
            .unwrap();
        let uploaded = parse_api_response(upload).await.unwrap();
        let file_id = uploaded
            .data
            .pointer("/data/id")
            .and_then(Value::as_str)
            .expect("upload envelope must include data.id")
            .to_string();

        let download_path = runtime.join("downloaded.txt");
        let download_url = build_api_url(
            &settings.server_url,
            &format!("/api/v1/files/{file_id}/download"),
            &BTreeMap::new(),
        )
        .unwrap();
        let download = state
            .client()
            .await
            .unwrap()
            .get(download_url)
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        let saved = download_response(download, download_path.clone(), false)
            .await
            .unwrap();
        assert!(saved.saved);
        assert_eq!(
            std::fs::read(download_path).unwrap(),
            b"rightdata native transport integration"
        );

        let deleted = state
            .api_request(ApiRequestInput {
                method: "DELETE".into(),
                path: format!("/api/v1/files/{file_id}"),
                query: BTreeMap::new(),
                headers: BTreeMap::new(),
                body: None,
                timeout_ms: None,
                idempotency_key: Some(uuid::Uuid::new_v4().to_string()),
            })
            .await
            .unwrap();
        assert_eq!(
            deleted.data.pointer("/data/deleted"),
            Some(&Value::Bool(true))
        );
        assert!(state.logout().await.unwrap().logged_out);
        std::fs::remove_dir_all(runtime).unwrap();
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn download_read_accepts_only_export_job_artifacts() {
        assert!(validate_export_download_path("/api/v1/jobs/job-1/download").is_ok());
        assert!(validate_export_download_path("/api/v1/files/file-1/download").is_err());
        assert!(validate_export_download_path("/api/v1/jobs/job-1/download/extra").is_err());
        assert!(validate_export_download_path("/api/v1/jobs/../download").is_err());
    }
}
