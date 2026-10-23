use crate::error::{ErrorKind, Result, TransportError};
use base64::Engine;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature, StreamVerifier};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

#[cfg(target_os = "macos")]
const PLATFORM: &str = "macos";
#[cfg(not(target_os = "macos"))]
const PLATFORM: &str = "windows";
#[cfg(target_arch = "aarch64")]
const ARCH: &str = "arm64";
#[cfg(not(target_arch = "aarch64"))]
const ARCH: &str = "x64";
#[cfg(target_os = "macos")]
const INSTALLER_EXTENSION: &str = "dmg";
#[cfg(not(target_os = "macos"))]
const INSTALLER_EXTENSION: &str = "exe";
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_INSTALLER_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateSource {
    Internal,
    Public,
    Github,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<UpdateSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub configured: bool,
    pub platform: &'static str,
    pub arch: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadResult {
    pub verified: bool,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallResult {
    pub started: bool,
    pub version: String,
    pub process_id: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateManifest {
    id: String,
    version: String,
    platform: String,
    arch: String,
    signature: String,
    sha256: String,
    size: u64,
    file_name: String,
    download_url: String,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEnvelope {
    code: String,
    #[serde(default)]
    message: String,
    data: Option<UpdateManifest>,
    #[serde(default)]
    request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ManifestDocument {
    Envelope(ManifestEnvelope),
    Direct(UpdateManifest),
}

#[derive(Debug, Clone)]
struct PendingUpdate {
    manifest: UpdateManifest,
    source: UpdateSource,
    download_url: Url,
    current_version: String,
}

#[derive(Debug, Clone)]
struct VerifiedUpdate {
    pending: PendingUpdate,
    path: PathBuf,
}

#[derive(Debug, Default)]
struct ManagerState {
    pending: Option<PendingUpdate>,
    verified: Option<VerifiedUpdate>,
}

/// Owns the update state so commands can only download a manifest returned by
/// `check`, and can only install a package that this process verified.
pub struct UpdateManager {
    staging_dir: PathBuf,
    trusted_key: Option<PublicKey>,
    public_manifest_url: Option<Url>,
    public_url_invalid: bool,
    public_client: Option<Client>,
    github_manifest_url: Option<Url>,
    github_client: Option<Client>,
    operation: Mutex<()>,
    state: Mutex<ManagerState>,
}

impl UpdateManager {
    pub fn from_build(staging_dir: PathBuf) -> Self {
        Self::new_with_github(
            staging_dir,
            Some(option_env!("RIGHTDATA_UPDATE_PUBLIC_KEY").unwrap_or(include_str!("../../update-public-key.pub"))),
            option_env!("RIGHTDATA_PUBLIC_UPDATE_URL"),
            Some(option_env!("RIGHTDATA_GITHUB_REPOSITORY").unwrap_or("WnagoiYy/RightData")),
        )
    }

    pub fn new(
        staging_dir: PathBuf,
        trusted_key: Option<&str>,
        public_manifest_url: Option<&str>,
    ) -> Self {
        Self::new_with_github(staging_dir, trusted_key, public_manifest_url, None)
    }

    fn new_with_github(staging_dir: PathBuf, trusted_key: Option<&str>, public_manifest_url: Option<&str>, repository: Option<&str>) -> Self {
        let public_manifest_url = public_manifest_url.filter(|value| !value.trim().is_empty());
        let trusted_key = trusted_key.and_then(parse_public_key);
        let parsed_public_url = public_manifest_url.and_then(parse_public_manifest_url);
        let public_url_invalid = public_manifest_url.is_some() && parsed_public_url.is_none();
        let public_client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(4))
            .user_agent(concat!("RightData-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .ok();
        let github_manifest_url = repository.and_then(github_manifest_url);
        let repository_prefix = github_manifest_url.as_ref().map(|url| url.path().split("/releases/").next().unwrap().to_string());
        let github_client = Client::builder().no_proxy()
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 5 { return attempt.error("Too many release redirects"); }
                if repository_prefix.as_deref().is_some_and(|prefix| github_redirect_allowed(attempt.url(), prefix)) {
                    attempt.follow()
                } else { attempt.error("Release redirect outside trusted GitHub hosts") }
            }))
            .connect_timeout(Duration::from_secs(4))
            .user_agent(concat!("RightData-Desktop/", env!("CARGO_PKG_VERSION")))
            .build().ok();
        Self {
            staging_dir,
            trusted_key,
            public_manifest_url: parsed_public_url,
            public_url_invalid,
            public_client,
            github_manifest_url,
            github_client,
            operation: Mutex::new(()),
            state: Mutex::new(ManagerState::default()),
        }
    }

    pub fn configured(&self) -> bool {
        self.trusted_key.is_some()
    }

    /// The supplied client is the transport client's current client, so direct
    /// and peer access use exactly the same internal URL and request path.
    pub async fn check(
        &self,
        client: &Client,
        internal_server_url: &str,
        business_token: Option<&str>,
        current_version: &str,
    ) -> Result<UpdateCheckResult> {
        let _operation = self.operation.lock().await;
        let current = parse_stable_version(current_version)?;
        let internal_url = internal_manifest_url(internal_server_url, current_version)?;
        let internal = fetch_manifest(
            client,
            internal_url,
            business_token,
            UpdateSource::Internal,
            current,
            current_version,
        )
        .await;

        let pending = match internal {
            Ok(value) => value,
            Err(CheckFailure::Unavailable(_error)) => {
                self.external_after(UpdateSource::Internal, current_version).await?
            }
            Err(error) => return Err(error.into_transport()),
        };

        let mut state = self.state.lock().await;
        if !same_update(state.verified.as_ref(), pending.as_ref()) {
            state.verified = None;
        }
        state.pending = pending.clone();
        Ok(check_result(
            current_version,
            pending.as_ref(),
            self.configured(),
        ))
    }

    pub async fn download(
        &self,
        client: &Client,
        business_token: Option<&str>,
        version: &str,
    ) -> Result<UpdateDownloadResult> {
        let _operation = self.operation.lock().await;
        let pending = {
            let state = self.state.lock().await;
            state
                .pending
                .clone()
                .filter(|item| item.manifest.version == version)
        }
        .ok_or_else(|| update_validation("update_not_checked", "请重新检查更新后再下载安装包"))?;
        let trusted_key = self.trusted_key.as_ref().ok_or_else(|| {
            update_validation(
                "update_verification_unconfigured",
                "未配置可信更新发布公钥，不能下载或安装更新",
            )
        })?;
        let token = match pending.source {
            UpdateSource::Internal => Some(
                business_token
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        update_validation("update_auth_required", "下载内网更新需要有效登录会话")
                    })?,
            ),
            UpdateSource::Public | UpdateSource::Github => None,
        };
        tokio::fs::create_dir_all(&self.staging_dir)
            .await
            .map_err(|_| update_storage("无法创建更新暂存目录"))?;
        let temporary = self
            .staging_dir
            .join(format!(".download-{}.part", uuid::Uuid::new_v4()));
        let destination = self.staging_dir.join(format!(
            "rightdata-update-{}-{}.{INSTALLER_EXTENSION}",
            pending.manifest.version,
            uuid::Uuid::new_v4()
        ));
        let mut verified_pending = pending.clone();
        loop {
            let download_client = self.client_for_source(client, verified_pending.source)?;
            let download_token = if verified_pending.source == UpdateSource::Internal { token } else { None };
            match self.download_and_verify(download_client, &verified_pending, download_token, trusted_key, &temporary).await {
                Ok(()) => break,
                Err(DownloadFailure::Unavailable(error)) => {
                    let _ = tokio::fs::remove_file(&temporary).await;
                    if verified_pending.source == UpdateSource::Github { return Err(error); }
                    let next = self.external_after(verified_pending.source, &pending.current_version).await?
                        .ok_or_else(|| update_validation("update_fallback_mismatch", "备用更新源没有同一更新安装包"))?;
                    if !same_manifest_package(&pending.manifest, &next.manifest) {
                        return Err(update_validation("update_fallback_mismatch", "备用更新清单与原更新清单不一致"));
                    }
                    verified_pending = next;
                }
                Err(error) => {
                    let _ = tokio::fs::remove_file(&temporary).await;
                    return Err(error.into_transport());
                }
            }
        }
        if tokio::fs::rename(&temporary, &destination).await.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(update_storage("无法保存已验证的更新安装包"));
        }

        let previous = {
            let mut state = self.state.lock().await;
            let old = state.verified.replace(VerifiedUpdate {
                pending: verified_pending.clone(),
                path: destination,
            });
            old.map(|item| item.path)
        };
        if let Some(path) = previous {
            let _ = tokio::fs::remove_file(path).await;
        }
        Ok(UpdateDownloadResult {
            verified: true,
            version: verified_pending.manifest.version,
        })
    }

    /// This is deliberately a separate operation. UI code must obtain explicit
    /// user confirmation before invoking it; no check or download path calls it.
    pub async fn install(&self, version: &str) -> Result<UpdateInstallResult> {
        let _operation = self.operation.lock().await;
        let trusted_key = self.trusted_key.as_ref().ok_or_else(|| {
            update_validation(
                "update_verification_unconfigured",
                "未配置可信更新发布公钥，不能安装更新",
            )
        })?;
        let verified = {
            let state = self.state.lock().await;
            state
                .verified
                .clone()
                .filter(|item| item.pending.manifest.version == version)
        }
        .ok_or_else(|| {
            update_validation("update_not_verified", "安装包尚未通过签名和完整性校验")
        })?;
        if verified.path.parent() != Some(self.staging_dir.as_path()) {
            return Err(update_validation(
                "update_staging_invalid",
                "已验证安装包不在更新暂存目录中",
            ));
        }
        verify_file(trusted_key, &verified.pending.manifest, &verified.path).await?;
        let process_id = launch_installer(&verified.path)?;
        Ok(UpdateInstallResult {
            started: true,
            version: verified.pending.manifest.version,
            process_id,
        })
    }

    fn public_check_url(&self, current_version: &str) -> Result<Url> {
        if self.public_url_invalid {
            return Err(update_validation(
                "public_update_url_invalid",
                "公网更新源配置无效",
            ));
        }
        let mut url = self.public_manifest_url.clone().ok_or_else(|| {
            update_network("public_update_unavailable", "内网不可用且未配置公网更新源")
        })?;
        url.query_pairs_mut()
            .append_pair("platform", PLATFORM)
            .append_pair("arch", ARCH)
            .append_pair("currentVersion", current_version);
        Ok(url)
    }

    fn public_client(&self) -> Result<&Client> {
        self.public_client.as_ref().ok_or_else(|| {
            update_network(
                "public_update_client_unavailable",
                "无法初始化匿名公网更新客户端",
            )
        })
    }

    fn client_for_source<'a>(&'a self, internal: &'a Client, source: UpdateSource) -> Result<&'a Client> {
        match source {
            UpdateSource::Internal => Ok(internal),
            UpdateSource::Public => self.public_client(),
            UpdateSource::Github => self.github_client.as_ref().ok_or_else(|| update_network("github_update_unavailable", "无法初始化 GitHub 更新客户端")),
        }
    }

    async fn external_after(&self, source: UpdateSource, version: &str) -> Result<Option<PendingUpdate>> {
        let current = parse_stable_version(version)?;
        let mut last_error = update_network("update_sources_unavailable", "没有可用的备用更新源");
        if source == UpdateSource::Internal && (self.public_manifest_url.is_some() || self.public_url_invalid) {
            let url = self.public_check_url(version)?;
            match fetch_manifest(self.public_client()?, url, None, UpdateSource::Public, current, version).await {
                Ok(value) => return Ok(value),
                Err(CheckFailure::Unavailable(error)) => last_error = error,
                Err(error) => return Err(error.into_transport()),
            }
        }
        if source != UpdateSource::Github {
            if let Some(url) = &self.github_manifest_url {
                let client = self.github_client.as_ref().ok_or_else(|| update_network("github_update_unavailable", "无法初始化 GitHub 更新客户端"))?;
                return fetch_manifest(client, url.clone(), None, UpdateSource::Github, current, version).await.map_err(CheckFailure::into_transport);
            }
        }
        Err(last_error)
    }

    async fn download_and_verify(
        &self,
        client: &Client,
        pending: &PendingUpdate,
        token: Option<&str>,
        trusted_key: &PublicKey,
        temporary: &Path,
    ) -> std::result::Result<(), DownloadFailure> {
        let mut request = client
            .get(pending.download_url.clone())
            .header("Accept", "application/octet-stream")
            .timeout(DOWNLOAD_TIMEOUT);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(download_reqwest_error)?;
        if response.status() != StatusCode::OK {
            let status = response.status();
            let error = update_http_error(status, "下载更新安装包失败");
            return Err(if download_status_unavailable(status) {
                DownloadFailure::Unavailable(error)
            } else {
                DownloadFailure::Fatal(error)
            });
        }
        if response
            .content_length()
            .is_some_and(|size| size != pending.manifest.size)
        {
            return Err(DownloadFailure::Fatal(update_validation(
                "update_size_mismatch",
                "更新安装包长度与发布清单不一致",
            )));
        }
        let mut output = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary)
            .await
            .map_err(|_| DownloadFailure::Fatal(update_storage("无法创建更新暂存文件")))?;
        let signature =
            decode_signature(&pending.manifest.signature).map_err(DownloadFailure::Fatal)?;
        let expected_sha =
            decode_sha256(&pending.manifest.sha256).map_err(DownloadFailure::Fatal)?;
        let mut verifier =
            PackageVerifier::new(trusted_key, &signature, expected_sha, pending.manifest.size)
                .map_err(DownloadFailure::Fatal)?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(download_reqwest_error)?;
            verifier.update(&chunk).map_err(DownloadFailure::Fatal)?;
            output
                .write_all(&chunk)
                .await
                .map_err(|_| DownloadFailure::Fatal(update_storage("写入更新暂存文件失败")))?;
        }
        verifier.finish().map_err(DownloadFailure::Fatal)?;
        output
            .sync_all()
            .await
            .map_err(|_| DownloadFailure::Fatal(update_storage("保存更新暂存文件失败")))?;
        drop(output);
        Ok(())
    }
}

