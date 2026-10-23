use crate::error::{ErrorKind, Result, TransportError};
use crate::models::{ApiRequestInput, TransportStateView};
use crate::transport::{AppState, build_api_url, parse_api_response};
use futures_util::StreamExt;
use rand::{RngCore, rngs::OsRng};
use reqwest::{Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::http::{self, Method};
use tokio::io::AsyncWriteExt;
use zip::{CompressionMethod, ZipArchive};

const MAX_ZIP_SIZE: u64 = 50 * 1024 * 1024;
const MAX_MANIFEST_SIZE: u64 = 1024 * 1024;
const MAX_FILE_SIZE: u64 = 32 * 1024 * 1024;
const MAX_EXPANDED_SIZE: u64 = 200 * 1024 * 1024;
const MAX_FILES: usize = 2_048;
const MAX_ENTRIES: usize = 4_096;
const MAX_COMPRESSION_RATIO: u64 = 100;
const MAX_PATH_LENGTH: usize = 240;
const MAX_PATH_DEPTH: usize = 16;
const SCREEN_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPrepareInput {
    pub resource_id: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub preview: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPrepareResult {
    pub resource_id: String,
    pub version: String,
    pub entry_html: String,
    pub base_url: String,
    pub cache_hit: bool,
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenReleaseInput {
    pub base_url: String,
}

#[derive(Clone)]
pub struct ScreenManager {
    inner: Arc<ScreenManagerInner>,
}

struct ScreenManagerInner {
    root: PathBuf,
    registry: RwLock<GrantRegistry>,
    prepare_lock: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct GrantRegistry {
    generation: u64,
    grants: HashMap<String, ScreenGrant>,
}

#[derive(Clone)]
struct ScreenGrant {
    window_label: String,
    content_root: PathBuf,
    files: HashMap<String, GrantedFile>,
}

#[derive(Clone)]
struct GrantedFile {
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenVersion {
    screen_id: String,
    version: String,
    entry: String,
    container_api_version: u32,
    #[serde(default)]
    _files: Vec<Value>,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenVersionsPage {
    items: Vec<ScreenVersion>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct ScreenManifest {
    screen_id: String,
    version: String,
    entry: String,
    container_api_version: u32,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ManifestFile {
    path: String,
    size: u64,
    sha256: String,
}

struct VerifiedArchive {
    manifest: ScreenManifest,
    manifest_bytes: Vec<u8>,
}

struct ArchiveEntry {
    index: usize,
    name: String,
    is_dir: bool,
    size: u64,
    compressed_size: u64,
}

struct CentralEntry {
    local_offset: u64,
    method: u16,
    crc32: u32,
    compressed_size: u32,
    uncompressed_size: u32,
    name_raw: Vec<u8>,
}

struct ZipStructure {
    entries: Vec<CentralEntry>,
}

impl ScreenManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            inner: Arc::new(ScreenManagerInner {
                root,
                registry: RwLock::new(GrantRegistry::default()),
                prepare_lock: tokio::sync::Mutex::new(()),
            }),
        }
    }

    pub fn clear(&self) {
        if let Ok(mut registry) = self.inner.registry.write() {
            registry.generation = registry.generation.wrapping_add(1);
            registry.grants.clear();
        }
    }

    pub fn clear_window(&self, window_label: &str) {
        if let Ok(mut registry) = self.inner.registry.write() {
            registry.generation = registry.generation.wrapping_add(1);
            registry
                .grants
                .retain(|_, grant| grant.window_label != window_label);
        }
    }

    pub fn release(&self, window_label: &str, base_url: &str) -> Result<()> {
        let token = token_from_base_url(base_url)?;
        let mut registry = self
            .inner
            .registry
            .write()
            .map_err(|_| cache_error("screen_cache_failed", "无法更新大屏访问授权"))?;
        if registry
            .grants
            .get(&token)
            .is_some_and(|grant| grant.window_label == window_label)
        {
            registry.grants.remove(&token);
        }
        Ok(())
    }

    pub async fn prepare(
        &self,
        state: &AppState,
        window_label: &str,
        request: ScreenPrepareInput,
    ) -> Result<ScreenPrepareResult> {
        validate_resource_id(&request.resource_id)?;
        let generation = self.generation()?;
        let expected = if request.preview {
            let version = request.version.as_deref().ok_or_else(|| {
                invalid_package("screen_version_required", "预览大屏必须指定版本")
            })?;
            validate_stable_semver(version)?;
            authorize_preview(state, &request.resource_id, version).await?
        } else {
            authorize_published(state, &request.resource_id).await?
        };
        validate_server_version(&expected, &request.resource_id)?;

        let state_view = state.state_view().await;
        let instance_id = state_view
            .settings
            .bound_instance_id
            .clone()
            .ok_or_else(|| invalid_package("instance_unbound", "尚未绑定服务实例"))?;
        let expected_session_identity = session_identity(&state_view)?;
        let final_root = self.cache_path(&instance_id, &request.resource_id, &expected);
        let _prepare_guard = self.inner.prepare_lock.lock().await;

        let existing = final_root.clone();
        let expected_existing = expected.clone();
        let verified = tokio::task::spawn_blocking(move || {
            verify_cached_package(&existing, &expected_existing)
        })
        .await
        .map_err(|_| cache_error("screen_cache_failed", "无法校验大屏缓存"))?;

        let (package, cache_hit) = match verified {
            Ok(package) => (package, true),
            Err(_) => {
                let package = self
                    .download_and_commit(state, &request.resource_id, &expected, &final_root)
                    .await?;
                (package, false)
            }
        };

        let content_root = final_root.join("content");
        let entry_path = content_root.join(path_to_native(&package.manifest.entry));
        let entry_bytes = tokio::fs::read(&entry_path)
            .await
            .map_err(|_| cache_error("screen_cache_failed", "无法读取大屏入口文件"))?;
        let entry_html = String::from_utf8(entry_bytes).map_err(|_| {
            invalid_package("screen_entry_invalid", "大屏入口文件必须使用 UTF-8 编码")
        })?;

        let current = if request.preview {
            authorize_preview(state, &request.resource_id, &expected.version).await?
        } else {
            authorize_published(state, &request.resource_id).await?
        };
        validate_server_version(&current, &request.resource_id)?;
        if !same_version(&current, &expected) {
            return Err(invalid_package(
                "screen_version_changed",
                "大屏版本已变化，请重新打开",
            ));
        }
        let current_state = state.state_view().await;
        if current_state.settings.bound_instance_id.as_deref() != Some(instance_id.as_str())
            || session_identity(&current_state)? != expected_session_identity
        {
            return Err(TransportError::new(
                ErrorKind::Auth,
                "screen_session_changed",
                "登录会话或服务实例已变化，请重新打开大屏",
            ));
        }

        let token = random_token();
        let files = package
            .manifest
            .files
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    GrantedFile {
                        size: file.size,
                        sha256: file.sha256.clone(),
                    },
                )
            })
            .collect();
        let grant = ScreenGrant {
            window_label: window_label.to_string(),
            content_root,
            files,
        };
        self.register_grant(generation, token.clone(), grant)?;

        Ok(ScreenPrepareResult {
            resource_id: request.resource_id,
            version: expected.version,
            entry_html,
            base_url: protocol_base_url(&token),
            cache_hit,
            sha256: expected.sha256,
        })
    }

    fn generation(&self) -> Result<u64> {
        self.inner
            .registry
            .read()
            .map(|registry| registry.generation)
            .map_err(|_| cache_error("screen_cache_failed", "无法读取大屏访问授权"))
    }

    fn register_grant(
        &self,
        expected_generation: u64,
        token: String,
        grant: ScreenGrant,
    ) -> Result<()> {
        let mut registry = self
            .inner
            .registry
            .write()
            .map_err(|_| cache_error("screen_cache_failed", "无法创建大屏访问授权"))?;
        if registry.generation != expected_generation {
            return Err(TransportError::new(
                ErrorKind::Auth,
                "screen_session_changed",
                "登录会话、窗口或服务实例已变化，请重新打开大屏",
            ));
        }
        registry.grants.insert(token, grant);
        Ok(())
    }

    fn cache_path(&self, instance_id: &str, resource_id: &str, version: &ScreenVersion) -> PathBuf {
        self.inner
            .root
            .join(hash_identifier(instance_id))
            .join(hash_identifier(resource_id))
            .join(&version.version)
            .join(&version.sha256)
    }

    async fn download_and_commit(
        &self,
        state: &AppState,
        resource_id: &str,
        expected: &ScreenVersion,
        final_root: &Path,
    ) -> Result<VerifiedArchive> {
        let parent = final_root
            .parent()
            .ok_or_else(|| cache_error("screen_cache_failed", "大屏缓存目录无效"))?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| cache_error("screen_cache_failed", "无法创建大屏缓存目录"))?;
        let stage = parent.join(format!(".stage-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&stage)
            .await
            .map_err(|_| cache_error("screen_cache_failed", "无法创建大屏临时目录"))?;
        let package_path = stage.join("package.zip");
        let content_root = stage.join("content");

        let result = async {
            download_package(state, resource_id, expected, &package_path).await?;
            let package_path_for_verify = package_path.clone();
            let content_for_verify = content_root.clone();
            let expected_for_verify = expected.clone();
            let package = tokio::task::spawn_blocking(move || {
                inspect_archive(
                    &package_path_for_verify,
                    Some(&content_for_verify),
                    &expected_for_verify,
                )
            })
            .await
            .map_err(|_| cache_error("screen_cache_failed", "无法校验大屏资源包"))??;
            commit_cache_directory(&stage, final_root)?;
            Ok::<VerifiedArchive, TransportError>(package)
        }
        .await;

        if result.is_err() {
            let _ = tokio::fs::remove_dir_all(&stage).await;
        }
        result
    }

    pub fn protocol_response(
        &self,
        window_label: &str,
        request: http::Request<Vec<u8>>,
    ) -> http::Response<Vec<u8>> {
        if request.method() == Method::OPTIONS {
            return response_with_headers(204, "text/plain; charset=utf-8", Vec::new());
        }
        if request.method() != Method::GET && request.method() != Method::HEAD {
            return response_with_headers(
                405,
                "text/plain; charset=utf-8",
                b"method not allowed".to_vec(),
            );
        }
        let Some((token, path)) = protocol_request_parts(request.uri()) else {
            return response_with_headers(404, "text/plain; charset=utf-8", b"not found".to_vec());
        };
        let grant = match self.inner.registry.read() {
            Ok(registry) => registry.grants.get(token).cloned(),
            Err(_) => None,
        };
        let Some(grant) = grant.filter(|grant| grant.window_label == window_label) else {
            return response_with_headers(404, "text/plain; charset=utf-8", b"not found".to_vec());
        };
        let Some(expected) = grant.files.get(path) else {
            return response_with_headers(404, "text/plain; charset=utf-8", b"not found".to_vec());
        };
        let file_path = grant.content_root.join(path_to_native(path));
        let bytes = match read_granted_file(&grant.content_root, &file_path, expected) {
            Ok(bytes) => bytes,
            Err(_) => {
                return response_with_headers(
                    404,
                    "text/plain; charset=utf-8",
                    b"not found".to_vec(),
                );
            }
        };
        let media_type = mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        if request.method() == Method::HEAD {
            response_with_headers_and_length(200, &media_type, Vec::new(), expected.size)
        } else {
            response_with_headers(200, &media_type, bytes)
        }
    }
}

async fn authorize_published(state: &AppState, resource_id: &str) -> Result<ScreenVersion> {
    let path = format!("/api/v1/resources/{}", encode_path_segment(resource_id));
    let response = state
        .api_request(ApiRequestInput {
            method: "GET".into(),
            path,
            query: BTreeMap::new(),
            headers: BTreeMap::new(),
            body: None,
            timeout_ms: Some(20_000),
            idempotency_key: None,
        })
        .await?;
    let resource = envelope_data(&response.data)?;
    if resource.get("kind").and_then(Value::as_str) != Some("screen") {
        return Err(invalid_package(
            "resource_not_screen",
            "当前资源不是数据大屏",
        ));
    }
    serde_json::from_value(
        resource
            .get("publishedVersion")
            .cloned()
            .ok_or_else(|| invalid_response("服务端未返回已发布的大屏版本"))?,
    )
    .map_err(|_| invalid_response("服务端返回的大屏版本无效"))
}

async fn authorize_preview(
    state: &AppState,
    resource_id: &str,
    requested_version: &str,
) -> Result<ScreenVersion> {
    let path = format!(
        "/api/v1/screens/{}/versions",
        encode_path_segment(resource_id)
    );
    let mut offset = 0usize;
    loop {
        let mut query = BTreeMap::new();
        query.insert("limit".into(), "100".into());
        query.insert("offset".into(), offset.to_string());
        let response = state
            .api_request(ApiRequestInput {
                method: "GET".into(),
                path: path.clone(),
                query,
                headers: BTreeMap::new(),
                body: None,
                timeout_ms: Some(20_000),
                idempotency_key: None,
            })
            .await?;
        let page: ScreenVersionsPage =
            serde_json::from_value(envelope_data(&response.data)?.clone())
                .map_err(|_| invalid_response("服务端返回的大屏版本列表无效"))?;
        let count = page.items.len();
        if let Some(version) = page
            .items
            .into_iter()
            .find(|version| version.version == requested_version)
        {
            return Ok(version);
        }
        if count < 100 {
            return Err(invalid_package(
                "screen_version_not_found",
                "指定的大屏版本不存在或无权预览",
            ));
        }
        offset = offset
            .checked_add(count)
            .ok_or_else(|| invalid_package("screen_version_not_found", "大屏版本列表无效"))?;
        if offset > 100_000 {
            return Err(invalid_response("服务端返回的大屏版本列表过大"));
        }
    }
}

fn envelope_data(value: &Value) -> Result<&Value> {
    if value.get("code").and_then(Value::as_str) != Some("ok") {
        return Err(invalid_response("服务端响应信封无效"));
    }
    value
        .get("data")
        .ok_or_else(|| invalid_response("服务端响应缺少数据"))
}

fn validate_server_version(version: &ScreenVersion, resource_id: &str) -> Result<()> {
    if version.screen_id != resource_id {
        return Err(invalid_response("服务端返回了其他大屏的版本"));
    }
    validate_stable_semver(&version.version)?;
    validate_package_path(&version.entry, false)?;
    if !is_html_path(&version.entry) {
        return Err(invalid_response("服务端返回的大屏入口文件无效"));
    }
    if version.container_api_version != SCREEN_PROTOCOL_VERSION {
        return Err(invalid_package(
            "screen_protocol_unsupported",
            "当前客户端不支持此大屏容器协议版本",
        ));
    }
    validate_sha256(&version.sha256)?;
    if version.size_bytes == 0 || version.size_bytes > MAX_ZIP_SIZE {
        return Err(invalid_package(
            "screen_package_too_large",
            "大屏资源包大小无效或超过 50 MB",
        ));
    }
    Ok(())
}

fn same_version(left: &ScreenVersion, right: &ScreenVersion) -> bool {
    left.screen_id == right.screen_id
        && left.version == right.version
        && left.entry == right.entry
        && left.container_api_version == right.container_api_version
        && left.sha256 == right.sha256
        && left.size_bytes == right.size_bytes
}

fn session_identity(state: &TransportStateView) -> Result<String> {
    if !state.session.authenticated {
        return Err(TransportError::new(
            ErrorKind::Auth,
            "unauthenticated",
            "请先登录",
        ));
    }
    state
        .session
        .user
        .as_ref()
        .and_then(|user| user.get("id"))
        .and_then(|id| match id {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .ok_or_else(|| invalid_response("当前登录用户标识无效"))
}

async fn download_package(
    state: &AppState,
    resource_id: &str,
    expected: &ScreenVersion,
    destination: &Path,
) -> Result<()> {
    let (settings, mut token) = state.settings_and_token().await?;
    let path = format!(
        "/api/v1/screens/{}/versions/{}/download",
        encode_path_segment(resource_id),
        encode_path_segment(&expected.version)
    );
    let url = build_api_url(&settings.server_url, &path, &BTreeMap::new())?;
    let client = state.client().await?;
    let mut response = client
        .get(url.clone())
        .bearer_auth(&token)
        .timeout(Duration::from_secs(15 * 60))
        .send()
        .await
        .map_err(TransportError::from_reqwest)?;
    if response.status() == StatusCode::UNAUTHORIZED {
        let _ = response.bytes().await;
        token = state.refresh_after_unauthorized().await?;
        response = state
            .client()
            .await?
            .get(url)
            .bearer_auth(&token)
            .timeout(Duration::from_secs(15 * 60))
            .send()
            .await
            .map_err(TransportError::from_reqwest)?;
    }
    if !response.status().is_success() {
        return match parse_api_response(response).await {
            Ok(_) => Err(invalid_response("大屏下载响应无效")),
            Err(error) => Err(error),
        };
    }
    validate_download_headers(&response, expected)?;

    let mut output = tokio::fs::File::create(destination)
        .await
        .map_err(|_| cache_error("screen_cache_failed", "无法创建大屏缓存文件"))?;
    let mut stream = response.bytes_stream();
    let mut total = 0u64;
    let mut digest = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(TransportError::from_reqwest)?;
        total = total
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| invalid_package("screen_package_too_large", "大屏资源包过大"))?;
        if total > MAX_ZIP_SIZE || total > expected.size_bytes {
            return Err(invalid_package(
                "screen_package_too_large",
                "大屏资源包超过声明大小",
            ));
        }
        digest.update(&chunk);
        output
            .write_all(&chunk)
            .await
            .map_err(|_| cache_error("screen_cache_failed", "无法写入大屏缓存文件"))?;
    }
    output
        .flush()
        .await
        .map_err(|_| cache_error("screen_cache_failed", "无法提交大屏缓存文件"))?;
    if total != expected.size_bytes || hex::encode(digest.finalize()) != expected.sha256 {
        return Err(invalid_package(
            "screen_package_integrity_failed",
            "大屏资源包摘要或大小校验失败",
        ));
    }
    Ok(())
}

fn validate_download_headers(response: &Response, expected: &ScreenVersion) -> Result<()> {
    if response.content_length() != Some(expected.size_bytes) {
        return Err(invalid_response("大屏下载响应的 Content-Length 无效"));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim();
    if content_type != "application/zip" {
        return Err(invalid_response("大屏下载响应类型不是 application/zip"));
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| invalid_response("大屏下载响应缺少 ETag"))?;
    let etag = etag.trim().trim_matches('"');
    if etag.starts_with("W/") || etag != expected.sha256 {
        return Err(invalid_response("大屏下载响应的 ETag 无效"));
    }
    Ok(())
}

fn verify_cached_package(root: &Path, expected: &ScreenVersion) -> Result<VerifiedArchive> {
    let package = inspect_archive(&root.join("package.zip"), None, expected)?;
    verify_content(&root.join("content"), &package)?;
    Ok(package)
}

fn inspect_archive(
    package_path: &Path,
    output_root: Option<&Path>,
    expected: &ScreenVersion,
) -> Result<VerifiedArchive> {
    let metadata = fs::metadata(package_path)
        .map_err(|_| invalid_package("screen_package_invalid", "大屏资源包不存在"))?;
    if metadata.len() == 0 || metadata.len() > MAX_ZIP_SIZE || metadata.len() != expected.size_bytes
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包大小无效",
        ));
    }
    if hash_file(package_path)? != expected.sha256 {
        return Err(invalid_package(
            "screen_package_integrity_failed",
            "大屏资源包摘要校验失败",
        ));
    }
    let structure = validate_zip_structure(package_path)?;

    let file = File::open(package_path)
        .map_err(|_| invalid_package("screen_package_invalid", "无法读取大屏资源包"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| invalid_package("screen_package_invalid", "大屏资源包不是有效 ZIP"))?;
    if archive.offset() != 0 {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包不能包含自解压前缀",
        ));
    }
    if archive.len() == 0 || archive.len() > MAX_ENTRIES || archive.len() != structure.entries.len()
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包条目数量无效",
        ));
    }

    let mut entries = Vec::with_capacity(archive.len());
    let mut names = HashSet::new();
    let mut file_paths = HashSet::new();
    let mut directory_paths = HashSet::new();
    let mut total_size = 0u64;
    let mut manifest_index = None;
    let mut ordinary_files = 0usize;

    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|_| invalid_package("screen_package_invalid", "无法读取大屏资源包条目"))?;
        let central = structure
            .entries
            .get(index)
            .ok_or_else(|| invalid_package("screen_package_invalid", "ZIP 中央目录条目数量无效"))?;
        if entry.name_raw() != central.name_raw
            || entry.header_start() != central.local_offset
            || entry.crc32() != central.crc32
            || entry.compressed_size() != u64::from(central.compressed_size)
            || entry.size() != u64::from(central.uncompressed_size)
            || compression_method_code(entry.compression()) != Some(central.method)
        {
            return Err(invalid_package(
                "screen_package_invalid",
                "ZIP 解析结果与中央目录不一致",
            ));
        }
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| invalid_package("screen_package_invalid", "ZIP 路径必须使用 UTF-8"))?
            .to_string();
        if entry.encrypted() {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包不能加密",
            ));
        }
        if !matches!(
            entry.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包仅支持 Store 或 Deflate 压缩",
            ));
        }
        let is_dir = entry.is_dir();
        validate_entry_type(entry.unix_mode(), is_dir)?;
        validate_package_path(&name, is_dir)?;
        validate_extra_fields(entry.extra_data())?;
        let normalized = name.trim_end_matches('/').to_ascii_lowercase();
        if !names.insert(normalized.clone()) {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包包含不区分大小写的重复路径",
            ));
        }
        if is_dir {
            if entry.size() != 0 {
                return Err(invalid_package(
                    "screen_package_invalid",
                    "大屏资源包目录条目必须为空",
                ));
            }
            directory_paths.insert(normalized);
        } else {
            ordinary_files += 1;
            file_paths.insert(normalized);
            if entry.size() > MAX_FILE_SIZE {
                return Err(invalid_package(
                    "screen_package_too_large",
                    "大屏资源包内单个文件超过 32 MB",
                ));
            }
            validate_ratio(entry.size(), entry.compressed_size())?;
            total_size = total_size.checked_add(entry.size()).ok_or_else(|| {
                invalid_package("screen_package_too_large", "大屏资源包展开内容过大")
            })?;
            if name == "manifest.json" {
                manifest_index = Some(index);
                if entry.size() > MAX_MANIFEST_SIZE {
                    return Err(invalid_package(
                        "screen_package_invalid",
                        "大屏清单超过 1 MB",
                    ));
                }
            }
        }
        entries.push(ArchiveEntry {
            index,
            name,
            is_dir,
            size: entry.size(),
            compressed_size: entry.compressed_size(),
        });
    }
    if total_size > MAX_EXPANDED_SIZE {
        return Err(invalid_package(
            "screen_package_too_large",
            "大屏资源包展开内容超过 200 MB",
        ));
    }
    validate_ratio(total_size, metadata.len())?;
    validate_path_conflicts(&file_paths, &directory_paths)?;
    validate_entry_path_graph(&entries)?;
    if ordinary_files == 0 || ordinary_files > MAX_FILES + 1 {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包文件数量无效",
        ));
    }
    let manifest_index = manifest_index.ok_or_else(|| {
        invalid_package(
            "screen_package_invalid",
            "大屏资源包根目录缺少 manifest.json",
        )
    })?;

    let mut manifest_file = archive
        .by_index(manifest_index)
        .map_err(|_| invalid_package("screen_package_invalid", "无法读取大屏资源包清单"))?;
    let mut manifest_bytes = Vec::with_capacity(manifest_file.size() as usize);
    manifest_file
        .by_ref()
        .take(MAX_MANIFEST_SIZE + 1)
        .read_to_end(&mut manifest_bytes)
        .map_err(|_| invalid_package("screen_package_invalid", "无法解压大屏资源包清单"))?;
    if manifest_bytes.len() as u64 != manifest_file.size()
        || manifest_bytes.len() as u64 > MAX_MANIFEST_SIZE
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包清单大小无效",
        ));
    }
    drop(manifest_file);
    validate_json_depth(&manifest_bytes)?;
    let manifest: ScreenManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| invalid_package("screen_package_invalid", "大屏资源包清单不是有效 JSON"))?;
    validate_manifest(&manifest, expected, &entries)?;

    let package = VerifiedArchive {
        manifest,
        manifest_bytes,
    };
    verify_archive_payload(&mut archive, output_root, &package, &entries)?;
    if let Some(root) = output_root {
        verify_content(root, &package)?;
    }
    Ok(package)
}

