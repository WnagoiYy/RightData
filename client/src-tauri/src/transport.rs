use crate::client_events::ClientEventBinding;
use crate::error::{ErrorKind, Result, TransportError};
use crate::models::*;
use crate::network_service::{self, ServiceConfig, ServiceStatus};
use crate::storage::{Storage, StoredSession};
use futures_util::StreamExt;
use reqwest::{Method, Response, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, OnceCell};
use zeroize::Zeroize;

const EXPECTED_SERVICE: &str = "RightData";
const SUPPORTED_API_VERSION: &str = "1";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 15 * 60 * 1_000;
const MAX_API_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_AUTH_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRANSPORT_LOGS: usize = 500;

#[derive(Debug)]
struct RuntimeState {
    settings: ConnectionSettings,
    connection: ConnectionStatus,
    session: Option<StoredSession>,
}

pub struct AppState {
    client: reqwest::Client,
    storage: Storage,
    settings_explicit: AtomicBool,
    network_service_initialized: OnceCell<()>,
    inner: Mutex<RuntimeState>,
    probe_lock: Mutex<()>,
    refresh_lock: Mutex<()>,
    logs: Mutex<VecDeque<TransportLogEntry>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<T> {
    code: String,
    #[serde(default)]
    message: String,
    data: Option<T>,
    request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionData {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    user: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginPayload<'a> {
    username: &'a str,
    password: &'a str,
    remember: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshPayload<'a> {
    refresh_token: &'a str,
}

impl AppState {
    pub fn new(root: PathBuf) -> Result<Self> {
        let storage = Storage::new(root)?;
        let settings_were_explicit = storage.has_settings();
        let settings = storage.load_settings()?;
        let session = match storage.load_session() {
            Ok(Some(mut session)) => {
                session.remember = true;
                Some(session)
            }
            Ok(None) => None,
            Err(_) => {
                let _ = storage.delete_session();
                None
            }
        };
        let logs = storage
            .load_transport_logs()
            .unwrap_or_default()
            .into_iter()
            .rev()
            .take(MAX_TRANSPORT_LOGS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let client = client_builder()?
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(4))
            .user_agent("RightData-Desktop/0.1")
            .build()
            .map_err(|_| {
                TransportError::new(
                    ErrorKind::Storage,
                    "transport_init_failed",
                    "无法初始化网络层",
                )
            })?;
        Ok(Self {
            client,
            storage,
            settings_explicit: AtomicBool::new(settings_were_explicit),
            network_service_initialized: OnceCell::new(),
            inner: Mutex::new(RuntimeState {
                settings,
                connection: ConnectionStatus::default(),
                session,
            }),
            probe_lock: Mutex::new(()),
            refresh_lock: Mutex::new(()),
            logs: Mutex::new(logs),
        })
    }

    pub async fn initialize_network_service(&self) -> Result<()> {
        // Startup and foreground commands must observe one completed adoption
        // before they validate sessions or mutate connection settings.
        self.network_service_initialized
            .get_or_try_init(|| self.initialize_network_service_inner())
            .await
            .map(|_| ())
    }

    async fn initialize_network_service_inner(&self) -> Result<()> {
        let status = match network_service::status().await {
            Ok(status) => status,
            Err(error) if error.code == "network_service_unavailable" => {
                return if self.settings_explicit.load(Ordering::Relaxed) {
                    self.clear_mismatched_session().await
                } else {
                    Ok(())
                };
            }
            Err(error) => return Err(error),
        };
        if self.settings_explicit.load(Ordering::Relaxed) {
            let settings = self.inner.lock().await.settings.clone();
            let status = network_service::configure(&ServiceConfig {
                server_url: settings.server_url,
                discovery_url: settings.discovery_url,
                bound_instance_id: settings.bound_instance_id,
                allow_public_relay: settings.allow_public_relay,
                enabled: status.enabled,
            })
            .await?;
            self.apply_service_status(&status).await;
            return self.clear_mismatched_session().await;
        }

        self.adopt_service_status(status).await
    }

    async fn clear_mismatched_session(&self) -> Result<()> {
        let mut state = self.inner.lock().await;
        if state.session.as_ref().is_some_and(|session| {
            Some(&session.instance_id) != state.settings.bound_instance_id.as_ref()
        }) {
            clear_session_locked(&self.storage, &mut state)?;
        }
        Ok(())
    }

    pub async fn state_view(&self) -> TransportStateView {
        let state = self.inner.lock().await;
        state_to_view(&state)
    }

    pub async fn transport_logs(&self) -> Vec<TransportLogEntry> {
        self.logs.lock().await.iter().rev().cloned().collect()
    }

    pub async fn record_transport(
        &self,
        method: &str,
        path: &str,
        status: Option<u16>,
        request_id: Option<String>,
        succeeded: bool,
        duration: Duration,
    ) {
        let service = network_service::status().await.ok();
        let transport = {
            let mut state = self.inner.lock().await;
            if let Some(status) = &service {
                let settings = state.settings.clone();
                apply_service_status_cached(&settings, &mut state.connection, status);
            }
            match state.connection.mode {
                ConnectionMode::Direct => "direct",
                ConnectionMode::Peer => "peer",
                ConnectionMode::Disconnected => "direct",
            }
            .to_string()
        };
        let entry = TransportLogEntry {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| now_ms().to_string()),
            action: method.to_ascii_uppercase(),
            target: path.split('?').next().unwrap_or(path).to_string(),
            outcome: if succeeded { "success" } else { "failed" }.to_string(),
            duration_ms: duration.as_millis() as u64,
            request_id,
            mode: transport,
            status,
        };
        let mut logs = self.logs.lock().await;
        logs.push_back(entry);
        while logs.len() > MAX_TRANSPORT_LOGS {
            logs.pop_front();
        }
        let snapshot: Vec<_> = logs.iter().cloned().collect();
        let _ = self.storage.save_transport_logs(&snapshot);
    }

    pub async fn configure(&self, input: ConfigureInput) -> Result<TransportStateView> {
        self.initialize_network_service().await?;
        let server_url = validate_server_url(&input.server_url)?.to_string();
        let discovery_url = input
            .discovery_url
            .as_deref()
            .map(validate_discovery_url)
            .transpose()?
            .map(|url| url.to_string());
        let started = Instant::now();
        let probe = self.probe_at(&server_url).await?;
        validate_probe(&probe)?;

        let mut state = self.inner.lock().await;
        let previous_url = state.settings.server_url.clone();
        let previous_instance = state.settings.bound_instance_id.clone();
        if previous_url == server_url
            && previous_instance
                .as_deref()
                .is_some_and(|value| value != probe.instance_id)
            && !input.rebind_instance
        {
            state.connection = ConnectionStatus {
                last_error: Some("服务实例与已绑定实例不一致".into()),
                ..ConnectionStatus::default()
            };
            return Err(TransportError::new(
                ErrorKind::Validation,
                "instance_mismatch",
                "服务实例与已绑定实例不一致；确认更换实例后再重新绑定",
            ));
        }
        let changed_instance = previous_instance
            .as_deref()
            .is_some_and(|value| value != probe.instance_id);
        if changed_instance {
            clear_session_locked(&self.storage, &mut state)?;
        }
        state.settings = ConnectionSettings {
            server_url,
            discovery_url,
            allow_public_relay: input.allow_public_relay,
            bound_instance_id: Some(probe.instance_id.clone()),
        };
        self.storage.save_settings(&state.settings)?;
        self.settings_explicit.store(true, Ordering::Relaxed);
        state.connection = self.connection_status(&probe, started.elapsed()).await;
        Ok(state_to_view(&state))
    }

    pub async fn probe_current(&self) -> Result<ProbeResult> {
        self.initialize_network_service().await?;
        let _guard = self.probe_lock.lock().await;
        if !self.settings_explicit.load(Ordering::Relaxed) {
            if let Err(error) = self.adopt_service_settings().await
                && (!cfg!(debug_assertions) || error.code != "network_service_unavailable")
            {
                return Err(error);
            }
        }
        let settings = { self.inner.lock().await.settings.clone() };
        let started = Instant::now();
        let probe = match self.probe_at(&settings.server_url).await {
            Ok(probe) => probe,
            Err(error) => {
                self.mark_disconnected(&error).await;
                return Err(error);
            }
        };
        if let Err(error) = validate_probe(&probe) {
            self.mark_disconnected(&error).await;
            return Err(error);
        }
        if let Some(bound) = settings.bound_instance_id.as_deref() {
            if bound != probe.instance_id {
                let error = TransportError::new(
                    ErrorKind::Validation,
                    "instance_mismatch",
                    "当前地址返回了其他服务实例，已阻止发送业务凭据",
                );
                self.mark_disconnected(&error).await;
                return Err(error);
            }
        }
        let mut state = self.inner.lock().await;
        if state.settings.bound_instance_id.is_none() {
            state.settings.bound_instance_id = Some(probe.instance_id.clone());
            self.storage.save_settings(&state.settings)?;
        }
        state.connection = self.connection_status(&probe, started.elapsed()).await;
        let mode = state.connection.mode.clone();
        Ok(ProbeResult {
            probe,
            mode,
            latency_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn adopt_service_settings(&self) -> Result<()> {
        let status = network_service::status().await?;
        self.adopt_service_status(status).await
    }

    async fn adopt_service_status(&self, status: ServiceStatus) -> Result<()> {
        let status = if status
            .discovery_url
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        {
            network_service::configure(&ServiceConfig {
                server_url: status.server_url,
                discovery_url: Some(crate::build_defaults::DISCOVERY_URL.to_string()),
                bound_instance_id: status.bound_instance_id,
                allow_public_relay: status.allow_public_relay,
                enabled: status.enabled,
            })
            .await?
        } else {
            status
        };
        let settings = ConnectionSettings {
            server_url: validate_server_url(&status.server_url)?.to_string(),
            discovery_url: status
                .discovery_url
                .as_deref()
                .map(validate_discovery_url)
                .transpose()?
                .map(|url| url.to_string()),
            allow_public_relay: status.allow_public_relay,
            bound_instance_id: status.bound_instance_id.clone(),
        };
        let mut state = self.inner.lock().await;
        apply_service_status_cached(&settings, &mut state.connection, &status);
        state.settings = settings;
        drop(state);
        self.clear_mismatched_session().await
    }

    pub async fn apply_service_status(&self, status: &ServiceStatus) {
        let mut state = self.inner.lock().await;
        let settings = state.settings.clone();
        apply_service_status_cached(&settings, &mut state.connection, status);
    }

    async fn probe_at(&self, server_url: &str) -> Result<ProbeData> {
        let url = build_api_url(server_url, "/api/probe", &BTreeMap::new())?;
        let (client, proxied) = self.http_client_with_mode().await?;
        let response = client
            .get(url)
            .timeout(if proxied {
                Duration::from_secs(20)
            } else {
                Duration::from_secs(4)
            })
            .send()
            .await
            .map_err(TransportError::from_reqwest)?;
        parse_typed_response(response).await
    }

    async fn ensure_direct(&self) -> Result<()> {
        let direct = {
            let state = self.inner.lock().await;
            state.connection.mode != ConnectionMode::Disconnected
                && state.connection.ready
                && state.connection.instance_id == state.settings.bound_instance_id
        };
        if !direct {
            self.probe_current().await?;
        }
        Ok(())
    }

    pub async fn login(&self, mut input: LoginInput) -> Result<AuthResult> {
        self.ensure_direct().await?;
        let settings = { self.inner.lock().await.settings.clone() };
        let url = build_api_url(&settings.server_url, "/api/v1/auth/login", &BTreeMap::new())?;
        let payload = LoginPayload {
            username: &input.username,
            password: &input.password,
            remember: input.remember,
        };
        let response = self
            .http_client()
            .await?
            .post(url)
            .timeout(Duration::from_secs(20))
            .json(&payload)
            .send()
            .await
            .map_err(TransportError::from_reqwest);
        input.password.zeroize();
        let data: SessionData = parse_typed_response(response?).await?;
        let instance_id = settings.bound_instance_id.ok_or_else(|| {
            TransportError::new(
                ErrorKind::Validation,
                "instance_unbound",
                "尚未绑定服务实例",
            )
        })?;
        let session = StoredSession {
            instance_id,
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            access_expires_at_ms: now_ms().saturating_add(data.expires_in * 1_000),
            user: data.user.clone(),
            remember: input.remember,
        };
        let mut state = self.inner.lock().await;
        if let Some(mut previous) = state.session.take() {
            previous.clear_secrets();
        }
        if input.remember {
            self.storage.save_session(&session)?;
        } else {
            self.storage.delete_session()?;
        }
        state.session = Some(session);
        Ok(AuthResult {
            authenticated: true,
            user: Some(data.user),
            expires_in: Some(data.expires_in),
            remember: input.remember,
        })
    }

    pub async fn restore(&self) -> Result<AuthResult> {
        self.initialize_network_service().await?;
        self.clear_mismatched_session().await?;
        self.ensure_direct().await?;
        let has_session = self.inner.lock().await.session.is_some();
        if !has_session {
            return Ok(AuthResult {
                authenticated: false,
                user: None,
                expires_in: None,
                remember: false,
            });
        }
        match self.refresh_access_force(true).await {
            Ok(_) => {
                let state = self.inner.lock().await;
                let session = state.session.as_ref();
                Ok(AuthResult {
                    authenticated: session.is_some(),
                    user: session.map(|value| value.user.clone()),
                    expires_in: session.map(expires_in),
                    remember: session.is_some_and(|value| value.remember),
                })
            }
            Err(error) if error.status == Some(401) => {
                self.clear_session().await?;
                Ok(AuthResult {
                    authenticated: false,
                    user: None,
                    expires_in: None,
                    remember: false,
                })
            }
            Err(error) => Err(error),
        }
    }

    pub async fn logout(&self) -> Result<LogoutResult> {
        let (settings, token) = {
            let state = self.inner.lock().await;
            (
                state.settings.clone(),
                state
                    .session
                    .as_ref()
                    .map(|value| value.access_token.clone()),
            )
        };
        let mut remote_revoked = false;
        if let Some(mut token) = token {
            if let Ok(url) = build_api_url(
                &settings.server_url,
                "/api/v1/auth/logout",
                &BTreeMap::new(),
            ) {
                remote_revoked = self
                    .http_client()
                    .await?
                    .post(url)
                    .bearer_auth(&token)
                    .timeout(Duration::from_secs(10))
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success());
            }
            token.zeroize();
        }
        self.clear_session().await?;
        Ok(LogoutResult {
            logged_out: true,
            remote_revoked,
        })
    }

    pub async fn api_request(&self, input: ApiRequestInput) -> Result<ApiResponse> {
        self.ensure_direct().await?;
        let method = Method::from_bytes(input.method.trim().to_uppercase().as_bytes())
            .map_err(|_| TransportError::validation("invalid_method", "请求方法无效"))?;
        let safe_to_replay = matches!(method, Method::GET | Method::HEAD | Method::OPTIONS)
            || input.idempotency_key.is_some();
        let token = self.fresh_access().await?;
        let response = self.send_api_request(&input, &method, &token).await;
        let response = match response {
            Ok(response) if response.status() == StatusCode::UNAUTHORIZED => {
                let _ = response.bytes().await;
                let refreshed = self.refresh_access_force(true).await?;
                if !safe_to_replay {
                    return Err(TransportError::server(
                        409,
                        "request_not_replayed",
                        "登录已续期，请重新提交当前写操作",
                        None,
                    ));
                }
                self.send_api_request(&input, &method, &refreshed).await?
            }
            Ok(response) => response,
            Err(error) => {
                self.mark_disconnected(&error).await;
                return Err(error);
            }
        };
        if response.status() == StatusCode::UNAUTHORIZED {
            let error = parse_api_response(response)
                .await
                .expect_err("401 response must be an error");
            self.clear_session().await?;
            return Err(error);
        }
        let result = parse_api_response(response).await?;
        if method == Method::GET
            && input.path.split('?').next() == Some("/api/v1/auth/me")
            && let Some(user) = result.data.get("data").cloned()
        {
            self.update_session_user(user).await?;
        }
        Ok(result)
    }

    async fn send_api_request(
        &self,
        input: &ApiRequestInput,
        method: &Method,
        token: &str,
    ) -> Result<Response> {
        let settings = { self.inner.lock().await.settings.clone() };
        let url = build_api_url(&settings.server_url, &input.path, &input.query)?;
        validate_command_api_path(url.path())?;
        let client = self.http_client().await?;
        let mut request = client.request(method.clone(), url).bearer_auth(token);
        request = apply_headers(request, &input.headers)?;
        if let Some(key) = input.idempotency_key.as_deref() {
            validate_header_value(key)?;
            request = request.header("Idempotency-Key", key);
        }
        if let Some(body) = input.body.as_ref() {
            request = request.json(body);
        }
        request
            .timeout(timeout(input.timeout_ms))
            .send()
            .await
            .map_err(TransportError::from_reqwest)
    }

    pub async fn fresh_access(&self) -> Result<String> {
        let (token, expires_at) = {
            let state = self.inner.lock().await;
            let session = state.session.as_ref().ok_or_else(unauthenticated)?;
            (session.access_token.clone(), session.access_expires_at_ms)
        };
        if expires_at > now_ms().saturating_add(30_000) {
            return Ok(token);
        }
        self.refresh_access().await
    }

    pub async fn refresh_access(&self) -> Result<String> {
        self.refresh_access_force(false).await
    }

    pub async fn refresh_after_unauthorized(&self) -> Result<String> {
        self.refresh_access_force(true).await
    }

    async fn refresh_access_force(&self, force: bool) -> Result<String> {
        let _guard = self.refresh_lock.lock().await;
        let (settings, mut refresh_token, remember, instance_id) = {
            let state = self.inner.lock().await;
            let session = state.session.as_ref().ok_or_else(unauthenticated)?;
            if !force && session.access_expires_at_ms > now_ms().saturating_add(30_000) {
                return Ok(session.access_token.clone());
            }
            (
                state.settings.clone(),
                session.refresh_token.clone(),
                session.remember,
                session.instance_id.clone(),
            )
        };
        let url = build_api_url(
            &settings.server_url,
            "/api/v1/auth/refresh",
            &BTreeMap::new(),
        )?;
        let response = self
            .http_client()
            .await?
            .post(url)
            .timeout(Duration::from_secs(20))
            .json(&RefreshPayload {
                refresh_token: &refresh_token,
            })
            .send()
            .await
            .map_err(TransportError::from_reqwest);
        refresh_token.zeroize();
        let data: SessionData = match response {
            Ok(response) => match parse_typed_response(response).await {
                Ok(data) => data,
                Err(error) if error.status == Some(401) => {
                    self.clear_session().await?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            },
            Err(error) => return Err(error),
        };
        let session = StoredSession {
            instance_id,
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            access_expires_at_ms: now_ms().saturating_add(data.expires_in * 1_000),
            user: data.user,
            remember,
        };
        let access = session.access_token.clone();
        let mut state = self.inner.lock().await;
        if remember {
            self.storage.save_session(&session)?;
        }
        if let Some(mut old) = state.session.replace(session) {
            old.clear_secrets();
        }
        Ok(access)
    }

    pub async fn clear_session(&self) -> Result<()> {
        let mut state = self.inner.lock().await;
        clear_session_locked(&self.storage, &mut state)
    }

    async fn update_session_user(&self, user: Value) -> Result<()> {
        let mut state = self.inner.lock().await;
        let Some(session) = state.session.as_mut() else {
            return Ok(());
        };
        session.user = user;
        if session.remember {
            self.storage.save_session(session)?;
        }
        Ok(())
    }

    pub async fn settings_and_token(&self) -> Result<(ConnectionSettings, String)> {
        self.ensure_direct().await?;
        let token = self.fresh_access().await?;
        let settings = self.inner.lock().await.settings.clone();
        Ok((settings, token))
    }

    pub async fn client_event_context(&self) -> Result<(ClientEventBinding, String)> {
        let state = self.inner.lock().await;
        let session = state.session.as_ref().ok_or_else(unauthenticated)?;
        let user_id = session
            .user
            .get("id")
            .and_then(|value| match value {
                Value::String(value) => Some(value.clone()),
                Value::Number(value) => Some(value.to_string()),
                _ => None,
            })
            .ok_or_else(|| TransportError::storage("当前登录用户标识无效"))?;
        let binding = ClientEventBinding::new(session.instance_id.clone(), user_id)?;
        Ok((binding, session.instance_id.clone()))
    }

    pub async fn update_context(
        &self,
    ) -> Result<(reqwest::Client, ConnectionSettings, Option<String>)> {
        let has_session = self.inner.lock().await.session.is_some();
        let token = if has_session {
            Some(self.fresh_access().await?)
        } else {
            None
        };
        let settings = self.inner.lock().await.settings.clone();
        Ok((self.http_client().await?, settings, token))
    }

    pub async fn client(&self) -> Result<reqwest::Client> {
        self.http_client().await
    }

    async fn http_client(&self) -> Result<reqwest::Client> {
        self.http_client_with_mode().await.map(|(client, _)| client)
    }

    async fn http_client_with_mode(&self) -> Result<(reqwest::Client, bool)> {
        match network_service::status().await {
            Ok(status) if status.enabled => {
                build_proxy_client(&status).map(|client| (client, true))
            }
            Ok(_) => Err(TransportError::new(
                ErrorKind::Network,
                "network_service_paused",
                "本机网络服务已暂停",
            )),
            Err(error) if cfg!(debug_assertions) && error.code == "network_service_unavailable" => {
                Ok((self.client.clone(), false))
            }
            Err(error) => Err(error),
        }
    }

    async fn connection_status(&self, probe: &ProbeData, elapsed: Duration) -> ConnectionStatus {
        match network_service::status().await {
            Ok(status) if status.enabled => service_status(&status, probe, elapsed),
            _ => direct_status(probe, elapsed),
        }
    }

    pub async fn mark_disconnected(&self, error: &TransportError) {
        let mut state = self.inner.lock().await;
        state.connection = ConnectionStatus {
            last_error: Some(error.message.clone()),
            ..ConnectionStatus::default()
        };
    }
}

fn session_view(session: Option<&StoredSession>) -> SessionView {
    SessionView {
        authenticated: session.is_some(),
        user: session.map(|value| value.user.clone()),
        remember: session.is_some_and(|value| value.remember),
        expires_in: session.map(expires_in),
    }
}

fn expires_in(session: &StoredSession) -> u64 {
    session.access_expires_at_ms.saturating_sub(now_ms()) / 1_000
}

fn state_to_view(state: &RuntimeState) -> TransportStateView {
    TransportStateView {
        settings: state.settings.clone(),
        connection: state.connection.clone(),
        session: session_view(state.session.as_ref()),
    }
}

fn clear_session_locked(storage: &Storage, state: &mut RuntimeState) -> Result<()> {
    if let Some(mut session) = state.session.take() {
        session.clear_secrets();
    }
    storage.delete_session()
}

fn direct_status(probe: &ProbeData, elapsed: Duration) -> ConnectionStatus {
    ConnectionStatus {
        mode: ConnectionMode::Direct,
        instance_id: Some(probe.instance_id.clone()),
        api_version: Some(probe.api_version.clone()),
        ready: probe.ready,
        peer_available: false,
        latency_ms: Some(elapsed.as_millis() as u64),
        last_error: None,
    }
}

fn service_status(
    status: &ServiceStatus,
    probe: &ProbeData,
    elapsed: Duration,
) -> ConnectionStatus {
    let mode = match status.mode.as_str() {
        "peer" => ConnectionMode::Peer,
        "direct" => ConnectionMode::Direct,
        _ => ConnectionMode::Disconnected,
    };
    ConnectionStatus {
        mode,
        instance_id: Some(probe.instance_id.clone()),
        api_version: Some(probe.api_version.clone()),
        ready: probe.ready,
        peer_available: status.peer_id.is_some(),
        latency_ms: Some(elapsed.as_millis() as u64),
        last_error: status.last_error.clone(),
    }
}

fn apply_service_status_cached(
    settings: &ConnectionSettings,
    connection: &mut ConnectionStatus,
    status: &ServiceStatus,
) {
    // A service status may downgrade the cache immediately. It may only
    // restore readiness when a prior Tauri probe verified this exact binding.
    let validated_instance = settings.bound_instance_id.as_deref().is_some_and(|bound| {
        connection.instance_id.as_deref() == Some(bound)
            && connection.api_version.as_deref() == Some(SUPPORTED_API_VERSION)
            && status.bound_instance_id.as_deref() == Some(bound)
            && status.server_url.trim_end_matches('/') == settings.server_url.trim_end_matches('/')
    });
    let mode = match status.mode.as_str() {
        "direct" => ConnectionMode::Direct,
        "peer" => ConnectionMode::Peer,
        _ => ConnectionMode::Disconnected,
    };
    let ready = status.running
        && status.enabled
        && status.ready
        && validated_instance
        && mode != ConnectionMode::Disconnected;

    connection.mode = if ready {
        mode
    } else {
        ConnectionMode::Disconnected
    };
    connection.ready = ready;
    connection.peer_available = ready && status.peer_id.is_some();
    connection.last_error = status.last_error.clone();
}

fn build_proxy_client(status: &ServiceStatus) -> Result<reqwest::Client> {
    let proxy_url = status.proxy_url.as_deref().ok_or_else(|| {
        TransportError::new(
            ErrorKind::Network,
            "network_proxy_unavailable",
            "本机网络代理尚未就绪",
        )
    })?;
    let proxy_token = status.proxy_token.as_deref().ok_or_else(|| {
        TransportError::new(
            ErrorKind::Network,
            "network_proxy_unavailable",
            "本机网络代理凭据缺失",
        )
    })?;
    let proxy_url =
        Url::parse(proxy_url).map_err(|_| TransportError::storage("本机网络代理地址无效"))?;
    let backend = Url::parse(&status.server_url)
        .map_err(|_| TransportError::storage("本机网络服务地址无效"))?;
    let proxy = reqwest::Proxy::custom(move |url| {
        (url.origin() == backend.origin()).then(|| proxy_url.clone())
    })
    .basic_auth("rightdata", proxy_token);
    client_builder()?
        .no_proxy()
        .proxy(proxy)
        .http1_only()
        .pool_max_idle_per_host(0)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .user_agent("RightData-Desktop/0.1")
        .build()
        .map_err(|_| TransportError::storage("无法初始化本机网络代理"))
}

fn client_builder() -> Result<reqwest::ClientBuilder> {
    let mut builder = reqwest::Client::builder();
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os("RIGHTDATA_TEST_CA_PEM") {
        let path = std::path::PathBuf::from(value);
        if !path.is_absolute() {
            return Err(TransportError::validation(
                "invalid_test_ca",
                "RIGHTDATA_TEST_CA_PEM 必须是绝对路径",
            ));
        }
        let pem =
            std::fs::read(path).map_err(|_| TransportError::storage("无法读取测试 CA 证书"))?;
        let certificate = reqwest::Certificate::from_pem(&pem)
            .map_err(|_| TransportError::validation("invalid_test_ca", "测试 CA 证书无效"))?;
        builder = builder.add_root_certificate(certificate);
    }
    Ok(builder)
}

fn validate_probe(probe: &ProbeData) -> Result<()> {
    if probe.service != EXPECTED_SERVICE {
        return Err(TransportError::validation(
            "unexpected_service",
            "目标地址不是 RightData 服务",
        ));
    }
    if probe.api_version != SUPPORTED_API_VERSION {
        return Err(TransportError::validation(
            "incompatible_api",
            "服务端接口版本不兼容",
        ));
    }
    if !probe.ready {
        return Err(TransportError::new(
            ErrorKind::Server,
            "service_not_ready",
            "服务端尚未就绪",
        ));
    }
    if probe.instance_id.trim().is_empty() || probe.instance_id.len() > 128 {
        return Err(TransportError::validation(
            "invalid_instance",
            "服务端实例标识无效",
        ));
    }
    Ok(())
}

pub fn validate_server_url(value: &str) -> Result<Url> {
    let mut url = Url::parse(value.trim())
        .map_err(|_| TransportError::validation("invalid_server_url", "服务端地址格式无效"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(TransportError::validation(
            "invalid_server_url",
            "服务端地址仅支持 HTTP 或 HTTPS",
        ));
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.path() != "/" && !url.path().is_empty())
    {
        return Err(TransportError::validation(
            "invalid_server_url",
            "服务端地址只能包含协议、主机和端口",
        ));
    }
    url.set_path("");
    Ok(url)
}

fn validate_discovery_url(value: &str) -> Result<Url> {
    let url = validate_server_url(value)
        .map_err(|_| TransportError::validation("invalid_discovery_url", "发现服务地址格式无效"))?;
    Ok(url)
}

pub fn build_api_url(
    server_url: &str,
    path: &str,
    query: &BTreeMap<String, String>,
) -> Result<Url> {
    if path.contains('#') {
        return Err(TransportError::validation(
            "invalid_api_path",
            "接口路径不能包含片段",
        ));
    }
    let base = validate_server_url(server_url)?;
    let url = base
        .join(path)
        .map_err(|_| TransportError::validation("invalid_api_path", "接口路径无效"))?;
    if url.origin() != base.origin() || (url.path() != "/api" && !url.path().starts_with("/api/")) {
        return Err(TransportError::validation(
            "invalid_api_path",
            "仅允许访问当前服务的 /api 路径",
        ));
    }
    let mut url = url;
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    Ok(url)
}

pub fn validate_command_api_path(path: &str) -> Result<()> {
    match path {
        "/api/v1/auth/login"
        | "/api/v1/auth/refresh"
        | "/api/v1/auth/document-ticket"
        | "/api/docs/session" => Err(TransportError::validation(
            "protected_auth_endpoint",
            "该认证操作只能通过专用桌面命令执行",
        )),
        _ => Ok(()),
    }
}

fn apply_headers(
    mut request: reqwest::RequestBuilder,
    headers: &BTreeMap<String, String>,
) -> Result<reqwest::RequestBuilder> {
    for (name, value) in headers {
        let normalized = name.trim().to_ascii_lowercase();
        if !matches!(
            normalized.as_str(),
            "accept"
                | "content-type"
                | "x-rightdata-source"
                | "if-none-match"
                | "if-match"
                | "range"
        ) {
            return Err(TransportError::validation(
                "header_not_allowed",
                "请求头不在允许列表中",
            ));
        }
        validate_header_value(value)?;
        request = request.header(name, value);
    }
    Ok(request)
}

fn validate_header_value(value: &str) -> Result<()> {
    if value.contains('\r') || value.contains('\n') || value.len() > 8_192 {
        return Err(TransportError::validation(
            "invalid_header",
            "请求头内容无效",
        ));
    }
    Ok(())
}

fn timeout(value: Option<u64>) -> Duration {
    Duration::from_millis(
        value
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1_000, MAX_TIMEOUT_MS),
    )
}

pub async fn parse_api_response(response: Response) -> Result<ApiResponse> {
    let status = response.status().as_u16();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    let mut headers = BTreeMap::new();
    for name in [
        "content-type",
        "content-length",
        "etag",
        "content-disposition",
        "x-request-id",
    ] {
        if let Some(value) = response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
        {
            headers.insert(name.to_string(), value.to_string());
        }
    }
    let bytes =
        read_response_limited(response, MAX_API_RESPONSE_BYTES, status, request_id.clone()).await?;
    let data = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    if !(200..300).contains(&status) {
        return Err(error_from_value(status, &data, request_id));
    }
    Ok(ApiResponse {
        status,
        headers,
        data,
        request_id,
    })
}

async fn parse_typed_response<T: DeserializeOwned>(response: Response) -> Result<T> {
    let status = response.status().as_u16();
    let header_request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    let bytes = read_response_limited(
        response,
        MAX_AUTH_RESPONSE_BYTES,
        status,
        header_request_id.clone(),
    )
    .await?;
    let envelope: Envelope<T> = serde_json::from_slice(&bytes).map_err(|_| {
        TransportError::server(
            status,
            "invalid_response",
            "服务端返回内容无法解析",
            header_request_id.clone(),
        )
    })?;
    if !(200..300).contains(&status) || envelope.code != "ok" {
        return Err(TransportError::server(
            status,
            envelope.code,
            if envelope.message.is_empty() {
                "请求失败".into()
            } else {
                envelope.message
            },
            envelope.request_id.or(header_request_id),
        ));
    }
    envelope.data.ok_or_else(|| {
        TransportError::server(
            status,
            "invalid_response",
            "服务端响应缺少数据",
            envelope.request_id.or(header_request_id),
        )
    })
}

async fn read_response_limited(
    response: Response,
    limit: usize,
    status: u16,
    request_id: Option<String>,
) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(TransportError::server(
            status,
            "response_too_large",
            "服务端响应超过客户端限制",
            request_id,
        ));
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or_default()
            .min(limit as u64) as usize,
    );
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(TransportError::from_reqwest)?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(TransportError::server(
                status,
                "response_too_large",
                "服务端响应超过客户端限制",
                request_id,
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn error_from_value(
    status: u16,
    value: &Value,
    header_request_id: Option<String>,
) -> TransportError {
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("request_failed");
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("请求失败");
    let request_id = value
        .get("requestId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or(header_request_id);
    TransportError::server(status, code, message, request_id)
}

fn unauthenticated() -> TransportError {
    TransportError::server(401, "unauthenticated", "请先登录", None)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn service_status_fixture(enabled: bool, ready: bool) -> ServiceStatus {
        ServiceStatus {
            running: true,
            enabled,
            auto_start: false,
            device_id: "test-device".into(),
            server_url: "http://127.0.0.1:8003".into(),
            discovery_url: None,
            bound_instance_id: Some("test-instance".into()),
            allow_public_relay: false,
            proxy_url: None,
            proxy_token: None,
            mode: if ready { "direct" } else { "disconnected" }.into(),
            ready,
            peer_id: None,
            last_error: None,
        }
    }

    async fn read_request_headers(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0u8; 1024];
        while !request.windows(4).any(|value| value == b"\r\n\r\n") {
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0, "proxy client closed before sending headers");
            request.extend_from_slice(&buffer[..count]);
            assert!(
                request.len() <= 8 * 1024,
                "proxy request headers are too large"
            );
        }
        request
    }

    #[test]
    fn server_url_rejects_credentials_and_paths() {
        assert!(validate_server_url("http://127.0.0.1:8003").is_ok());
        assert!(validate_server_url("https://user:pass@example.test").is_err());
        assert!(validate_server_url("https://example.test/api").is_err());
    }

    #[test]
    fn api_url_stays_on_bound_origin_and_api_prefix() {
        let empty = BTreeMap::new();
        assert!(build_api_url("http://127.0.0.1:8003", "/api/v1/health?x=1", &empty).is_ok());
        assert!(
            build_api_url("http://127.0.0.1:8003", "https://example.test/api", &empty).is_err()
        );
        assert!(build_api_url("http://127.0.0.1:8003", "/api/../private", &empty).is_err());
    }

    #[test]
    fn paused_service_downgrades_cached_connection_without_forgetting_verified_instance() {
        let settings = ConnectionSettings {
            server_url: "http://127.0.0.1:8003".into(),
            discovery_url: None,
            allow_public_relay: false,
            bound_instance_id: Some("test-instance".into()),
        };
        let mut connection = direct_status(
            &ProbeData {
                service: EXPECTED_SERVICE.into(),
                instance_id: "test-instance".into(),
                api_version: SUPPORTED_API_VERSION.into(),
                ready: true,
            },
            Duration::from_millis(12),
        );

        apply_service_status_cached(
            &settings,
            &mut connection,
            &service_status_fixture(false, false),
        );

        assert_eq!(connection.mode, ConnectionMode::Disconnected);
        assert!(!connection.ready);
        assert!(!connection.peer_available);
        assert_eq!(connection.instance_id.as_deref(), Some("test-instance"));
        assert_eq!(
            connection.api_version.as_deref(),
            Some(SUPPORTED_API_VERSION)
        );
    }

    #[test]
    fn service_ready_does_not_promote_connection_before_probe_validation() {
        let settings = ConnectionSettings {
            server_url: "http://127.0.0.1:8003".into(),
            discovery_url: None,
            allow_public_relay: false,
            bound_instance_id: Some("test-instance".into()),
        };
        let mut connection = ConnectionStatus::default();

        apply_service_status_cached(
            &settings,
            &mut connection,
            &service_status_fixture(true, true),
        );

        assert_eq!(connection.mode, ConnectionMode::Disconnected);
        assert!(!connection.ready);
    }

    #[tokio::test]
    async fn proxy_client_opens_a_new_connection_for_each_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let first_headers = read_request_headers(&mut first).await;
            assert!(first_headers.starts_with(b"GET http://backend.test:8080/api/v1/health "));
            first
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok",
                )
                .await
                .unwrap();

            let (mut second, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
                .await
                .expect("the second request reused the first proxy connection")
                .unwrap();
            let second_headers = read_request_headers(&mut second).await;
            assert!(second_headers.starts_with(b"GET http://backend.test:8080/api/v1/health "));
            second
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
            drop(first);
        });

        let status = ServiceStatus {
            running: true,
            enabled: true,
            auto_start: false,
            device_id: "test-device".into(),
            server_url: "http://backend.test:8080".into(),
            discovery_url: None,
            bound_instance_id: Some("test-instance".into()),
            allow_public_relay: false,
            proxy_url: Some(format!("http://{proxy_address}")),
            proxy_token: Some("test-token".into()),
            mode: "peer".into(),
            ready: true,
            peer_id: Some("test-peer".into()),
            last_error: None,
        };
        let client = build_proxy_client(&status).unwrap();
        for _ in 0..2 {
            let response = client
                .get("http://backend.test:8080/api/v1/health")
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.text().await.unwrap(), "ok");
        }
        server.await.unwrap();
    }
}