#[cfg(windows)]
fn launch_installer(path: &Path) -> Result<u32> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, GetLastError};
    use windows_sys::Win32::System::Threading::GetProcessId;
    use windows_sys::Win32::UI::Shell::{
        SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let verb = OsStr::new("runas")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let file = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.nShow = SW_SHOWNORMAL;

    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let error = unsafe { GetLastError() };
        return Err(if error == ERROR_CANCELLED {
            update_validation("update_install_cancelled", "已取消更新安装授权")
        } else {
            update_install_error("update_install_failed", "无法启动更新安装程序")
        });
    }

    let process = info.hProcess;
    if process.is_null() {
        return Err(update_install_error(
            "update_install_failed",
            "更新安装程序未返回进程句柄",
        ));
    }
    let process_id = unsafe { GetProcessId(process) };
    unsafe {
        CloseHandle(process);
    }
    if process_id == 0 {
        return Err(update_install_error(
            "update_install_failed",
            "无法确认更新安装程序进程",
        ));
    }
    Ok(process_id)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn launch_installer(_path: &Path) -> Result<u32> {
    Err(update_validation(
        "update_install_unsupported",
        "当前平台不支持安装 Windows 客户端更新",
    ))
}

#[cfg(target_os = "macos")]
fn launch_installer(path: &Path) -> Result<u32> {
    let child = std::process::Command::new("/usr/bin/open").arg(path).spawn()
        .map_err(|_| update_install_error("update_install_failed", "无法打开更新磁盘映像"))?;
    Ok(child.id())
}