fn validate_manifest(
    manifest: &ScreenManifest,
    expected: &ScreenVersion,
    entries: &[ArchiveEntry],
) -> Result<()> {
    if manifest.screen_id != expected.screen_id
        || manifest.version != expected.version
        || manifest.entry != expected.entry
        || manifest.container_api_version != expected.container_api_version
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包清单与服务端版本信息不一致",
        ));
    }
    validate_stable_semver(&manifest.version)?;
    if manifest.container_api_version != SCREEN_PROTOCOL_VERSION {
        return Err(invalid_package(
            "screen_protocol_unsupported",
            "当前客户端不支持此大屏容器协议版本",
        ));
    }
    if manifest.files.is_empty() || manifest.files.len() > MAX_FILES {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包清单文件数量无效",
        ));
    }
    let archive_files: HashMap<_, _> = entries
        .iter()
        .filter(|entry| !entry.is_dir && entry.name != "manifest.json")
        .map(|entry| (entry.name.as_str(), entry))
        .collect();
    if archive_files.len() != manifest.files.len() {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包清单未完整列举普通文件",
        ));
    }
    let mut listed = HashSet::new();
    for file in &manifest.files {
        validate_package_path(&file.path, false)?;
        if file.path == "manifest.json" || !listed.insert(file.path.to_ascii_lowercase()) {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包清单包含重复或保留路径",
            ));
        }
        validate_sha256(&file.sha256)?;
        let entry = archive_files.get(file.path.as_str()).ok_or_else(|| {
            invalid_package("screen_package_invalid", "大屏资源包清单与 ZIP 内容不一致")
        })?;
        if entry.size != file.size || entry.compressed_size > MAX_ZIP_SIZE {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包清单文件大小不一致",
            ));
        }
    }
    let entry = manifest
        .files
        .iter()
        .find(|file| file.path == manifest.entry)
        .ok_or_else(|| invalid_package("screen_package_invalid", "大屏入口未列入清单"))?;
    if !is_html_path(&entry.path) {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏入口必须是 HTML 文件",
        ));
    }
    Ok(())
}

