use crate::{
    control::{read_frame, write_frame},
    discovery,
};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use iroh::{Endpoint, SecretKey, endpoint::presets};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Weak,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::{Mutex, RwLock, Semaphore, watch},
};
use url::Url;

pub const ALPN: &[u8] = b"rightdata/relay/1";
const LOG_LIMIT: usize = 2000;
const LOCAL_TUNNEL_LIMIT: usize = 64;
const PEER_CONNECTION_LIMIT: usize = 24;
const PEER_CONNECTIONS_PER_DEVICE: usize = 2;
const PEER_TUNNEL_LIMIT: usize = 48;
const PEER_TUNNELS_PER_DEVICE: usize = 8;
const PEER_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const PEER_ATTEMPT_LIMIT: usize = 3;
const PEER_UNKNOWN_LATENCY_MS: f64 = 250.0;
const PEER_INFLIGHT_PENALTY_MS: f64 = 250.0;
const PEER_BACKOFF_BASE_MS: u64 = 250;
const PEER_BACKOFF_MAX_MS: u64 = 8_000;
const PEER_EWMA_NEW_SAMPLE_WEIGHT: f64 = 0.25;
const STARTUP_PREFERENCE_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartupPreferenceDocument {
    version: u8,
    auto_start: bool,
}

fn startup_preference_bytes(auto_start: bool) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec_pretty(&StartupPreferenceDocument {
        version: STARTUP_PREFERENCE_VERSION,
        auto_start,
    })?)
}

fn parse_startup_preference(bytes: &[u8]) -> Result<bool> {
    let document: StartupPreferenceDocument =
        serde_json::from_slice(bytes).context("本机开机启动偏好损坏")?;
    ensure!(
        document.version == STARTUP_PREFERENCE_VERSION,
        "本机开机启动偏好版本不兼容"
    );
    Ok(document.auto_start)
}

fn should_default_enable_autostart(preference: Option<bool>, actual: bool) -> bool {
    preference.is_none() && !actual
}

async fn read_startup_preference(root: &Path) -> Result<Option<bool>> {
    match tokio::fs::read(root.join("startup.json")).await {
        Ok(bytes) => parse_startup_preference(&bytes).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("无法读取本机开机启动偏好"),
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub server_url: String,
    pub discovery_url: Option<String>,
    pub bound_instance_id: Option<String>,
    pub allow_public_relay: bool,
    pub enabled: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: "http://127.0.0.1:8003".into(),
            discovery_url: None,
            bound_instance_id: None,
            allow_public_relay: false,
            enabled: true,
        }
    }
}
impl Config {
    pub fn validate(&mut self) -> Result<()> {
        let url = validate_url(&self.server_url, false)?;
        self.server_url = url.as_str().trim_end_matches('/').into();
        if let Some(discovery) = self
            .discovery_url
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            self.discovery_url = Some(
                validate_url(discovery, true)?
                    .as_str()
                    .trim_end_matches('/')
                    .into(),
            );
        } else {
            self.discovery_url = None;
        }
        if let Some(id) = &self.bound_instance_id {
            validate_instance_id(id)?;
        }
        Ok(())
    }
}

pub fn validate_instance_id(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 100
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "服务实例标识无效"
    );
    Ok(())
}

pub fn validate_url(raw: &str, discovery: bool) -> Result<Url> {
    let url = Url::parse(raw.trim()).context("服务地址无效")?;
    ensure!(
        matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
        "仅支持 HTTP 或 HTTPS 服务地址"
    );
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "地址不能包含凭据、查询参数或片段"
    );
    ensure!(
        url.path() == "/" || url.path().is_empty(),
        "服务地址不能包含业务路径"
    );
    if discovery && url.scheme() != "https" {
        ensure!(
            url.host_str().is_some_and(|host| host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())),
            "公网发现服务必须使用 HTTPS"
        );
    }
    Ok(url)
}

#[derive(Clone, Default)]
struct Health {
    ready: bool,
    reachable: bool,
    mode: String,
    peer_id: Option<String>,
    error: Option<String>,
    checked: Option<Instant>,
    direct_successes: u8,
}

fn record_direct_probe_success(health: &mut Health) {
    health.checked = Some(Instant::now());
    health.reachable = true;
    health.error = None;
    if health.ready && health.mode == "peer" && health.direct_successes == 0 {
        health.direct_successes = 1;
        return;
    }
    health.ready = true;
    health.mode = "direct".into();
    health.peer_id = None;
    health.direct_successes = 0;
}

fn record_direct_probe_failure(health: &mut Health, reachable: bool, error: String) {
    health.checked = Some(Instant::now());
    health.reachable = reachable;
    health.direct_successes = 0;
    if health.ready && health.mode == "peer" {
        health.error = None;
        return;
    }
    health.ready = false;
    health.mode = "disconnected".into();
    health.peer_id = None;
    health.error = Some(error);
}

pub trait TunnelIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> TunnelIo for T {}
pub type Tunnel = Box<dyn TunnelIo>;