fn github_manifest_url(repository: &str) -> Option<Url> {
    let parts = repository.split('/').collect::<Vec<_>>();
    if parts.len() != 2 || parts.iter().any(|part| part.is_empty() || *part == "." || *part == ".." || !part.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))) { return None; }
    Url::parse(&format!("https://github.com/{repository}/releases/latest/download/latest-{PLATFORM}-{ARCH}.json")).ok()
}

fn github_redirect_allowed(url: &Url, repository_prefix: &str) -> bool {
    url.scheme() == "https" && url.port_or_known_default() == Some(443)
        && url.username().is_empty() && url.password().is_none() && url.fragment().is_none()
        && match url.host_str() {
            Some("github.com") => url.path().starts_with(&format!("{repository_prefix}/releases/")),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com") => true,
            _ => false,
        }
}

fn check_result(
    current_version: &str,
    pending: Option<&PendingUpdate>,
    configured: bool,
) -> UpdateCheckResult {
    UpdateCheckResult {
        available: pending.is_some(),
        current_version: current_version.to_string(),
        version: pending.map(|item| item.manifest.version.clone()),
        size: pending.map(|item| item.manifest.size),
        source: pending.map(|item| item.source),
        notes: pending.and_then(|item| item.manifest.notes.clone()),
        configured,
        platform: PLATFORM,
        arch: ARCH,
    }
}