fn verify_archive_payload(
    archive: &mut ZipArchive<File>,
    output_root: Option<&Path>,
    package: &VerifiedArchive,
    entries: &[ArchiveEntry],
) -> Result<()> {
    if let Some(root) = output_root {
        if root.exists() {
            return Err(cache_error("screen_cache_failed", "大屏临时内容目录已存在"));
        }
        fs::create_dir(root)
            .map_err(|_| cache_error("screen_cache_failed", "无法创建大屏内容目录"))?;
        fs::write(root.join("manifest.json"), &package.manifest_bytes)
            .map_err(|_| cache_error("screen_cache_failed", "无法写入大屏清单"))?;
    }

    for entry in entries.iter().filter(|entry| entry.is_dir) {
        let mut source = archive
            .by_index(entry.index)
            .map_err(|_| invalid_package("screen_package_invalid", "无法读取大屏资源包目录条目"))?;
        let mut byte = [0u8; 1];
        if source
            .read(&mut byte)
            .map_err(|_| invalid_package("screen_package_invalid", "大屏资源包目录条目无效"))?
            != 0
        {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包目录条目必须为空",
            ));
        }
    }

    for expected in &package.manifest.files {
        let index = archive
            .index_for_name(&expected.path)
            .ok_or_else(|| invalid_package("screen_package_invalid", "大屏资源包缺少清单文件"))?;
        let mut source = archive
            .by_index(index)
            .map_err(|_| invalid_package("screen_package_invalid", "无法解压大屏资源包文件"))?;
        let mut output = if let Some(root) = output_root {
            let destination = root.join(path_to_native(&expected.path));
            let parent = destination
                .parent()
                .ok_or_else(|| invalid_package("screen_package_invalid", "大屏资源包路径无效"))?;
            fs::create_dir_all(parent)
                .map_err(|_| cache_error("screen_cache_failed", "无法创建大屏内容子目录"))?;
            Some(
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&destination)
                    .map_err(|_| cache_error("screen_cache_failed", "无法创建大屏内容文件"))?,
            )
        } else {
            None
        };
        let mut digest = Sha256::new();
        let mut size = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|_| invalid_package("screen_package_invalid", "无法解压大屏资源包文件"))?;
            if read == 0 {
                break;
            }
            size = size
                .checked_add(read as u64)
                .ok_or_else(|| invalid_package("screen_package_too_large", "大屏资源包文件过大"))?;
            if size > expected.size || size > MAX_FILE_SIZE {
                return Err(invalid_package(
                    "screen_package_integrity_failed",
                    "大屏资源包文件大小校验失败",
                ));
            }
            digest.update(&buffer[..read]);
            if let Some(output) = output.as_mut() {
                output
                    .write_all(&buffer[..read])
                    .map_err(|_| cache_error("screen_cache_failed", "无法写入大屏内容文件"))?;
            }
        }
        if let Some(output) = output.as_mut() {
            output
                .flush()
                .map_err(|_| cache_error("screen_cache_failed", "无法提交大屏内容文件"))?;
        }
        if size != expected.size || hex::encode(digest.finalize()) != expected.sha256 {
            return Err(invalid_package(
                "screen_package_integrity_failed",
                "大屏资源包文件摘要校验失败",
            ));
        }
    }
    Ok(())
}