async fn limiter_for(
    limits: &Mutex<HashMap<String, Weak<Semaphore>>>,
    peer_id: &str,
    permits: usize,
) -> Arc<Semaphore> {
    let mut limits = limits.lock().await;
    limits.retain(|_, limiter| limiter.strong_count() > 0);
    if let Some(limiter) = limits.get(peer_id).and_then(Weak::upgrade) {
        return limiter;
    }
    let limiter = Arc::new(Semaphore::new(permits));
    limits.insert(peer_id.to_owned(), Arc::downgrade(&limiter));
    limiter
}

async fn copy_with_activity(
    reader: &mut (impl AsyncRead + Unpin),
    writer: &mut (impl AsyncWrite + Unpin),
    activity: watch::Sender<u64>,
) -> std::io::Result<u64> {
    let mut total = 0u64;
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            writer.shutdown().await?;
            return Ok(total);
        }
        writer.write_all(&buffer[..count]).await?;
        total = total.saturating_add(count as u64);
        activity.send_modify(|value| *value = value.wrapping_add(1));
    }
}

async fn relay_with_idle_timeout(
    upstream_reader: &mut (impl AsyncRead + Unpin),
    upstream_writer: &mut (impl AsyncWrite + Unpin),
    downstream_reader: &mut (impl AsyncRead + Unpin),
    downstream_writer: &mut (impl AsyncWrite + Unpin),
    idle_timeout: Duration,
) -> Result<(u64, u64)> {
    let (activity, mut observed) = watch::channel(0u64);
    let upstream = copy_with_activity(upstream_reader, upstream_writer, activity.clone());
    let downstream = copy_with_activity(downstream_reader, downstream_writer, activity);
    tokio::pin!(upstream, downstream);
    let timer = tokio::time::sleep(idle_timeout);
    tokio::pin!(timer);
    let mut up_result = None;
    let mut down_result = None;
    loop {
        tokio::select! {
            result = &mut upstream, if up_result.is_none() => up_result = Some(result),
            result = &mut downstream, if down_result.is_none() => down_result = Some(result),
            changed = observed.changed(), if up_result.is_none() || down_result.is_none() => {
                if changed.is_ok() { timer.as_mut().reset(tokio::time::Instant::now() + idle_timeout); }
            },
            _ = &mut timer => bail!("节点隧道空闲超时"),
        }
        if let (Some(up), Some(down)) = (up_result.take(), down_result.take()) {
            return Ok((up?, down?));
        }
    }
}

struct ActiveStream(Arc<AtomicUsize>);
impl ActiveStream {
    fn new(count: Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::Relaxed);
        Self(count)
    }
}
impl Drop for ActiveStream {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Debug)]
struct PeerStats {
    latency_ewma_ms: Option<f64>,
    consecutive_failures: u32,
    backoff_until: Option<Instant>,
    inflight: Arc<AtomicUsize>,
}