fn same_update(verified: Option<&VerifiedUpdate>, pending: Option<&PendingUpdate>) -> bool {
    matches!((verified, pending), (Some(verified), Some(pending))
        if verified.pending.manifest.id == pending.manifest.id
            && verified.pending.manifest.version == pending.manifest.version
            && verified.pending.manifest.sha256 == pending.manifest.sha256
            && verified.pending.source == pending.source)
}

fn same_manifest_package(left: &UpdateManifest, right: &UpdateManifest) -> bool {
    left.version == right.version
        && left.size == right.size
        && left.sha256.eq_ignore_ascii_case(&right.sha256)
        && left.signature == right.signature
}

#[derive(Debug)]
enum DownloadFailure {
    Unavailable(TransportError),
    Fatal(TransportError),
}

impl DownloadFailure {
    fn into_transport(self) -> TransportError {
        match self {
            Self::Unavailable(error) | Self::Fatal(error) => error,
        }
    }
}

fn download_reqwest_error(error: reqwest::Error) -> DownloadFailure {
    let unavailable = error.is_connect() || error.is_timeout() || error.is_body();
    let error = TransportError::from_reqwest(error);
    if unavailable {
        DownloadFailure::Unavailable(error)
    } else {
        DownloadFailure::Fatal(error)
    }
}

fn download_status_unavailable(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::NOT_FOUND
            | StatusCode::REQUEST_TIMEOUT
            | StatusCode::GONE
            | StatusCode::TOO_MANY_REQUESTS
    ) || status.is_server_error()
}

#[derive(Debug)]
enum CheckFailure {
    Unavailable(TransportError),
    Other(TransportError),
}

impl CheckFailure {
    fn into_transport(self) -> TransportError {
        match self {
            Self::Unavailable(error) | Self::Other(error) => error,
        }
    }
}

fn check_reqwest_error(error: reqwest::Error) -> CheckFailure {
    let unavailable = error.is_connect() || error.is_timeout() || error.is_body();
    let error = TransportError::from_reqwest(error);
    if unavailable {
        CheckFailure::Unavailable(error)
    } else {
        CheckFailure::Other(error)
    }
}

fn check_status_unavailable(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::NOT_FOUND
            | StatusCode::REQUEST_TIMEOUT
            | StatusCode::GONE
            | StatusCode::TOO_MANY_REQUESTS
    ) || status.is_server_error()
}