fn verify_content(root: &Path, package: &VerifiedArchive) -> Result<()> {
    let manifest_path = root.join("manifest.json");
    if fs::read(&manifest_path).ok().as_deref() != Some(package.manifest_bytes.as_slice()) {
        return Err(invalid_package(
            "screen_cache_invalid",
            "大屏缓存清单已损坏",
        ));
    }
    let mut expected_paths: HashSet<String> = package
        .manifest
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect();
    expected_paths.insert("manifest.json".into());
    let actual_paths = list_content_files(root)?;
    if actual_paths != expected_paths {
        return Err(invalid_package(
            "screen_cache_invalid",
            "大屏缓存包含缺失或多余文件",
        ));
    }
    for expected in &package.manifest.files {
        let path = root.join(path_to_native(&expected.path));
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| invalid_package("screen_cache_invalid", "大屏缓存文件缺失"))?;
        if !metadata.file_type().is_file()
            || metadata.len() != expected.size
            || hash_file(&path)? != expected.sha256
        {
            return Err(invalid_package(
                "screen_cache_invalid",
                "大屏缓存文件校验失败",
            ));
        }
    }
    Ok(())
}

fn list_content_files(root: &Path) -> Result<HashSet<String>> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|_| invalid_package("screen_cache_invalid", "大屏缓存目录不存在"))?;
    if !root_metadata.file_type().is_dir() || root_metadata.file_type().is_symlink() {
        return Err(invalid_package("screen_cache_invalid", "大屏缓存目录无效"));
    }
    let mut result = HashSet::new();
    let mut pending = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((directory, prefix, depth)) = pending.pop() {
        if depth > MAX_PATH_DEPTH {
            return Err(invalid_package(
                "screen_cache_invalid",
                "大屏缓存目录层级过深",
            ));
        }
        for item in fs::read_dir(&directory)
            .map_err(|_| invalid_package("screen_cache_invalid", "无法读取大屏缓存目录"))?
        {
            let item =
                item.map_err(|_| invalid_package("screen_cache_invalid", "无法读取大屏缓存条目"))?;
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| invalid_package("screen_cache_invalid", "大屏缓存路径编码无效"))?;
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let metadata = fs::symlink_metadata(item.path())
                .map_err(|_| invalid_package("screen_cache_invalid", "无法读取大屏缓存条目"))?;
            if metadata.file_type().is_symlink() {
                return Err(invalid_package(
                    "screen_cache_invalid",
                    "大屏缓存不能包含符号链接",
                ));
            }
            if metadata.file_type().is_dir() {
                pending.push((item.path(), relative, depth + 1));
            } else if metadata.file_type().is_file() {
                result.insert(relative);
            } else {
                return Err(invalid_package(
                    "screen_cache_invalid",
                    "大屏缓存包含特殊文件",
                ));
            }
        }
    }
    Ok(result)
}