impl PeerStats {
    fn new() -> Self {
        Self {
            latency_ewma_ms: None,
            consecutive_failures: 0,
            backoff_until: None,
            inflight: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn available(&self, now: Instant) -> bool {
        self.backoff_until.is_none_or(|until| now >= until)
    }

    fn score(&self) -> f64 {
        self.latency_ewma_ms.unwrap_or(PEER_UNKNOWN_LATENCY_MS)
            + self.inflight.load(Ordering::Relaxed) as f64 * PEER_INFLIGHT_PENALTY_MS
    }
}

#[derive(Default)]
struct PeerSelector {
    peers: HashMap<String, PeerStats>,
}

impl PeerSelector {
    fn sync_candidates(&mut self, candidate_ids: &[String]) {
        let active = candidate_ids.iter().cloned().collect::<HashSet<_>>();
        self.peers
            .retain(|id, stats| active.contains(id) || stats.inflight.load(Ordering::Relaxed) > 0);
        for id in candidate_ids {
            self.peers.entry(id.clone()).or_insert_with(PeerStats::new);
        }
    }

    fn reserve_best(
        &mut self,
        candidate_ids: &[String],
        attempted: &HashSet<String>,
        now: Instant,
    ) -> Option<(String, PeerLoad)> {
        let selected = candidate_ids
            .iter()
            .filter(|id| !attempted.contains(*id))
            .filter_map(|id| {
                self.peers
                    .get(id)
                    .filter(|stats| stats.available(now))
                    .map(|stats| (id, stats.score()))
            })
            .min_by(|(left_id, left_score), (right_id, right_score)| {
                left_score
                    .total_cmp(right_score)
                    .then_with(|| left_id.cmp(right_id))
            })?
            .0
            .clone();
        let inflight = self.peers.get(&selected)?.inflight.clone();
        Some((selected, PeerLoad::reserve(inflight)))
    }

    fn record_success(&mut self, id: &str, latency: Duration) {
        let stats = self
            .peers
            .entry(id.to_owned())
            .or_insert_with(PeerStats::new);
        let sample = latency.as_secs_f64() * 1_000.0;
        stats.latency_ewma_ms = Some(match stats.latency_ewma_ms {
            Some(previous) => {
                previous * (1.0 - PEER_EWMA_NEW_SAMPLE_WEIGHT)
                    + sample * PEER_EWMA_NEW_SAMPLE_WEIGHT
            }
            None => sample,
        });
        stats.consecutive_failures = 0;
        stats.backoff_until = None;
    }

    fn record_failure(&mut self, id: &str, now: Instant) {
        let stats = self
            .peers
            .entry(id.to_owned())
            .or_insert_with(PeerStats::new);
        stats.consecutive_failures = stats.consecutive_failures.saturating_add(1);
        let shift = stats.consecutive_failures.saturating_sub(1).min(5);
        let backoff_ms = PEER_BACKOFF_BASE_MS
            .saturating_mul(1u64 << shift)
            .min(PEER_BACKOFF_MAX_MS);
        stats.backoff_until = Some(now + Duration::from_millis(backoff_ms));
    }
}

struct PeerLoad(Arc<AtomicUsize>);

impl PeerLoad {
    fn reserve(count: Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::Relaxed);
        Self(count)
    }
}

impl Drop for PeerLoad {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

pub struct Network {
    pub root: PathBuf,
    pub config: RwLock<Config>,
    endpoint: RwLock<Option<Endpoint>>,
    pub key: SecretKey,
    pub client: reqwest::Client,
    health: RwLock<Health>,
    proxy_address: RwLock<Option<SocketAddr>>,
    proxy_token: String,
    transition: RwLock<()>,
    pub local_slots: Arc<Semaphore>,
    peer_slots: Arc<Semaphore>,
    peer_connections: Arc<Semaphore>,
    peer_stream_limits: Mutex<HashMap<String, Weak<Semaphore>>>,
    peer_connection_limits: Mutex<HashMap<String, Weak<Semaphore>>>,
    peer_selector: Mutex<PeerSelector>,
    logs: Mutex<VecDeque<Value>>,
    auto_start: RwLock<bool>,
    startup_preference: RwLock<Option<bool>>,
}

impl Network {
    pub async fn open(root: PathBuf) -> Result<Arc<Self>> {
        tokio::fs::create_dir_all(&root).await?;
        #[cfg(unix)]
        crate::launch_agent::ensure_private_dir(&root)?;
        let config_file = root.join("network.json");
        let mut config: Config = match tokio::fs::read(&config_file).await {
            Ok(bytes) => serde_json::from_slice(&bytes).context("网络服务配置损坏")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Config::default(),
            Err(error) => return Err(error.into()),
        };
        config.validate()?;
        let key_path = root.join("device.key");
        let key = match tokio::fs::read(&key_path).await {
            Ok(bytes) => SecretKey::from_bytes(
                &bytes
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("设备身份文件损坏"))?,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let key = SecretKey::generate();
                write_atomic(&key_path, &key.to_bytes()).await?;
                key
            }
            Err(error) => return Err(error.into()),
        };
        let mut token = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut token);
        let mut client_builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(5));
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("RIGHTDATA_TEST_CA_PEM") {
            let path = PathBuf::from(path);
            ensure!(path.is_absolute(), "RIGHTDATA_TEST_CA_PEM 必须为绝对路径");
            client_builder = client_builder.add_root_certificate(reqwest::Certificate::from_pem(
                &tokio::fs::read(path).await?,
            )?);
        }
        let client = client_builder.build()?;
        let existing_logs = tokio::fs::read_to_string(root.join("network.jsonl"))
            .await
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect::<VecDeque<Value>>();
        let startup_preference = read_startup_preference(&root).await?;
        #[cfg(windows)]
        let auto_start = crate::windows_service::query_auto_start().unwrap_or(false);
        #[cfg(target_os = "macos")]
        let auto_start = startup_preference.unwrap_or(false);
        #[cfg(not(any(windows, target_os = "macos")))]
        let auto_start = false;
        let network = Arc::new(Self {
            root,
            config: RwLock::new(config),
            endpoint: RwLock::new(None),
            key,
            client,
            health: RwLock::new(Health::default()),
            proxy_address: RwLock::new(None),
            proxy_token: STANDARD.encode(token),
            transition: RwLock::new(()),
            local_slots: Arc::new(Semaphore::new(LOCAL_TUNNEL_LIMIT)),
            peer_slots: Arc::new(Semaphore::new(PEER_TUNNEL_LIMIT)),
            peer_connections: Arc::new(Semaphore::new(PEER_CONNECTION_LIMIT)),
            peer_stream_limits: Mutex::new(HashMap::new()),
            peer_connection_limits: Mutex::new(HashMap::new()),
            peer_selector: Mutex::new(PeerSelector::default()),
            logs: Mutex::new(existing_logs),
            auto_start: RwLock::new(auto_start),
            startup_preference: RwLock::new(startup_preference),
        });
        network.rebind().await?;
        Ok(network)
    }

    pub async fn set_proxy(&self, address: SocketAddr) {
        *self.proxy_address.write().await = Some(address);
    }
    pub async fn config_snapshot(&self) -> Config {
        self.config.read().await.clone()
    }
    pub fn proxy_authorization(&self) -> String {
        format!(
            "Basic {}",
            STANDARD.encode(format!("rightdata:{}", self.proxy_token))
        )
    }
    pub fn device_id(&self) -> String {
        self.key.public().to_string()
    }
    pub async fn endpoint(&self) -> Result<Endpoint> {
        self.endpoint
            .read()
            .await
            .clone()
            .context("本机网络服务已暂停")
    }
    pub async fn status(&self) -> Value {
        let config = self.config.read().await.clone();
        let health = self.health.read().await.clone();
        let proxy = self
            .proxy_address
            .read()
            .await
            .map(|value| format!("http://{value}"));
        json!({"running":true,"enabled":config.enabled,"autoStart":*self.auto_start.read().await,"deviceId":self.device_id(),"serverUrl":config.server_url,"discoveryUrl":config.discovery_url,"boundInstanceId":config.bound_instance_id,"allowPublicRelay":config.allow_public_relay,"proxyUrl":proxy,"proxyToken":self.proxy_token,"mode":if config.enabled { health.mode } else { "disconnected".into() },"ready":config.enabled && health.ready,"peerId":health.peer_id,"lastError":health.error})
    }
    pub async fn configure(self: &Arc<Self>, mut config: Config) -> Result<Value> {
        config.validate()?;
        let _guard = self.transition.write().await;
        self.apply_config(config).await?;
        Ok(self.status().await)
    }
    async fn apply_config(self: &Arc<Self>, config: Config) -> Result<()> {
        self.unregister().await;
        let changed = {
            let old = self.config.read().await;
            old.allow_public_relay != config.allow_public_relay
                || old.enabled != config.enabled
                || old.server_url != config.server_url
                || old.bound_instance_id != config.bound_instance_id
        };
        write_atomic(
            &self.root.join("network.json"),
            &serde_json::to_vec_pretty(&config)?,
        )
        .await?;
        *self.config.write().await = config;
        *self.health.write().await = Health::default();
        *self.peer_selector.lock().await = PeerSelector::default();
        if changed {
            self.rebind().await?;
        }
        let _ = self.refresh_health().await;
        Ok(())
    }
    pub async fn enable(self: &Arc<Self>, enabled: bool) -> Result<Value> {
        let _guard = self.transition.write().await;
        let mut config = self.config.read().await.clone();
        config.enabled = enabled;
        self.apply_config(config).await?;
        Ok(self.status().await)
    }
    pub async fn set_autostart(&self, enabled: bool) -> Result<Value> {
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = enabled;
            bail!("开机启动仅支持已安装的 Windows 服务");
        }
        #[cfg(target_os = "macos")]
        {
            let _guard = self.transition.write().await;
            crate::launch_agent::set_auto_start(&self.root, enabled)?;
            write_atomic(&self.root.join("startup.json"), &startup_preference_bytes(enabled)?).await?;
            *self.startup_preference.write().await = Some(enabled);
            *self.auto_start.write().await = enabled;
            Ok(self.status().await)
        }
        #[cfg(windows)]
        {
            let _guard = self.transition.write().await;
            write_atomic(
                &self.root.join("startup.json"),
                &startup_preference_bytes(enabled)?,
            )
            .await?;
            *self.startup_preference.write().await = Some(enabled);
            crate::windows_service::set_auto_start(enabled)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            *self.auto_start.write().await = enabled;
            Ok(self.status().await)
        }
    }
    async fn rebind(self: &Arc<Self>) -> Result<()> {
        if let Some(endpoint) = self.endpoint.write().await.take() {
            endpoint.close().await;
        }
        let config = self.config.read().await.clone();
        if !config.enabled {
            return Ok(());
        }
        let mut builder = Endpoint::builder(presets::Minimal)
            .secret_key(self.key.clone())
            .alpns(vec![ALPN.to_vec()])
            .clear_address_lookup();
        if config.allow_public_relay {
            builder = builder.relay_mode(iroh::RelayMode::Default);
        } else {
            builder = builder.clear_relay_transports();
        }
        let endpoint = builder.bind().await.context("无法启动 iroh 网络端点")?;
        *self.endpoint.write().await = Some(endpoint.clone());
        let service = self.clone();
        tokio::spawn(async move {
            service.accept_peers(endpoint).await;
        });
        Ok(())
    }
    pub async fn refresh_health(&self) -> Result<String> {
        let config = self.config.read().await.clone();
        ensure!(config.enabled, "本机网络服务已暂停");
        let response = self
            .client
            .get(format!("{}/api/probe", config.server_url))
            .send()
            .await;
        let mut response = match response {
            Ok(value) => value,
            Err(error) => {
                let mut health = self.health.write().await;
                record_direct_probe_failure(&mut health, false, "内网服务暂不可达".into());
                return Err(error.into());
            }
        };
        let status = response.status();
        ensure!(
            response
                .content_length()
                .is_none_or(|length| length <= 65536),
            "服务探测响应超限"
        );
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(body.len() + chunk.len() <= 65536, "服务探测响应超限");
            body.extend_from_slice(&chunk);
        }
        let checked = (|| -> Result<String> {
            ensure!(
                status.is_success() && body.len() <= 65536,
                "服务探测响应无效"
            );
            let envelope: Value = serde_json::from_slice(&body)?;
            let value = envelope
                .get("data")
                .filter(|_| envelope.get("code").and_then(Value::as_str) == Some("ok"))
                .unwrap_or(&envelope);
            ensure!(
                value
                    .get("service")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.eq_ignore_ascii_case("rightdata")),
                "服务类型不匹配"
            );
            ensure!(
                value.get("ready").and_then(Value::as_bool) == Some(true),
                "服务尚未就绪"
            );
            let instance = value
                .get("instanceId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .context("服务实例标识缺失")?;
            validate_instance_id(instance)?;
            if let Some(expected) = &config.bound_instance_id {
                ensure!(expected == instance, "服务实例不匹配");
            }
            Ok(instance.into())
        })();
        let mut health = self.health.write().await;
        match &checked {
            Ok(_) => record_direct_probe_success(&mut health),
            Err(error) => record_direct_probe_failure(&mut health, true, error.to_string()),
        }
        checked
    }
    pub async fn connect_backend(
        &self,
        expected: &Config,
    ) -> Result<(Tunnel, String, Option<String>)> {
        let _setup = self.transition.read().await;
        let config = self.config.read().await.clone();
        ensure!(&config == expected, "网络设置已变更，请重试请求");
        ensure!(config.enabled, "本机网络服务已暂停");
        let stale = self
            .health
            .read()
            .await
            .checked
            .is_none_or(|instant| instant.elapsed() > Duration::from_secs(10));
        if stale {
            let _ = self.refresh_health().await;
        }
        let health = self.health.read().await.clone();
        let target = Url::parse(&config.server_url)?;
        if health.ready && health.mode == "direct" {
            let connected = tokio::time::timeout(
                Duration::from_secs(3),
                TcpStream::connect((
                    target.host_str().context("后端主机缺失")?,
                    target.port_or_known_default().context("后端端口缺失")?,
                )),
            )
            .await;
            if let Ok(Ok(stream)) = connected {
                return Ok((Box::new(stream), "direct".into(), None));
            }
            let mut current = self.health.write().await;
            current.ready = false;
            current.reachable = false;
        } else if health.reachable && !health.ready {
            bail!(
                "{}",
                health.error.unwrap_or_else(|| "内网服务尚未就绪".into())
            );
        }
        ensure!(
            target.scheme() == "https" || insecure_peer_tests(),
            "外网节点连接需要 HTTPS 服务地址，以验证服务身份"
        );
        let instance = config
            .bound_instance_id
            .as_ref()
            .context("外网连接需要预置或已验证的服务实例标识")?;
        let nodes = discovery::lookup(self, &config).await?;
        let endpoint = self.endpoint().await?;
        let candidates = nodes
            .into_iter()
            .filter(|node| node.endpoint_id != self.device_id())
            .collect::<Vec<_>>();
        let candidate_ids = candidates
            .iter()
            .map(|node| node.endpoint_id.clone())
            .collect::<Vec<_>>();
        self.peer_selector
            .lock()
            .await
            .sync_candidates(&candidate_ids);
        let candidates = candidates
            .into_iter()
            .map(|node| (node.endpoint_id.clone(), node))
            .collect::<HashMap<_, _>>();
        let mut attempted = HashSet::new();
        let mut last_error = "没有可用的内网节点".to_string();
        let peer_deadline = Instant::now() + Duration::from_secs(8);
        for _ in 0..candidate_ids.len().min(PEER_ATTEMPT_LIMIT) {
            let remaining = peer_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                last_error = "节点连接超时".into();
                break;
            }
            let Some((peer_id, load)) = self.peer_selector.lock().await.reserve_best(
                &candidate_ids,
                &attempted,
                Instant::now(),
            ) else {
                if attempted.is_empty() && !candidate_ids.is_empty() {
                    last_error = "可用节点暂处于失败退避".into();
                }
                break;
            };
            attempted.insert(peer_id.clone());
            let Some(node) = candidates.get(&peer_id).cloned() else {
                drop(load);
                continue;
            };
            let started = Instant::now();
            let attempt_endpoint = endpoint.clone();
            let allow_public_relay = config.allow_public_relay;
            let connected = tokio::time::timeout(remaining.min(Duration::from_secs(5)), async move {
                let connection = attempt_endpoint.connect(node.address(allow_public_relay)?, ALPN).await?;
                let (mut send, mut receive) = connection.open_bi().await?;
                write_frame(&mut send, &json!({"v":1,"op":"tcp-tunnel","expectedInstanceId":instance,"targetAlias":"backend"})).await?;
                let reply: Value = read_frame(&mut receive).await?;
                ensure!(reply.get("ok").and_then(Value::as_bool) == Some(true), "节点拒绝后端隧道");
                let (caller, mut pump) = tokio::io::duplex(256 * 1024);
                tokio::spawn(async move {
                    let _load = load;
                    let (mut local_read, mut local_write) = tokio::io::split(&mut pump);
                    let _ = relay_with_idle_timeout(&mut local_read, &mut send, &mut receive, &mut local_write, PEER_IDLE_TIMEOUT).await;
                    drop(connection);
                });
                Ok::<_, anyhow::Error>(caller)
            }).await;
            match connected {
                Ok(Ok(tunnel)) => {
                    self.peer_selector
                        .lock()
                        .await
                        .record_success(&peer_id, started.elapsed());
                    let mut current = self.health.write().await;
                    current.ready = true;
                    current.mode = "peer".into();
                    current.peer_id = Some(peer_id.clone());
                    current.error = None;
                    drop(current);
                    self.log(
                        "connect",
                        "backend",
                        "success",
                        started.elapsed(),
                        Some(&peer_id),
                        0,
                        0,
                    )
                    .await;
                    return Ok((Box::new(tunnel), "peer".into(), Some(peer_id)));
                }
                Ok(Err(error)) => {
                    self.peer_selector
                        .lock()
                        .await
                        .record_failure(&peer_id, Instant::now());
                    last_error = error.to_string();
                }
                Err(_) => {
                    self.peer_selector
                        .lock()
                        .await
                        .record_failure(&peer_id, Instant::now());
                    last_error = "节点连接超时".into();
                }
            }
        }
        let mut current = self.health.write().await;
        current.ready = false;
        current.mode = "disconnected".into();
        current.error = Some(last_error.clone());
        bail!("{last_error}")
    }
    async fn accept_peers(self: Arc<Self>, endpoint: Endpoint) {
        while let Some(incoming) = endpoint.accept().await {
            let Ok(connection_slot) = self.peer_connections.clone().try_acquire_owned() else {
                drop(incoming);
                continue;
            };
            let service = self.clone();
            tokio::spawn(async move {
                let _connection_slot = connection_slot;
                let Ok(Ok(connection)) =
                    tokio::time::timeout(Duration::from_secs(10), incoming).await
                else {
                    return;
                };
                let peer_id = connection.remote_id().to_string();
                // The Iroh identity is a transport identity and abuse-control key. It does not
                // replace the backend's business authentication, which remains end-to-end TLS.
                let connection_limit = limiter_for(
                    &service.peer_connection_limits,
                    &peer_id,
                    PEER_CONNECTIONS_PER_DEVICE,
                )
                .await;
                let Ok(_peer_connection_slot) = connection_limit.try_acquire_owned() else {
                    return;
                };
                let active_streams = Arc::new(AtomicUsize::new(0));
                loop {
                    let accepted =
                        tokio::time::timeout(PEER_IDLE_TIMEOUT, connection.accept_bi()).await;
                    let (mut send, mut receive) = match accepted {
                        Ok(Ok(stream)) => stream,
                        Ok(Err(_)) => break,
                        Err(_) if active_streams.load(Ordering::Relaxed) == 0 => break,
                        Err(_) => continue,
                    };
                    let peer_limit = limiter_for(
                        &service.peer_stream_limits,
                        &peer_id,
                        PEER_TUNNELS_PER_DEVICE,
                    )
                    .await;
                    let Ok(peer_slot) = peer_limit.try_acquire_owned() else {
                        let _ = send.reset(1u32.into());
                        continue;
                    };
                    let Ok(global_slot) = service.peer_slots.clone().try_acquire_owned() else {
                        let _ = send.reset(1u32.into());
                        continue;
                    };
                    let service = service.clone();
                    let peer_id = peer_id.clone();
                    let active_stream = ActiveStream::new(active_streams.clone());
                    tokio::spawn(async move {
                        let _peer_slot = peer_slot;
                        let _global_slot = global_slot;
                        let _active = active_stream;
                        let started = Instant::now();
                        let setup = tokio::time::timeout(Duration::from_secs(8), async {
                            let _setup = service.transition.read().await;
                            let request: Value = read_frame(&mut receive).await?;
                            ensure!(
                                request.get("v").and_then(Value::as_u64) == Some(1)
                                    && request.get("op").and_then(Value::as_str)
                                        == Some("tcp-tunnel")
                                    && request.get("targetAlias").and_then(Value::as_str)
                                        == Some("backend"),
                                "非法隧道请求"
                            );
                            let instance = service.refresh_health().await?;
                            ensure!(
                                request.get("expectedInstanceId").and_then(Value::as_str)
                                    == Some(instance.as_str()),
                                "服务实例不匹配"
                            );
                            let config = service.config.read().await.clone();
                            let backend = Url::parse(&config.server_url)?;
                            ensure!(
                                backend.scheme() == "https" || insecure_peer_tests(),
                                "节点仅转发端到端 TLS 连接"
                            );
                            let socket = TcpStream::connect((
                                backend.host_str().context("后端主机缺失")?,
                                backend.port_or_known_default().context("后端端口缺失")?,
                            ))
                            .await?;
                            Ok::<_, anyhow::Error>(socket)
                        })
                        .await;
                        let Ok(Ok(mut socket)) = setup else {
                            let _ = write_frame(&mut send, &json!({"v":1,"ok":false,"error":{"code":"tunnel_rejected","message":"节点后端不可用或实例不匹配"}})).await;
                            let _ = send.finish();
                            return;
                        };
                        if write_frame(&mut send, &json!({"v":1,"ok":true}))
                            .await
                            .is_err()
                        {
                            return;
                        }
                        let (mut tcp_read, mut tcp_write) = socket.split();
                        let result = relay_with_idle_timeout(
                            &mut receive,
                            &mut tcp_write,
                            &mut tcp_read,
                            &mut send,
                            PEER_IDLE_TIMEOUT,
                        )
                        .await;
                        let (sent, received) = result.as_ref().copied().unwrap_or_default();
                        service
                            .log(
                                "forward",
                                "backend",
                                if result.is_ok() { "success" } else { "failed" },
                                started.elapsed(),
                                Some(&peer_id),
                                sent,
                                received,
                            )
                            .await;
                    });
                }
            });
        }
    }
    pub async fn log(
        &self,
        action: &str,
        target: &str,
        outcome: &str,
        elapsed: Duration,
        peer_id: Option<&str>,
        sent: u64,
        received: u64,
    ) {
        let health = self.health.read().await.clone();
        let record = json!({"id":uuid::Uuid::new_v4().to_string(),"createdAt":chrono::Utc::now().to_rfc3339(),"action":action,"target":target,"outcome":outcome,"durationMs":elapsed.as_millis(),"mode":health.mode,"peerId":peer_id,"bytesSent":sent,"bytesReceived":received});
        let mut logs = self.logs.lock().await;
        logs.push_back(record);
        while logs.len() > LOG_LIMIT {
            logs.pop_front();
        }
        let mut bytes = Vec::new();
        for item in logs.iter() {
            if let Ok(mut line) = serde_json::to_vec(item) {
                bytes.append(&mut line);
                bytes.push(b'\n');
            }
        }
        let _ = write_atomic(&self.root.join("network.jsonl"), &bytes).await;
    }
    pub async fn logs(&self, limit: usize, offset: usize) -> Value {
        json!({"items":self.logs.lock().await.iter().rev().skip(offset).take(limit.min(100)).cloned().collect::<Vec<_>>()})
    }
    async fn unregister(&self) {
        let config = self.config.read().await.clone();
        let _ = discovery::unregister(self, &config).await;
    }
    pub async fn shutdown(&self) {
        let _guard = self.transition.write().await;
        self.unregister().await;
        if let Some(endpoint) = self.endpoint.write().await.take() {
            endpoint.close().await;
        }
    }
}