async fn fetch_manifest(
    client: &Client,
    url: Url,
    token: Option<&str>,
    source: UpdateSource,
    current_version: (u64, u64, u64),
    current_version_text: &str,
) -> std::result::Result<Option<PendingUpdate>, CheckFailure> {
    let mut request = client
        .get(url.clone())
        .header("Accept", "application/json")
        .timeout(REQUEST_TIMEOUT);
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(check_reqwest_error)?;
    if response.status() == StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !response.status().is_success() {
        let status = response.status();
        let error = update_http_error(status, "检查客户端更新失败");
        // Older servers explicitly reject macOS targets. This is a source
        // capability gap, not a malformed request or an authentication failure.
        if PLATFORM == "macos" && source == UpdateSource::Internal && status == StatusCode::BAD_REQUEST {
            let body = bounded_response(response, MAX_MANIFEST_BYTES).await.map_err(CheckFailure::Other)?;
            if serde_json::from_slice::<serde_json::Value>(&body).ok()
                .and_then(|value| value.get("code").and_then(|value| value.as_str()).map(str::to_owned))
                .as_deref() == Some("unsupported_update_target") {
                return Err(CheckFailure::Unavailable(error));
            }
            return Err(CheckFailure::Other(error));
        }
        return Err(if check_status_unavailable(status) {
            CheckFailure::Unavailable(error)
        } else {
            CheckFailure::Other(error)
        });
    }
    let bytes = bounded_response(response, MAX_MANIFEST_BYTES)
        .await
        .map_err(CheckFailure::Other)?;
    let document: ManifestDocument = serde_json::from_slice(&bytes).map_err(|_| {
        CheckFailure::Other(update_validation(
            "update_manifest_invalid",
            "更新发布清单格式无效",
        ))
    })?;
    let manifest = match document {
        ManifestDocument::Direct(manifest) => manifest,
        ManifestDocument::Envelope(envelope) => {
            if envelope.code != "ok" {
                return Err(CheckFailure::Other(TransportError::server(
                    502,
                    "update_manifest_rejected",
                    if envelope.message.is_empty() {
                        "更新发布清单返回错误".to_string()
                    } else {
                        envelope.message
                    },
                    envelope.request_id,
                )));
            }
            envelope.data.ok_or_else(|| {
                CheckFailure::Other(update_validation(
                    "update_manifest_invalid",
                    "更新发布清单缺少更新信息",
                ))
            })?
        }
    };
    let version = validate_manifest(&manifest)?;
    if version <= current_version {
        return Ok(None);
    }
    let download_url = resolve_download_url(&url, &manifest, source)?;
    Ok(Some(PendingUpdate {
        manifest,
        source,
        download_url,
        current_version: current_version_text.to_string(),
    }))
}

impl From<TransportError> for CheckFailure {
    fn from(error: TransportError) -> Self {
        Self::Other(error)
    }
}