fn commit_cache_directory(stage: &Path, final_root: &Path) -> Result<()> {
    let replaced = final_root.with_file_name(format!(".replaced-{}", uuid::Uuid::new_v4()));
    let had_existing = final_root.exists();
    if had_existing {
        fs::rename(final_root, &replaced)
            .map_err(|_| cache_error("screen_cache_failed", "无法替换损坏的大屏缓存"))?;
    }
    if let Err(error) = fs::rename(stage, final_root) {
        if had_existing {
            let _ = fs::rename(&replaced, final_root);
        }
        return Err(cache_error(
            "screen_cache_failed",
            format!("无法提交大屏缓存：{error}"),
        ));
    }
    if had_existing {
        let _ = fs::remove_dir_all(replaced);
    }
    Ok(())
}

fn validate_entry_type(mode: Option<u32>, is_dir: bool) -> Result<()> {
    let Some(mode) = mode else {
        return Ok(());
    };
    let kind = mode & 0o170000;
    let valid = if is_dir {
        kind == 0 || kind == 0o040000
    } else {
        kind == 0 || kind == 0o100000
    };
    if !valid {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包不能包含符号链接或特殊文件",
        ));
    }
    Ok(())
}

fn validate_package_path(path: &str, is_dir: bool) -> Result<()> {
    let value = if is_dir {
        path.strip_suffix('/').ok_or_else(|| {
            invalid_package("screen_package_invalid", "ZIP 目录路径必须以斜杠结尾")
        })?
    } else {
        path
    };
    if value.is_empty()
        || value.len() > MAX_PATH_LENGTH
        || value.starts_with('/')
        || value.ends_with('.')
        || value.contains(['\\', '\0'])
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包包含不安全路径",
        ));
    }
    let segments: Vec<_> = value.split('/').collect();
    if segments.len() > MAX_PATH_DEPTH
        || segments
            .iter()
            .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
        || segments
            .iter()
            .any(|segment| segment.ends_with('.') || is_windows_reserved_name(segment))
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包包含不安全路径",
        ));
    }
    Ok(())
}

fn is_windows_reserved_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
}

fn validate_path_conflicts(files: &HashSet<String>, explicit_dirs: &HashSet<String>) -> Result<()> {
    for file in files {
        if explicit_dirs.contains(file) {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包包含文件与目录冲突",
            ));
        }
        let mut prefix = String::new();
        let segments: Vec<_> = file.split('/').collect();
        for segment in segments.iter().take(segments.len().saturating_sub(1)) {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(segment);
            if files.contains(&prefix) {
                return Err(invalid_package(
                    "screen_package_invalid",
                    "大屏资源包包含文件与目录冲突",
                ));
            }
        }
    }
    for directory in explicit_dirs {
        if files.contains(directory) {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包包含文件与目录冲突",
            ));
        }
    }
    Ok(())
}

fn validate_entry_path_graph(entries: &[ArchiveEntry]) -> Result<()> {
    let mut nodes: HashMap<String, (bool, String)> = HashMap::new();
    for entry in entries {
        let normalized = entry.name.trim_end_matches('/');
        let parts: Vec<_> = normalized.split('/').collect();
        for index in 1..parts.len() {
            let spelling = parts[..index].join("/");
            let key = spelling.to_ascii_lowercase();
            if let Some((directory, existing)) = nodes.get(&key) {
                if !directory {
                    return Err(invalid_package(
                        "screen_package_invalid",
                        "大屏资源包包含文件与目录路径冲突",
                    ));
                }
                if existing != &spelling {
                    return Err(invalid_package(
                        "screen_package_invalid",
                        "大屏资源包目录路径存在不区分大小写的冲突",
                    ));
                }
            } else {
                nodes.insert(key, (true, spelling));
            }
        }

        let key = normalized.to_ascii_lowercase();
        if let Some((directory, existing)) = nodes.get(&key) {
            if !entry.is_dir || !directory {
                return Err(invalid_package(
                    "screen_package_invalid",
                    "大屏资源包包含文件与目录路径冲突",
                ));
            }
            if existing != normalized {
                return Err(invalid_package(
                    "screen_package_invalid",
                    "大屏资源包目录路径存在不区分大小写的冲突",
                ));
            }
        } else {
            nodes.insert(key, (entry.is_dir, normalized.to_string()));
        }
    }
    Ok(())
}

fn validate_ratio(size: u64, compressed_size: u64) -> Result<()> {
    if size > 0
        && (compressed_size == 0 || size > compressed_size.saturating_mul(MAX_COMPRESSION_RATIO))
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包压缩比超过 100",
        ));
    }
    Ok(())
}