pub fn insecure_peer_tests() -> bool {
    cfg!(debug_assertions)
        && std::env::var("RIGHTDATA_ALLOW_INSECURE_PEER_TEST").as_deref() == Ok("1")
}

#[cfg(windows)]
async fn replace_atomic(temp: &Path, destination: &Path) -> std::io::Result<()> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let temp = wide(temp.as_os_str());
    let destination = wide(destination.as_os_str());
    if unsafe {
        MoveFileExW(
            temp.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
async fn replace_atomic(temp: &Path, destination: &Path) -> std::io::Result<()> {
    tokio::fs::rename(temp, destination).await
}

pub async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .await?;
    if let Err(error) = output.write_all(bytes).await {
        drop(output);
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(error.into());
    }
    if let Err(error) = output.sync_all().await {
        drop(output);
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(error.into());
    }
    drop(output);
    let result = replace_atomic(&temp, path).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result.context("无法保存本机网络状态")
}

pub async fn maintain(service: Arc<Network>) {
    let mut interval = tokio::time::interval(Duration::from_secs(20));
    loop {
        interval.tick().await;
        let _guard = service.transition.write().await;
        let mut config = service.config.read().await.clone();
        if !config.enabled {
            continue;
        }
        match service.refresh_health().await {
            Ok(instance) => {
                // Bind automatically only to the directly reached local service.
                if config.bound_instance_id.is_none() {
                    config.bound_instance_id = Some(instance);
                    *service.config.write().await = config.clone();
                    let _ = write_atomic(
                        &service.root.join("network.json"),
                        &serde_json::to_vec_pretty(&config).unwrap_or_default(),
                    )
                    .await;
                }
                if discovery::register(&service, &config).await.is_ok()
                    && config.discovery_url.is_some()
                {
                    #[cfg(windows)]
                    {
                        let preference = *service.startup_preference.read().await;
                        let actual = *service.auto_start.read().await;
                        if should_default_enable_autostart(preference, actual)
                            && crate::windows_service::set_auto_start(true).is_ok()
                        {
                            *service.auto_start.write().await = true;
                        }
                    }
                    #[cfg(target_os = "macos")]
                    {
                        let preference = *service.startup_preference.read().await;
                        let actual = *service.auto_start.read().await;
                        if should_default_enable_autostart(preference, actual)
                            && crate::launch_agent::set_auto_start(&service.root, true).is_ok()
                            && write_atomic(&service.root.join("startup.json"), &startup_preference_bytes(true).unwrap_or_default()).await.is_ok()
                        {
                            *service.startup_preference.write().await = Some(true);
                            *service.auto_start.write().await = true;
                        }
                    }
                }
            }
            Err(_) => {
                let _ = discovery::unregister(&service, &config).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_credential_and_path_targets() {
        for value in [
            "http://user:pass@localhost",
            "http://localhost/private",
            "file:///tmp/a",
            "http://localhost?target=evil",
        ] {
            assert!(validate_url(value, false).is_err());
        }
        assert!(validate_url("https://service.internal:8443", false).is_ok());
        assert!(validate_url("http://example.com", true).is_err());
        assert!(validate_url("http://127.0.0.1:18040", true).is_ok());
    }

    #[test]
    fn instance_ids_match_discovery_path_contract() {
        for valid in ["a", "instance_01-west", &"x".repeat(100)] {
            assert!(validate_instance_id(valid).is_ok(), "{valid}");
        }
        for invalid in ["", "a/b", "a?query", "contains space", &"x".repeat(101)] {
            assert!(validate_instance_id(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn startup_default_enables_only_before_user_choice() {
        assert!(should_default_enable_autostart(None, false));
        assert!(!should_default_enable_autostart(None, true));
        assert!(!should_default_enable_autostart(Some(true), false));
    }

    #[test]
    fn explicit_startup_disable_blocks_default_enable() {
        assert!(!should_default_enable_autostart(Some(false), false));
        assert!(!should_default_enable_autostart(Some(false), true));
    }

    #[test]
    fn startup_preference_round_trips_across_restart() {
        for expected in [false, true] {
            let persisted = startup_preference_bytes(expected).unwrap();
            assert_eq!(parse_startup_preference(&persisted).unwrap(), expected);
        }
        let incompatible = br#"{"version":2,"autoStart":false}"#;
        assert!(parse_startup_preference(incompatible).is_err());
    }

    #[test]
    fn peer_selector_prefers_low_latency_then_spreads_inflight_load() {
        let mut selector = PeerSelector::default();
        let ids = vec!["fast".to_string(), "slow".to_string()];
        selector.sync_candidates(&ids);
        selector.record_success("fast", Duration::from_millis(40));
        selector.record_success("slow", Duration::from_millis(180));
        let now = Instant::now();

        let (first_id, first_load) = selector
            .reserve_best(&ids, &HashSet::new(), now)
            .expect("first peer");
        assert_eq!(first_id, "fast");

        let (second_id, second_load) = selector
            .reserve_best(&ids, &HashSet::new(), now)
            .expect("second peer");
        assert_eq!(second_id, "slow");

        drop(first_load);
        drop(second_load);
        assert_eq!(selector.peers["fast"].inflight.load(Ordering::Relaxed), 0);
        assert_eq!(selector.peers["slow"].inflight.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn failed_peer_recovers_after_bounded_backoff() {
        let mut selector = PeerSelector::default();
        let ids = vec!["recovered".to_string(), "healthy".to_string()];
        selector.sync_candidates(&ids);
        selector.record_success("recovered", Duration::from_millis(20));
        selector.record_success("healthy", Duration::from_millis(160));
        let failed_at = Instant::now();
        selector.record_failure("recovered", failed_at);

        let (during_backoff, during_load) = selector
            .reserve_best(&ids, &HashSet::new(), failed_at)
            .expect("healthy peer during backoff");
        assert_eq!(during_backoff, "healthy");
        drop(during_load);

        let retry_at = failed_at + Duration::from_millis(PEER_BACKOFF_BASE_MS + 1);
        let (after_backoff, recovered_load) = selector
            .reserve_best(&ids, &HashSet::new(), retry_at)
            .expect("recovered peer after backoff");
        assert_eq!(after_backoff, "recovered");
        selector.record_success("recovered", Duration::from_millis(30));
        assert_eq!(selector.peers["recovered"].consecutive_failures, 0);
        assert!(selector.peers["recovered"].backoff_until.is_none());
        drop(recovered_load);
    }

    #[test]
    fn peer_mode_survives_probe_failure_and_requires_two_direct_successes() {
        let mut health = Health {
            ready: true,
            reachable: false,
            mode: "peer".into(),
            peer_id: Some("peer-a".into()),
            ..Health::default()
        };

        record_direct_probe_success(&mut health);
        assert!(health.ready);
        assert_eq!(health.mode, "peer");
        assert_eq!(health.direct_successes, 1);

        record_direct_probe_failure(&mut health, false, "direct unavailable".into());
        assert!(health.ready);
        assert_eq!(health.mode, "peer");
        assert_eq!(health.peer_id.as_deref(), Some("peer-a"));
        assert_eq!(health.direct_successes, 0);

        record_direct_probe_success(&mut health);
        assert_eq!(health.mode, "peer");
        assert_eq!(health.direct_successes, 1);
        record_direct_probe_success(&mut health);
        assert!(health.ready);
        assert_eq!(health.mode, "direct");
        assert!(health.peer_id.is_none());
        assert_eq!(health.direct_successes, 0);
    }

    #[tokio::test]
    async fn per_peer_limits_are_isolated_and_release_capacity() {
        let limits = Mutex::new(HashMap::new());
        let first_peer = limiter_for(&limits, "peer-a", 2).await;
        let first = first_peer.clone().try_acquire_owned().unwrap();
        let second = first_peer.clone().try_acquire_owned().unwrap();
        assert!(first_peer.clone().try_acquire_owned().is_err());

        let other_peer = limiter_for(&limits, "peer-b", 2).await;
        assert!(other_peer.try_acquire_owned().is_ok());
        drop(first);
        assert!(first_peer.clone().try_acquire_owned().is_ok());
        drop(second);
    }

    #[tokio::test]
    async fn idle_peer_relay_is_terminated() {
        let (mut upstream, _upstream_peer) = tokio::io::duplex(16);
        let (mut downstream, _downstream_peer) = tokio::io::duplex(16);
        let mut upstream_sink = tokio::io::sink();
        let mut downstream_sink = tokio::io::sink();
        let result = relay_with_idle_timeout(
            &mut upstream,
            &mut upstream_sink,
            &mut downstream,
            &mut downstream_sink,
            Duration::from_millis(20),
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("空闲超时"));
    }
}