async fn bounded_response(response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(TransportError::from_reqwest)?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(update_validation(
                "update_manifest_too_large",
                "更新发布清单超过大小限制",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn validate_manifest(manifest: &UpdateManifest) -> Result<(u64, u64, u64)> {
    if manifest.id.is_empty()
        || manifest.id.len() > 100
        || !manifest
            .id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-'))
    {
        return Err(update_validation(
            "update_manifest_invalid",
            "更新发布标识无效",
        ));
    }
    let version = parse_stable_version(&manifest.version)?;
    if manifest.platform != PLATFORM || manifest.arch != ARCH {
        return Err(update_validation(
            "update_target_mismatch",
            "更新安装包不适用于当前平台或架构",
        ));
    }
    if manifest.size == 0 || manifest.size > MAX_INSTALLER_BYTES {
        return Err(update_validation(
            "update_size_invalid",
            "更新安装包大小无效",
        ));
    }
    decode_sha256(&manifest.sha256)?;
    decode_signature(&manifest.signature)?;
    let file_name = Path::new(&manifest.file_name);
    if manifest.file_name.is_empty()
        || manifest.file_name.len() > 255
        || file_name.file_name().and_then(|value| value.to_str()) != Some(&manifest.file_name)
        || !manifest.file_name.to_ascii_lowercase().ends_with(&format!(".{INSTALLER_EXTENSION}"))
    {
        return Err(update_validation(
            "update_file_name_invalid",
            "更新安装包文件名无效",
        ));
    }
    if manifest
        .notes
        .as_ref()
        .is_some_and(|notes| notes.len() > 16 * 1024)
    {
        return Err(update_validation(
            "update_notes_too_large",
            "更新说明超过大小限制",
        ));
    }
    Ok(version)
}

fn resolve_download_url(
    manifest_url: &Url,
    manifest: &UpdateManifest,
    source: UpdateSource,
) -> Result<Url> {
    let url = manifest_url
        .join(&manifest.download_url)
        .map_err(|_| update_validation("update_download_url_invalid", "更新安装包地址无效"))?;
    if url.origin() != manifest_url.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(update_validation(
            "update_source_mismatch",
            "更新安装包地址不属于发布清单来源",
        ));
    }
    match source {
        UpdateSource::Internal => {
            let expected = format!("/api/v1/client-updates/{}/download", manifest.id);
            if url.path() != expected || url.query().is_some() {
                return Err(update_validation(
                    "update_download_path_invalid",
                    "内网更新安装包地址不符合受控下载路径",
                ));
            }
        }
        UpdateSource::Public if url.scheme() != "https" => {
            return Err(update_validation(
                "public_update_url_insecure",
                "公网更新安装包必须使用 HTTPS",
            ));
        }
        UpdateSource::Public => {}
        UpdateSource::Github => {
            let prefix = manifest_url.path().split("/releases/").next().unwrap_or("");
            let expected = format!("{prefix}/releases/download/v{}/{}", manifest.version, manifest.file_name);
            if url.scheme() != "https" || url.host_str() != Some("github.com") || url.path() != expected || url.query().is_some() {
                return Err(update_validation("github_update_path_invalid", "GitHub 更新包必须属于同一仓库的固定版本 Release"));
            }
        }
    }
    Ok(url)
}

fn internal_manifest_url(server_url: &str, current_version: &str) -> Result<Url> {
    let mut base = Url::parse(server_url)
        .map_err(|_| update_validation("invalid_server_url", "服务端地址格式无效"))?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
        || !matches!(base.path(), "" | "/")
    {
        return Err(update_validation(
            "invalid_server_url",
            "服务端地址只能包含协议、主机和端口",
        ));
    }
    base.set_path("/api/v1/client-updates/latest");
    base.query_pairs_mut()
        .append_pair("platform", PLATFORM)
        .append_pair("arch", ARCH)
        .append_pair("currentVersion", current_version);
    Ok(base)
}

fn parse_public_manifest_url(value: &str) -> Option<Url> {
    let url = Url::parse(value.trim()).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

fn parse_public_key(value: &str) -> Option<PublicKey> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.lines().count() > 1 {
        PublicKey::decode(value).ok()
    } else {
        PublicKey::from_base64(value).ok()
    }
}

fn parse_stable_version(value: &str) -> Result<(u64, u64, u64)> {
    if value.is_empty() || value.len() > 64 {
        return Err(update_validation(
            "update_version_invalid",
            "更新版本必须是稳定的 SemVer 版本",
        ));
    }
    let mut parts = value.split('.');
    let numbers = [parts.next(), parts.next(), parts.next()];
    if parts.next().is_some()
        || numbers.iter().any(|part| {
            part.is_none_or(|part| {
                part.is_empty()
                    || part.len() > 1 && part.starts_with('0')
                    || !part.bytes().all(|value| value.is_ascii_digit())
            })
        })
    {
        return Err(update_validation(
            "update_version_invalid",
            "更新版本必须是稳定的 SemVer 版本",
        ));
    }
    let parsed = numbers.map(|part| part.unwrap().parse::<u64>());
    match parsed {
        [Ok(major), Ok(minor), Ok(patch)] if value.len() <= 64 => Ok((major, minor, patch)),
        _ => Err(update_validation(
            "update_version_invalid",
            "更新版本必须是稳定的 SemVer 版本",
        )),
    }
}

fn should_use_public_fallback(connection_failure: bool) -> bool {
    connection_failure
}

fn decode_sha256(value: &str) -> Result<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err(update_validation(
            "update_sha256_invalid",
            "更新安装包 SHA-256 无效",
        ));
    }
    let mut result = [0u8; 32];
    hex::decode_to_slice(value, &mut result)
        .map_err(|_| update_validation("update_sha256_invalid", "更新安装包 SHA-256 无效"))?;
    Ok(result)
}

fn decode_signature(value: &str) -> Result<Signature> {
    if value.is_empty() || value.len() > 64 * 1024 {
        return Err(update_validation(
            "update_signature_invalid",
            "更新安装包签名无效",
        ));
    }
    if let Ok(signature) = Signature::decode(value) {
        return Ok(signature);
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok());
    decoded
        .as_deref()
        .and_then(|value| Signature::decode(value).ok())
        .ok_or_else(|| update_validation("update_signature_invalid", "更新安装包签名无效"))
}

struct PackageVerifier<'a> {
    sha256: Sha256,
    minisign: StreamVerifier<'a>,
    expected_sha256: [u8; 32],
    expected_size: u64,
    size: u64,
}

impl<'a> PackageVerifier<'a> {
    fn new(
        key: &'a PublicKey,
        signature: &'a Signature,
        expected_sha256: [u8; 32],
        expected_size: u64,
    ) -> Result<Self> {
        let minisign = key.verify_stream(signature).map_err(|_| {
            update_validation(
                "update_signature_invalid",
                "更新安装包必须使用受信公钥的 Minisign 预哈希签名",
            )
        })?;
        Ok(Self {
            sha256: Sha256::new(),
            minisign,
            expected_sha256,
            expected_size,
            size: 0,
        })
    }