fn validate_extra_fields(extra: Option<&[u8]>) -> Result<()> {
    let Some(mut bytes) = extra else {
        return Ok(());
    };
    while !bytes.is_empty() {
        if bytes.len() < 4 {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包扩展字段无效",
            ));
        }
        let tag = u16::from_le_bytes([bytes[0], bytes[1]]);
        let length = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
        bytes = &bytes[4..];
        if length > bytes.len() {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包扩展字段无效",
            ));
        }
        match tag {
            0x0001 => {
                return Err(invalid_package(
                    "screen_package_invalid",
                    "大屏资源包不能使用 ZIP64",
                ));
            }
            0x7075 => {
                return Err(invalid_package(
                    "screen_package_invalid",
                    "ZIP 路径不能使用 Unicode 替代字段",
                ));
            }
            0x9901 => {
                return Err(invalid_package(
                    "screen_package_invalid",
                    "大屏资源包不能加密",
                ));
            }
            _ => {}
        }
        bytes = &bytes[length..];
    }
    Ok(())
}

fn validate_zip_structure(package_path: &Path) -> Result<ZipStructure> {
    let bytes = fs::read(package_path)
        .map_err(|_| invalid_package("screen_package_invalid", "无法读取大屏资源包"))?;
    if bytes.len() < 22 || bytes.get(..4) != Some(b"PK\x03\x04") {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 必须从本地文件头开始",
        ));
    }

    let tail_start = bytes.len().saturating_sub(22 + 65_535 + 20);
    let mut eocd = None;
    for index in (tail_start..=bytes.len() - 22).rev() {
        if bytes.get(index..index + 4) == Some(b"PK\x05\x06") {
            let comment_length = read_u16(&bytes, index + 20) as usize;
            if index
                .checked_add(22)
                .and_then(|end| end.checked_add(comment_length))
                == Some(bytes.len())
            {
                eocd = Some(index);
                break;
            }
        }
    }
    let eocd = eocd.ok_or_else(|| {
        invalid_package("screen_package_invalid", "ZIP 缺少有效的中央目录结束记录")
    })?;
    if eocd >= 20 && bytes.get(eocd - 20..eocd - 16) == Some(b"PK\x06\x07") {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包不能使用 ZIP64",
        ));
    }

    let disk = read_u16(&bytes, eocd + 4);
    let central_disk = read_u16(&bytes, eocd + 6);
    let disk_entries = read_u16(&bytes, eocd + 8);
    let total_entries = read_u16(&bytes, eocd + 10);
    let central_size = read_u32(&bytes, eocd + 12);
    let central_offset = read_u32(&bytes, eocd + 16);
    if disk == u16::MAX
        || central_disk == u16::MAX
        || disk_entries == u16::MAX
        || total_entries == u16::MAX
        || central_size == u32::MAX
        || central_offset == u32::MAX
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包不能使用 ZIP64",
        ));
    }
    if disk != 0 || central_disk != 0 || disk_entries != total_entries {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包不能使用多卷 ZIP",
        ));
    }
    if total_entries == 0 || total_entries as usize > MAX_ENTRIES {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包条目数量无效",
        ));
    }

    let central_offset = central_offset as usize;
    let central_end = central_offset
        .checked_add(central_size as usize)
        .ok_or_else(|| invalid_package("screen_package_invalid", "ZIP 中央目录边界无效"))?;
    if central_end != eocd || central_end > bytes.len() {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 中央目录边界无效",
        ));
    }
    validate_zip_directory(&bytes, central_offset, central_end, total_entries as usize)
}

fn validate_zip_directory(
    bytes: &[u8],
    central_offset: usize,
    central_end: usize,
    declared_entries: usize,
) -> Result<ZipStructure> {
    const CENTRAL_HEADER_SIZE: usize = 46;
    let mut cursor = central_offset;
    let mut entries = Vec::with_capacity(declared_entries);
    let mut local_ranges = Vec::with_capacity(declared_entries);
    while cursor < central_end {
        if entries.len() >= declared_entries
            || central_end.saturating_sub(cursor) < CENTRAL_HEADER_SIZE
            || bytes.get(cursor..cursor + 4) != Some(b"PK\x01\x02")
        {
            return Err(invalid_package(
                "screen_package_invalid",
                "ZIP 中央目录条目数量或边界无效",
            ));
        }
        let flags = read_u16(bytes, cursor + 8);
        let method = read_u16(bytes, cursor + 10);
        let crc32 = read_u32(bytes, cursor + 16);
        let compressed_size = read_u32(bytes, cursor + 20);
        let uncompressed_size = read_u32(bytes, cursor + 24);
        let name_length = read_u16(bytes, cursor + 28) as usize;
        let extra_length = read_u16(bytes, cursor + 30) as usize;
        let comment_length = read_u16(bytes, cursor + 32) as usize;
        let disk = read_u16(bytes, cursor + 34);
        let local_offset = read_u32(bytes, cursor + 42);
        if disk != 0 {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包不能使用多卷 ZIP",
            ));
        }
        if compressed_size == u32::MAX || uncompressed_size == u32::MAX || local_offset == u32::MAX
        {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包不能使用 ZIP64",
            ));
        }
        if flags & ((1 << 0) | (1 << 6) | (1 << 13)) != 0 {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包不能加密",
            ));
        }
        if !matches!(method, 0 | 8) {
            return Err(invalid_package(
                "screen_package_invalid",
                "大屏资源包仅支持 Store 或 Deflate 压缩",
            ));
        }
        if name_length == 0 || name_length > MAX_PATH_LENGTH {
            return Err(invalid_package(
                "screen_package_invalid",
                "ZIP 路径长度无效或超过限制",
            ));
        }
        let next = cursor
            .checked_add(CENTRAL_HEADER_SIZE)
            .and_then(|value| value.checked_add(name_length))
            .and_then(|value| value.checked_add(extra_length))
            .and_then(|value| value.checked_add(comment_length))
            .ok_or_else(|| invalid_package("screen_package_invalid", "ZIP 中央目录条目边界无效"))?;
        if next > central_end {
            return Err(invalid_package(
                "screen_package_invalid",
                "ZIP 中央目录条目边界无效",
            ));
        }
        let name_start = cursor + CENTRAL_HEADER_SIZE;
        let name_end = name_start + name_length;
        let extra_end = name_end + extra_length;
        let name_raw = bytes[name_start..name_end].to_vec();
        validate_extra_fields(Some(&bytes[name_end..extra_end]))?;
        let local_end = validate_zip_local_header(
            bytes,
            local_offset as usize,
            central_offset,
            &name_raw,
            flags,
            method,
            crc32,
            compressed_size,
            uncompressed_size,
        )?;
        local_ranges.push((local_offset as usize, local_end));
        entries.push(CentralEntry {
            local_offset: u64::from(local_offset),
            method,
            crc32,
            compressed_size,
            uncompressed_size,
            name_raw,
        });
        cursor = next;
    }
    if cursor != central_end || entries.len() != declared_entries {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 中央目录条目数量或边界无效",
        ));
    }
    local_ranges.sort_unstable_by_key(|range| range.0);
    if local_ranges
        .windows(2)
        .any(|ranges| ranges[1].0 < ranges[0].1)
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 本地文件条目范围重叠",
        ));
    }
    Ok(ZipStructure { entries })
}