    fn update(&mut self, bytes: &[u8]) -> Result<()> {
        self.size = self.size.saturating_add(bytes.len() as u64);
        if self.size > self.expected_size || self.size > MAX_INSTALLER_BYTES {
            return Err(update_validation(
                "update_size_mismatch",
                "更新安装包长度与发布清单不一致",
            ));
        }
        self.sha256.update(bytes);
        self.minisign.update(bytes);
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        if self.size != self.expected_size {
            return Err(update_validation(
                "update_size_mismatch",
                "更新安装包长度与发布清单不一致",
            ));
        }
        let digest = self.sha256.finalize();
        if digest.as_slice() != self.expected_sha256 {
            return Err(update_validation(
                "update_sha256_mismatch",
                "更新安装包完整性校验失败",
            ));
        }
        self.minisign
            .finalize()
            .map_err(|_| update_validation("update_signature_mismatch", "更新安装包签名校验失败"))
    }
}

async fn verify_file(key: &PublicKey, manifest: &UpdateManifest, path: &Path) -> Result<()> {
    let signature = decode_signature(&manifest.signature)?;
    let expected_sha = decode_sha256(&manifest.sha256)?;
    let mut verifier = PackageVerifier::new(key, &signature, expected_sha, manifest.size)?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| update_storage("已验证安装包不再可用"))?;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|_| update_storage("无法重新读取已验证安装包"))?;
        if count == 0 {
            break;
        }
        verifier.update(&buffer[..count])?;
    }
    verifier.finish()
}

fn update_validation(code: &str, message: &str) -> TransportError {
    TransportError::validation(code, message)
}

fn update_storage(message: &str) -> TransportError {
    TransportError::new(ErrorKind::Storage, "update_storage_failed", message)
}

fn update_install_error(code: &str, message: &str) -> TransportError {
    TransportError::new(ErrorKind::Storage, code, message)
}

fn update_network(code: &str, message: &str) -> TransportError {
    let mut error = TransportError::new(ErrorKind::Network, code, message);
    error.retryable = true;
    error
}