#[allow(clippy::too_many_arguments)]
fn validate_zip_local_header(
    bytes: &[u8],
    offset: usize,
    central_offset: usize,
    central_name: &[u8],
    central_flags: u16,
    central_method: u16,
    central_crc: u32,
    central_compressed_size: u32,
    central_uncompressed_size: u32,
) -> Result<usize> {
    const LOCAL_HEADER_SIZE: usize = 30;
    let header_end = offset
        .checked_add(LOCAL_HEADER_SIZE)
        .ok_or_else(|| invalid_package("screen_package_invalid", "ZIP 本地文件头边界无效"))?;
    if header_end > central_offset || bytes.get(offset..offset + 4) != Some(b"PK\x03\x04") {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 本地文件头边界或签名无效",
        ));
    }
    let flags = read_u16(bytes, offset + 6);
    let method = read_u16(bytes, offset + 8);
    let crc = read_u32(bytes, offset + 14);
    let compressed_size = read_u32(bytes, offset + 18);
    let uncompressed_size = read_u32(bytes, offset + 22);
    let name_length = read_u16(bytes, offset + 26) as usize;
    let extra_length = read_u16(bytes, offset + 28) as usize;
    if flags != central_flags || method != central_method {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 本地文件头与中央目录不一致",
        ));
    }
    if name_length != central_name.len() {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 本地文件名与中央目录不一致",
        ));
    }
    if compressed_size == u32::MAX || uncompressed_size == u32::MAX {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包不能使用 ZIP64",
        ));
    }
    let name_start = header_end;
    let name_end = name_start
        .checked_add(name_length)
        .ok_or_else(|| invalid_package("screen_package_invalid", "ZIP 本地文件名边界无效"))?;
    let body_offset = name_end
        .checked_add(extra_length)
        .ok_or_else(|| invalid_package("screen_package_invalid", "ZIP 本地扩展字段边界无效"))?;
    let data_end = body_offset
        .checked_add(central_compressed_size as usize)
        .ok_or_else(|| invalid_package("screen_package_invalid", "ZIP 本地文件数据边界无效"))?;
    if data_end > central_offset || bytes.get(name_start..name_end) != Some(central_name) {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 本地文件名或数据边界与中央目录不一致",
        ));
    }
    validate_extra_fields(bytes.get(name_end..body_offset))?;
    if flags & (1 << 3) == 0 {
        if crc != central_crc
            || compressed_size != central_compressed_size
            || uncompressed_size != central_uncompressed_size
        {
            return Err(invalid_package(
                "screen_package_invalid",
                "ZIP 本地文件头大小或 CRC 与中央目录不一致",
            ));
        }
        return Ok(data_end);
    }
    if (crc != 0 && crc != central_crc)
        || (compressed_size != 0 && compressed_size != central_compressed_size)
        || (uncompressed_size != 0 && uncompressed_size != central_uncompressed_size)
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 本地文件头大小或 CRC 与中央目录不一致",
        ));
    }

    let descriptor_end = data_end
        .checked_add(12)
        .ok_or_else(|| invalid_package("screen_package_invalid", "ZIP 数据描述符边界无效"))?;
    if descriptor_end > central_offset {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 数据描述符边界无效",
        ));
    }
    let (values_offset, entry_end) = if read_u32(bytes, data_end) == 0x0807_4b50 {
        let end = data_end
            .checked_add(16)
            .ok_or_else(|| invalid_package("screen_package_invalid", "ZIP 数据描述符边界无效"))?;
        if end > central_offset {
            return Err(invalid_package(
                "screen_package_invalid",
                "ZIP 数据描述符边界无效",
            ));
        }
        (data_end + 4, end)
    } else {
        (data_end, descriptor_end)
    };
    if read_u32(bytes, values_offset) != central_crc
        || read_u32(bytes, values_offset + 4) != central_compressed_size
        || read_u32(bytes, values_offset + 8) != central_uncompressed_size
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "ZIP 数据描述符与中央目录不一致",
        ));
    }
    Ok(entry_end)
}

fn compression_method_code(method: CompressionMethod) -> Option<u16> {
    match method {
        CompressionMethod::Stored => Some(0),
        CompressionMethod::Deflated => Some(8),
        _ => None,
    }
}

fn validate_json_depth(bytes: &[u8]) -> Result<()> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for byte in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match *byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > MAX_PATH_DEPTH {
                    return Err(invalid_package(
                        "screen_package_invalid",
                        "大屏资源包清单 JSON 嵌套深度超过限制",
                    ));
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn validate_stable_semver(value: &str) -> Result<()> {
    let parts: Vec<_> = value.split('.').collect();
    let valid = parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == &"0" || !part.starts_with('0'))
                && part.parse::<u64>().is_ok()
        });
    if !valid {
        return Err(invalid_package(
            "screen_version_invalid",
            "大屏版本必须是稳定 SemVer x.y.z",
        ));
    }
    Ok(())
}

fn validate_resource_id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.contains(['\r', '\n', '\0']) {
        return Err(invalid_package("invalid_resource_id", "大屏资源标识无效"));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(invalid_package(
            "screen_package_invalid",
            "大屏资源包摘要格式无效",
        ));
    }
    Ok(())
}

fn is_html_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)
        .map_err(|_| invalid_package("screen_cache_invalid", "无法读取大屏缓存文件"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| invalid_package("screen_cache_invalid", "无法读取大屏缓存文件"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn read_granted_file(root: &Path, path: &Path, expected: &GrantedFile) -> Result<Vec<u8>> {
    let root = fs::canonicalize(root)
        .map_err(|_| invalid_package("screen_cache_invalid", "大屏缓存目录无效"))?;
    let canonical = fs::canonicalize(path)
        .map_err(|_| invalid_package("screen_cache_invalid", "大屏缓存文件不存在"))?;
    if !canonical.starts_with(&root) {
        return Err(invalid_package("screen_cache_invalid", "大屏缓存路径越界"));
    }
    let metadata = fs::symlink_metadata(&canonical)
        .map_err(|_| invalid_package("screen_cache_invalid", "大屏缓存文件不存在"))?;
    if !metadata.file_type().is_file() || metadata.len() != expected.size {
        return Err(invalid_package(
            "screen_cache_invalid",
            "大屏缓存文件大小无效",
        ));
    }
    let bytes = fs::read(canonical)
        .map_err(|_| invalid_package("screen_cache_invalid", "无法读取大屏缓存文件"))?;
    if bytes.len() as u64 != expected.size || hex::encode(Sha256::digest(&bytes)) != expected.sha256
    {
        return Err(invalid_package(
            "screen_cache_invalid",
            "大屏缓存文件摘要无效",
        ));
    }
    Ok(bytes)
}

fn protocol_request_parts(uri: &http::Uri) -> Option<(&str, &str)> {
    if uri.query().is_some() {
        return None;
    }
    let path = uri.path().strip_prefix('/')?;
    let (token, file_path) = path.split_once('/')?;
    if token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        || validate_package_path(file_path, false).is_err()
    {
        return None;
    }
    Some((token, file_path))
}

fn token_from_base_url(value: &str) -> Result<String> {
    let expected_prefix = if cfg!(any(windows, target_os = "android")) {
        "http://rd-screen.localhost/"
    } else {
        "rd-screen://localhost/"
    };
    let token = value
        .strip_prefix(expected_prefix)
        .and_then(|value| value.strip_suffix('/'))
        .ok_or_else(|| invalid_package("invalid_screen_base_url", "大屏访问地址无效"))?;
    if token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(invalid_package(
            "invalid_screen_base_url",
            "大屏访问地址无效",
        ));
    }
    Ok(token.to_string())
}

fn response_with_headers(status: u16, media_type: &str, body: Vec<u8>) -> http::Response<Vec<u8>> {
    let length = body.len() as u64;
    response_with_headers_and_length(status, media_type, body, length)
}

fn response_with_headers_and_length(
    status: u16,
    media_type: &str,
    body: Vec<u8>,
    length: u64,
) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, media_type)
        .header(http::header::CONTENT_LENGTH, length.to_string())
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header(http::header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| http::Response::new(Vec::new()))
}