fn update_http_error(status: StatusCode, message: &str) -> TransportError {
    TransportError::server(status.as_u16(), "update_request_failed", message, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn release_script_signature_is_accepted_by_native_verifier() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../test/fixtures/update-signature.json")).unwrap();
        let key = PublicKey::from_base64(fixture["trustedKey"].as_str().unwrap()).unwrap();
        let signature = decode_signature(fixture["signature"].as_str().unwrap()).unwrap();
        let hash = decode_sha256(fixture["sha256"].as_str().unwrap()).unwrap();
        let mut verifier = PackageVerifier::new(&key, &signature, hash, fixture["size"].as_u64().unwrap()).unwrap();
        verifier.update(b"RightData release signing fixture").unwrap();
        verifier.finish().unwrap();
    }

    #[test]
    fn github_redirects_and_assets_are_repository_bound() {
        let manifest_url = github_manifest_url("WnagoiYy/RightData").unwrap();
        assert!(github_manifest_url("owner/../repo").is_none());
        assert!(github_redirect_allowed(&Url::parse("https://release-assets.githubusercontent.com/a").unwrap(), "/WnagoiYy/RightData"));
        for value in ["http://github.com/WnagoiYy/RightData/releases/a", "https://github.com/other/repo/releases/a", "https://evil.example/a", "https://github.com:444/WnagoiYy/RightData/releases/a"] {
            assert!(!github_redirect_allowed(&Url::parse(value).unwrap(), "/WnagoiYy/RightData"));
        }
        let mut manifest = test_manifest(&format!("https://github.com/WnagoiYy/RightData/releases/download/v1.2.3/rightdata.{INSTALLER_EXTENSION}"));
        assert!(resolve_download_url(&manifest_url, &manifest, UpdateSource::Github).is_ok());
        manifest.download_url = format!("https://github.com/other/repo/releases/download/v1.2.3/rightdata.{INSTALLER_EXTENSION}");
        assert!(resolve_download_url(&manifest_url, &manifest, UpdateSource::Github).is_err());
    }

    #[test]
    fn empty_public_configuration_does_not_block_github_fallback() {
        let manager = UpdateManager::new_with_github(PathBuf::from("updates"), Some(TEST_KEY), Some(""), Some("WnagoiYy/RightData"));
        assert!(!manager.public_url_invalid);
        assert!(manager.github_manifest_url.is_some());
    }

    const TEST_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const TEST_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
    const TEST_SHA256: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

    fn test_manifest(download_url: &str) -> UpdateManifest {
        UpdateManifest {
            id: "update-1".into(),
            version: "1.2.3".into(),
            platform: PLATFORM.into(),
            arch: ARCH.into(),
            signature: TEST_SIGNATURE.into(),
            sha256: TEST_SHA256.into(),
            size: 4,
            file_name: format!("rightdata.{INSTALLER_EXTENSION}"),
            download_url: download_url.into(),
            notes: None,
        }
    }

    #[test]
    fn signature_and_sha_reject_tampered_package() {
        let key = PublicKey::from_base64(TEST_KEY).unwrap();
        let signature = Signature::decode(TEST_SIGNATURE).unwrap();
        let expected = decode_sha256(TEST_SHA256).unwrap();
        let mut valid = PackageVerifier::new(&key, &signature, expected, 4).unwrap();
        valid.update(b"test").unwrap();
        valid.finish().unwrap();

        let mut tampered = PackageVerifier::new(&key, &signature, expected, 4).unwrap();
        tampered.update(b"Test").unwrap();
        assert_eq!(
            tampered.finish().unwrap_err().code,
            "update_sha256_mismatch"
        );

        let altered_text = TEST_SIGNATURE.replace("y/rUw2", "x/rUw2");
        let altered_signature = Signature::decode(&altered_text).unwrap();
        let mut altered = PackageVerifier::new(&key, &altered_signature, expected, 4).unwrap();
        altered.update(b"test").unwrap();
        assert_eq!(
            altered.finish().unwrap_err().code,
            "update_signature_mismatch"
        );
    }

    #[test]
    fn signature_accepts_raw_and_base64_wrapped_minisign_text() {
        assert!(decode_signature(TEST_SIGNATURE).is_ok());
        let wrapped = base64::engine::general_purpose::STANDARD.encode(TEST_SIGNATURE);
        assert!(decode_signature(&wrapped).is_ok());
    }

    #[test]
    fn public_download_fallback_requires_identical_package_metadata() {
        let internal = test_manifest("/api/v1/client-updates/update-1/download");
        let mut public = test_manifest("installer.exe");
        assert!(same_manifest_package(&internal, &public));
        public.sha256 = "0".repeat(64);
        assert!(!same_manifest_package(&internal, &public));
    }

    #[test]
    fn download_url_is_bound_to_manifest_source_and_internal_path() {
        let internal = Url::parse("http://127.0.0.1:8080/api/v1/client-updates/latest").unwrap();
        let cross_origin = test_manifest("https://updates.example/update.exe");
        assert_eq!(
            resolve_download_url(&internal, &cross_origin, UpdateSource::Internal)
                .unwrap_err()
                .code,
            "update_source_mismatch"
        );

        let wrong_path = test_manifest("/api/v1/files/update-1/download");
        assert_eq!(
            resolve_download_url(&internal, &wrong_path, UpdateSource::Internal)
                .unwrap_err()
                .code,
            "update_download_path_invalid"
        );

        let expected = test_manifest("/api/v1/client-updates/update-1/download");
        assert!(resolve_download_url(&internal, &expected, UpdateSource::Internal).is_ok());
    }

    #[test]
    fn public_fallback_requires_connection_failure() {
        assert!(should_use_public_fallback(true));
        assert!(!should_use_public_fallback(false));
    }

    #[test]
    fn proxy_unavailable_statuses_fallback_but_auth_and_request_errors_do_not() {
        assert!(check_status_unavailable(StatusCode::BAD_GATEWAY));
        assert!(check_status_unavailable(StatusCode::SERVICE_UNAVAILABLE));
        assert!(check_status_unavailable(StatusCode::NOT_FOUND));
        assert!(!check_status_unavailable(StatusCode::BAD_REQUEST));
        assert!(!check_status_unavailable(StatusCode::UNAUTHORIZED));
        assert!(!check_status_unavailable(StatusCode::FORBIDDEN));
    }

    #[tokio::test]
    async fn internal_request_timeout_is_an_unavailable_source() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_millis(250)).await;
        });
        let error = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(format!("http://{address}/latest"))
            .timeout(Duration::from_millis(25))
            .send()
            .await
            .unwrap_err();
        assert!(matches!(
            check_reqwest_error(error),
            CheckFailure::Unavailable(_)
        ));
        server.abort();
    }

    #[tokio::test]
    async fn internal_204_is_success_and_never_uses_public_fallback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let manager = UpdateManager::new(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../test/runtime/rust-tests")
                .join(format!("updater-{}", uuid::Uuid::new_v4())),
            None,
            Some("https://127.0.0.1:1/latest.json"),
        );
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let result = manager
            .check(&client, &format!("http://{address}"), None, "0.1.0")
            .await
            .unwrap();
        assert!(!result.available);
        assert!(!result.configured);
        server.await.unwrap();
    }

    #[test]
    fn missing_or_invalid_public_key_disables_installation() {
        let missing = UpdateManager::new(PathBuf::from("updates"), None, None);
        assert!(!missing.configured());
        let invalid = UpdateManager::new(PathBuf::from("updates"), Some("not-a-key"), None);
        assert!(!invalid.configured());
        let valid = UpdateManager::new(PathBuf::from("updates"), Some(TEST_KEY), None);
        assert!(valid.configured());
    }
}