fn protocol_base_url(token: &str) -> String {
    if cfg!(any(windows, target_os = "android")) {
        format!("http://rd-screen.localhost/{token}/")
    } else {
        format!("rd-screen://localhost/{token}/")
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn hash_identifier(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn path_to_native(value: &str) -> PathBuf {
    value.split('/').collect()
}

fn encode_path_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn invalid_response(message: impl Into<String>) -> TransportError {
    TransportError::new(ErrorKind::Server, "invalid_screen_response", message)
}

fn invalid_package(code: impl Into<String>, message: impl Into<String>) -> TransportError {
    TransportError::new(ErrorKind::Validation, code, message)
}

fn cache_error(code: impl Into<String>, message: impl Into<String>) -> TransportError {
    TransportError::new(ErrorKind::Storage, code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn runtime_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("test/runtime/screen-rust")
            .join(uuid::Uuid::new_v4().to_string())
    }

    fn write_package(root: &Path, declared_hash: Option<String>) -> (PathBuf, ScreenVersion) {
        fs::create_dir_all(root).unwrap();
        let html = b"<!doctype html><script type=\"module\" src=\"./assets/app.js\"></script>";
        let script = b"document.body.textContent = 'screen';";
        let html_hash = hex::encode(Sha256::digest(html));
        let script_hash = hex::encode(Sha256::digest(script));
        let manifest = ScreenManifest {
            screen_id: "screen-a".into(),
            version: "1.2.3".into(),
            entry: "index.html".into(),
            container_api_version: 1,
            files: vec![
                ManifestFile {
                    path: "index.html".into(),
                    size: html.len() as u64,
                    sha256: declared_hash.unwrap_or(html_hash),
                },
                ManifestFile {
                    path: "assets/app.js".into(),
                    size: script.len() as u64,
                    sha256: script_hash,
                },
            ],
        };
        let package_path = root.join("package.zip");
        let file = File::create(&package_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file("manifest.json", options).unwrap();
        writer
            .write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        writer.start_file("index.html", options).unwrap();
        writer.write_all(html).unwrap();
        writer.start_file("assets/app.js", options).unwrap();
        writer.write_all(script).unwrap();
        writer.finish().unwrap();
        let version = ScreenVersion {
            screen_id: "screen-a".into(),
            version: "1.2.3".into(),
            entry: "index.html".into(),
            container_api_version: 1,
            _files: Vec::new(),
            sha256: hash_file(&package_path).unwrap(),
            size_bytes: fs::metadata(&package_path).unwrap().len(),
        };
        (package_path, version)
    }

    #[test]
    fn strict_paths_reject_traversal_reserved_names_and_case_conflicts() {
        assert!(validate_package_path("assets/app.js", false).is_ok());
        assert!(validate_package_path("../app.js", false).is_err());
        assert!(validate_package_path("assets//app.js", false).is_err());
        assert!(validate_package_path("assets\\app.js", false).is_err());
        assert!(validate_package_path("CON.txt", false).is_err());

        let files = HashSet::from(["assets".to_string(), "assets/app.js".to_string()]);
        assert!(validate_path_conflicts(&files, &HashSet::new()).is_err());

        let entries = vec![
            ArchiveEntry {
                index: 0,
                name: "Assets/app.js".into(),
                is_dir: false,
                size: 1,
                compressed_size: 1,
            },
            ArchiveEntry {
                index: 1,
                name: "assets/theme.css".into(),
                is_dir: false,
                size: 1,
                compressed_size: 1,
            },
        ];
        assert!(validate_entry_path_graph(&entries).is_err());
    }

    #[test]
    fn zip_structure_rejects_prefix_header_mismatch_and_unsafe_extra_fields() {
        let root = runtime_dir();
        let (package_path, _) = write_package(&root, None);
        let original = fs::read(&package_path).unwrap();

        let mut prefixed = b"untrusted-prefix".to_vec();
        prefixed.extend_from_slice(&original);
        fs::write(&package_path, prefixed).unwrap();
        assert!(validate_zip_structure(&package_path).is_err());

        let mut mismatched = original;
        mismatched[8] = 8;
        mismatched[9] = 0;
        fs::write(&package_path, mismatched).unwrap();
        assert!(validate_zip_structure(&package_path).is_err());

        assert!(validate_extra_fields(Some(&[0x01, 0x00, 0x00, 0x00])).is_err());
        assert!(validate_extra_fields(Some(&[0x75, 0x70, 0x00, 0x00])).is_err());
        assert!(validate_extra_fields(Some(&[0x01, 0x99, 0x00, 0x00])).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_shape_and_json_depth_are_strict() {
        let unknown = br#"{
            "screenId":"screen-a",
            "version":"1.2.3",
            "entry":"index.html",
            "containerApiVersion":1,
            "files":[],
            "unexpected":true
        }"#;
        assert!(serde_json::from_slice::<ScreenManifest>(unknown).is_err());

        let deep = format!("{}0{}", "[".repeat(17), "]".repeat(17));
        assert!(validate_json_depth(deep.as_bytes()).is_err());
        let allowed = format!("{}0{}", "[".repeat(16), "]".repeat(16));
        assert!(validate_json_depth(allowed.as_bytes()).is_ok());
    }

    #[test]
    fn stable_versions_and_tokens_are_strict() {
        assert!(validate_stable_semver("1.0.0").is_ok());
        assert!(validate_stable_semver("01.0.0").is_err());
        assert!(validate_stable_semver("1.0.0-beta").is_err());
        let token = "a".repeat(64);
        let base = protocol_base_url(&token);
        assert_eq!(token_from_base_url(&base).unwrap(), token);
        assert!(token_from_base_url(&(base + "extra/")).is_err());
    }

    #[test]
    fn protocol_request_requires_authorized_shape() {
        let token = "b".repeat(64);
        let uri: http::Uri = format!("http://rd-screen.localhost/{token}/assets/app.js")
            .parse()
            .unwrap();
        assert_eq!(
            protocol_request_parts(&uri),
            Some((token.as_str(), "assets/app.js"))
        );
        let query: http::Uri = format!("http://rd-screen.localhost/{token}/assets/app.js?v=1")
            .parse()
            .unwrap();
        assert!(protocol_request_parts(&query).is_none());
    }

    #[test]
    fn clearing_grants_invalidates_in_flight_prepare_generation() {
        let manager = ScreenManager::new(runtime_dir());
        let generation = manager.generation().unwrap();
        manager.clear();
        let error = manager
            .register_grant(
                generation,
                "a".repeat(64),
                ScreenGrant {
                    window_label: "main".into(),
                    content_root: PathBuf::new(),
                    files: HashMap::new(),
                },
            )
            .err()
            .unwrap();
        assert_eq!(error.code, "screen_session_changed");
    }

    #[test]
    fn valid_archive_is_verified_extracted_and_rechecked_from_cache() {
        let root = runtime_dir();
        let (package_path, version) = write_package(&root, None);
        let content = root.join("content");
        let verified = inspect_archive(&package_path, Some(&content), &version).unwrap();
        assert_eq!(verified.manifest.entry, "index.html");
        assert!(
            fs::read_to_string(content.join("index.html"))
                .unwrap()
                .contains("assets/app.js")
        );
        let cache_root = root.join("cache");
        fs::create_dir(&cache_root).unwrap();
        fs::rename(package_path, cache_root.join("package.zip")).unwrap();
        fs::rename(content, cache_root.join("content")).unwrap();
        assert!(verify_cached_package(&cache_root, &version).is_ok());
        fs::write(cache_root.join("content/assets/app.js"), b"tampered").unwrap();
        assert!(verify_cached_package(&cache_root, &version).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_file_hash_mismatch_is_rejected() {
        let root = runtime_dir();
        let (package_path, version) = write_package(&root, Some("0".repeat(64)));
        let error = inspect_archive(&package_path, Some(&root.join("content")), &version)
            .err()
            .unwrap();
        assert_eq!(error.code, "screen_package_integrity_failed");
        fs::remove_dir_all(root).unwrap();
    }
}
