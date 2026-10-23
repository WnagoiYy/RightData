use crate::error::{ErrorKind, Result, TransportError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const QUEUE_VERSION: u8 = 1;
const QUEUE_FILE: &str = "client-events.json";
const MAX_QUEUED_EVENTS: usize = 2_048;
const MAX_READY_EVENTS: usize = 100;
const INITIAL_RETRY_MS: u64 = 2_000;
const MAX_RETRY_MS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientEventBinding {
    instance_id: String,
    user_id: String,
}

impl ClientEventBinding {
    pub fn new(instance_id: impl Into<String>, user_id: impl Into<String>) -> Result<Self> {
        let instance_id = instance_id.into();
        let user_id = user_id.into();
        validate_identifier(&instance_id, 128, "服务实例标识")?;
        validate_identifier(&user_id, 128, "用户标识")?;
        Ok(Self {
            instance_id,
            user_id,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientEventOutcome {
    Success,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingClientEvent {
    pub event_id: String,
    pub occurred_at: String,
    pub instance_id: String,
    pub category: String,
    pub action: String,
    pub target_id: String,
    pub outcome: ClientEventOutcome,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueFile {
    version: u8,
    entries: Vec<QueuedClientEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuedClientEvent {
    event_id: String,
    occurred_at: String,
    category: String,
    action: String,
    target_id: String,
    outcome: ClientEventOutcome,
    instance_id: String,
    user_id: String,
    attempts: u32,
    next_attempt_at_ms: u64,
    #[serde(default)]
    rejection: Option<ClientEventRejection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientEventRejection {
    rejected_at_ms: u64,
    reason: String,
}

impl QueuedClientEvent {
    fn matches(&self, binding: &ClientEventBinding) -> bool {
        self.instance_id == binding.instance_id && self.user_id == binding.user_id
    }

    fn outbound(&self) -> PendingClientEvent {
        PendingClientEvent {
            event_id: self.event_id.clone(),
            occurred_at: self.occurred_at.clone(),
            instance_id: self.instance_id.clone(),
            category: self.category.clone(),
            action: self.action.clone(),
            target_id: self.target_id.clone(),
            outcome: self.outcome,
        }
    }
}

pub struct ClientEventQueue {
    path: PathBuf,
    state: Mutex<ClientEventQueueState>,
}

struct ClientEventQueueState {
    entries: Vec<QueuedClientEvent>,
    initialization_error: Option<TransportError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientEventQueueDiagnostics {
    pub disabled: bool,
    pub pending: usize,
    pub rejected: usize,
    pub initialization_error: Option<String>,
    pub last_rejection: Option<ClientEventRejectionDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientEventRejectionDiagnostic {
    pub event_id: String,
    pub target_id: String,
    pub rejected_at_ms: u64,
    pub reason: String,
}

impl ClientEventQueue {
    pub fn open(root: PathBuf) -> Result<Self> {
        let path = root.join(QUEUE_FILE);
        let loaded = fs::create_dir_all(&root)
            .map_err(|_| TransportError::storage("无法创建客户端事件目录"))
            .and_then(|_| load_queue(&path));
        let (entries, initialization_error) = match loaded {
            Ok(entries) => (entries, None),
            Err(error) => (
                Vec::new(),
                Some(queue_unavailable(format!(
                    "客户端事件队列不可用：{}",
                    error.message
                ))),
            ),
        };
        Ok(Self {
            path,
            state: Mutex::new(ClientEventQueueState {
                entries,
                initialization_error,
            }),
        })
    }

    pub fn initialization_error(&self) -> Option<TransportError> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.initialization_error.clone())
    }

    pub fn diagnostics(&self) -> Result<ClientEventQueueDiagnostics> {
        let state = self
            .state
            .lock()
            .map_err(|_| queue_unavailable("无法读取客户端事件队列诊断"))?;
        let last_rejection = state
            .entries
            .iter()
            .filter_map(|entry| {
                entry
                    .rejection
                    .as_ref()
                    .map(|rejection| ClientEventRejectionDiagnostic {
                        event_id: entry.event_id.clone(),
                        target_id: entry.target_id.clone(),
                        rejected_at_ms: rejection.rejected_at_ms,
                        reason: rejection.reason.clone(),
                    })
            })
            .max_by_key(|rejection| rejection.rejected_at_ms);
        Ok(ClientEventQueueDiagnostics {
            disabled: state.initialization_error.is_some(),
            pending: state
                .entries
                .iter()
                .filter(|entry| entry.rejection.is_none())
                .count(),
            rejected: state
                .entries
                .iter()
                .filter(|entry| entry.rejection.is_some())
                .count(),
            initialization_error: state
                .initialization_error
                .as_ref()
                .map(|error| error.message.clone()),
            last_rejection,
        })
    }

    pub fn enqueue_export(
        &self,
        binding: &ClientEventBinding,
        target_id: &str,
        outcome: ClientEventOutcome,
    ) -> Result<PendingClientEvent> {
        validate_identifier(target_id, 100, "导出任务标识")?;
        let now_ms = unix_time_ms();
        let entry = QueuedClientEvent {
            event_id: uuid::Uuid::new_v4().to_string(),
            occurred_at: rfc3339_now()?,
            category: "client_export".to_string(),
            action: "file_generation".to_string(),
            target_id: target_id.to_string(),
            outcome,
            instance_id: binding.instance_id.clone(),
            user_id: binding.user_id.clone(),
            attempts: 0,
            next_attempt_at_ms: now_ms,
            rejection: None,
        };
        let outbound = entry.outbound();
        self.update(|entries| {
            if entries.len() >= MAX_QUEUED_EVENTS {
                return Err(TransportError::new(
                    ErrorKind::Storage,
                    "client_event_queue_full",
                    "客户端事件队列已满，请联网同步后重试",
                ));
            }
            entries.push(entry);
            Ok(())
        })?;
        Ok(outbound)
    }

    pub fn ready(
        &self,
        binding: &ClientEventBinding,
        now_ms: u64,
        limit: usize,
    ) -> Result<Vec<PendingClientEvent>> {
        let state = self
            .state
            .lock()
            .map_err(|_| TransportError::storage("无法读取客户端事件队列"))?;
        if let Some(error) = &state.initialization_error {
            return Err(error.clone());
        }
        Ok(state
            .entries
            .iter()
            .filter(|entry| {
                entry.rejection.is_none()
                    && entry.matches(binding)
                    && entry.next_attempt_at_ms <= now_ms
            })
            .take(limit.clamp(1, MAX_READY_EVENTS))
            .map(QueuedClientEvent::outbound)
            .collect())
    }

    pub fn acknowledge(&self, event_id: &str) -> Result<bool> {
        self.remove(event_id)
    }

    pub fn reject_permanent(&self, event_id: &str, reason: &str, now_ms: u64) -> Result<bool> {
        let reason = normalize_rejection_reason(reason);
        self.update(|entries| {
            let Some(entry) = entries.iter_mut().find(|entry| entry.event_id == event_id) else {
                return Ok(false);
            };
            if entry.rejection.is_some() {
                return Ok(false);
            }
            entry.rejection = Some(ClientEventRejection {
                rejected_at_ms: now_ms,
                reason,
            });
            Ok(true)
        })
    }

    pub fn mark_retry(&self, event_id: &str, now_ms: u64) -> Result<bool> {
        self.update(|entries| {
            let Some(entry) = entries.iter_mut().find(|entry| entry.event_id == event_id) else {
                return Ok(false);
            };
            if entry.rejection.is_some() {
                return Ok(false);
            }
            entry.attempts = entry.attempts.saturating_add(1);
            let exponent = entry.attempts.saturating_sub(1).min(31);
            let delay = INITIAL_RETRY_MS
                .saturating_mul(1_u64 << exponent)
                .min(MAX_RETRY_MS);
            entry.next_attempt_at_ms = now_ms.saturating_add(delay);
            Ok(true)
        })
    }

    fn remove(&self, event_id: &str) -> Result<bool> {
        self.update(|entries| {
            let previous_len = entries.len();
            entries.retain(|entry| entry.event_id != event_id);
            Ok(entries.len() != previous_len)
        })
    }

    fn update<T>(
        &self,
        change: impl FnOnce(&mut Vec<QueuedClientEvent>) -> Result<T>,
    ) -> Result<T> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| TransportError::storage("无法更新客户端事件队列"))?;
        if let Some(error) = &state.initialization_error {
            return Err(error.clone());
        }
        let original = state.entries.clone();
        let result = change(&mut state.entries)?;
        if state.entries != original {
            if let Err(error) = persist_queue(&self.path, &state.entries) {
                state.entries = original;
                return Err(error);
            }
        }
        Ok(result)
    }
}

fn load_queue(path: &Path) -> Result<Vec<QueuedClientEvent>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path).map_err(|_| TransportError::storage("无法读取客户端事件队列"))?;
    let stored: QueueFile = serde_json::from_slice(&bytes)
        .map_err(|_| TransportError::storage("客户端事件队列已损坏"))?;
    if stored.version != QUEUE_VERSION || stored.entries.len() > MAX_QUEUED_EVENTS {
        return Err(TransportError::storage("客户端事件队列格式无效"));
    }
    validate_stored_entries(&stored.entries)?;
    Ok(stored.entries)
}

fn validate_stored_entries(entries: &[QueuedClientEvent]) -> Result<()> {
    let mut event_ids = std::collections::HashSet::with_capacity(entries.len());
    for entry in entries {
        if uuid::Uuid::parse_str(&entry.event_id).is_err()
            || !event_ids.insert(entry.event_id.as_str())
            || entry.category != "client_export"
            || entry.action != "file_generation"
            || entry.occurred_at.len() > 64
        {
            return Err(TransportError::storage("客户端事件队列格式无效"));
        }
        validate_identifier(&entry.instance_id, 128, "服务实例标识")?;
        validate_identifier(&entry.user_id, 128, "用户标识")?;
        validate_identifier(&entry.target_id, 100, "导出任务标识")?;
        if entry.rejection.as_ref().is_some_and(|rejection| {
            rejection.reason.is_empty()
                || rejection.reason.chars().count() > 512
                || rejection.reason.chars().any(char::is_control)
        }) {
            return Err(TransportError::storage("客户端事件队列格式无效"));
        }
    }
    Ok(())
}

fn normalize_rejection_reason(value: &str) -> String {
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(512)
        .collect::<String>();
    let normalized = normalized.trim();
    if normalized.is_empty() {
        "服务端永久拒绝客户端事件".to_string()
    } else {
        normalized.to_string()
    }
}

fn queue_unavailable(message: impl Into<String>) -> TransportError {
    TransportError::new(
        ErrorKind::Storage,
        "client_event_queue_unavailable",
        message,
    )
}

fn validate_identifier(value: &str, max_len: usize, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > max_len
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || matches!(byte, b'/' | b'\\'))
    {
        return Err(TransportError::validation(
            "invalid_client_event",
            format!("{label}无效"),
        ));
    }
    Ok(())
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn rfc3339_now() -> Result<String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| TransportError::storage("无法生成客户端事件时间"))
}

fn persist_queue(path: &Path, entries: &[QueuedClientEvent]) -> Result<()> {
    let bytes = serde_json::to_vec(&QueueFile {
        version: QUEUE_VERSION,
        entries: entries.to_vec(),
    })
    .map_err(|_| TransportError::storage("无法编码客户端事件队列"))?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let write_result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| TransportError::storage("无法创建客户端事件临时文件"))?;
        file.write_all(&bytes)
            .map_err(|_| TransportError::storage("无法写入客户端事件队列"))?;
        file.sync_all()
            .map_err(|_| TransportError::storage("无法提交客户端事件临时文件"))
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if replace_file(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(TransportError::storage("无法提交客户端事件队列"));
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are NUL-terminated UTF-16 buffers that remain alive
    // for the duration of the Win32 call.
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/runtime/rust-tests")
            .join(format!("client-events-{}", uuid::Uuid::new_v4()))
    }

    fn cleanup_test_root(root: &Path) {
        let runtime_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/runtime/rust-tests")
            .canonicalize()
            .unwrap();
        let root = root.canonicalize().unwrap();
        assert!(root.starts_with(&runtime_root));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_events_and_only_exposes_the_matching_session_payload() {
        let root = test_root();
        let alice = ClientEventBinding::new("instance-a", "alice").unwrap();
        let bob = ClientEventBinding::new("instance-a", "bob").unwrap();
        let queue = ClientEventQueue::open(root.clone()).unwrap();
        let event = queue
            .enqueue_export(&alice, "job-1", ClientEventOutcome::Success)
            .unwrap();
        queue
            .enqueue_export(&bob, "job-2", ClientEventOutcome::Failed)
            .unwrap();
        drop(queue);

        let reopened = ClientEventQueue::open(root.clone()).unwrap();
        assert_eq!(reopened.ready(&alice, u64::MAX, 10).unwrap(), vec![event]);
        assert!(
            reopened
                .ready(
                    &ClientEventBinding::new("instance-b", "alice").unwrap(),
                    u64::MAX,
                    10
                )
                .unwrap()
                .is_empty()
        );
        let outbound = serde_json::to_value(reopened.ready(&alice, u64::MAX, 10).unwrap()).unwrap();
        assert_eq!(outbound[0]["instanceId"], "instance-a");
        assert!(outbound[0].get("userId").is_none());
        assert_eq!(outbound[0]["category"], "client_export");
        assert_eq!(outbound[0]["action"], "file_generation");
        cleanup_test_root(&root);
    }

    #[test]
    fn acknowledgement_removes_only_the_acknowledged_event() {
        let root = test_root();
        let binding = ClientEventBinding::new("instance-a", "alice").unwrap();
        let queue = ClientEventQueue::open(root.clone()).unwrap();
        let first = queue
            .enqueue_export(&binding, "job-1", ClientEventOutcome::Success)
            .unwrap();
        let second = queue
            .enqueue_export(&binding, "job-2", ClientEventOutcome::Canceled)
            .unwrap();
        assert!(!queue.acknowledge("not-an-event").unwrap());
        assert!(queue.acknowledge(&first.event_id).unwrap());
        assert_eq!(queue.ready(&binding, u64::MAX, 10).unwrap(), vec![second]);
        cleanup_test_root(&root);
    }

    #[test]
    fn retry_uses_bounded_exponential_backoff() {
        let root = test_root();
        let binding = ClientEventBinding::new("instance-a", "alice").unwrap();
        let queue = ClientEventQueue::open(root.clone()).unwrap();
        let event = queue
            .enqueue_export(&binding, "job-1", ClientEventOutcome::Failed)
            .unwrap();
        assert!(queue.mark_retry(&event.event_id, 10_000).unwrap());
        assert!(queue.ready(&binding, 11_999, 10).unwrap().is_empty());
        assert_eq!(
            queue.ready(&binding, 12_000, 10).unwrap(),
            vec![event.clone()]
        );
        for attempt in 0_u64..20 {
            queue.mark_retry(&event.event_id, attempt * 1_000).unwrap();
        }
        assert!(queue.ready(&binding, 318_999, 10).unwrap().is_empty());
        assert_eq!(queue.ready(&binding, 319_000, 10).unwrap(), vec![event]);
        cleanup_test_root(&root);
    }

    #[test]
    fn full_queue_returns_an_explicit_error_without_dropping_events() {
        let root = test_root();
        let binding = ClientEventBinding::new("instance-a", "alice").unwrap();
        fs::create_dir_all(&root).unwrap();
        let entries = (0..MAX_QUEUED_EVENTS)
            .map(|index| QueuedClientEvent {
                event_id: uuid::Uuid::new_v4().to_string(),
                occurred_at: "2026-10-23T00:00:00Z".to_string(),
                category: "client_export".to_string(),
                action: "file_generation".to_string(),
                target_id: format!("job-{index}"),
                outcome: ClientEventOutcome::Success,
                instance_id: "instance-a".to_string(),
                user_id: "alice".to_string(),
                attempts: 0,
                next_attempt_at_ms: 0,
                rejection: None,
            })
            .collect::<Vec<_>>();
        persist_queue(&root.join(QUEUE_FILE), &entries).unwrap();
        let queue = ClientEventQueue::open(root.clone()).unwrap();
        let error = queue
            .enqueue_export(&binding, "job-overflow", ClientEventOutcome::Success)
            .unwrap_err();
        assert_eq!(error.code, "client_event_queue_full");
        assert_eq!(
            queue
                .ready(&binding, u64::MAX, MAX_QUEUED_EVENTS)
                .unwrap()
                .len(),
            MAX_READY_EVENTS
        );
        cleanup_test_root(&root);
    }

    #[test]
    fn permanent_rejection_is_retained_for_diagnostics_and_not_retried() {
        let root = test_root();
        let binding = ClientEventBinding::new("instance-a", "alice").unwrap();
        let queue = ClientEventQueue::open(root.clone()).unwrap();
        let event = queue
            .enqueue_export(&binding, "job-1", ClientEventOutcome::Failed)
            .unwrap();
        assert!(
            queue
                .reject_permanent(&event.event_id, "invalid event\nbody", 42_000)
                .unwrap()
        );
        assert!(queue.ready(&binding, u64::MAX, 10).unwrap().is_empty());
        drop(queue);

        let reopened = ClientEventQueue::open(root.clone()).unwrap();
        let diagnostics = reopened.diagnostics().unwrap();
        assert!(!diagnostics.disabled);
        assert_eq!(diagnostics.pending, 0);
        assert_eq!(diagnostics.rejected, 1);
        let rejection = diagnostics.last_rejection.unwrap();
        assert_eq!(rejection.event_id, event.event_id);
        assert_eq!(rejection.target_id, "job-1");
        assert_eq!(rejection.rejected_at_ms, 42_000);
        assert_eq!(rejection.reason, "invalid event body");
        assert!(reopened.ready(&binding, u64::MAX, 10).unwrap().is_empty());
        cleanup_test_root(&root);
    }

    #[test]
    fn corrupt_queue_is_preserved_and_disables_events_without_blocking_open() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join(QUEUE_FILE);
        let corrupt = b"{not-valid-json";
        fs::write(&path, corrupt).unwrap();

        let queue = ClientEventQueue::open(root.clone()).unwrap();
        let initialization_error = queue.initialization_error().unwrap();
        assert_eq!(initialization_error.code, "client_event_queue_unavailable");
        assert!(queue.diagnostics().unwrap().disabled);
        let error = queue
            .enqueue_export(
                &ClientEventBinding::new("instance-a", "alice").unwrap(),
                "job-1",
                ClientEventOutcome::Success,
            )
            .unwrap_err();
        assert_eq!(error.code, "client_event_queue_unavailable");
        assert_eq!(fs::read(path).unwrap(), corrupt);
        cleanup_test_root(&root);
    }

    #[test]
    fn persistence_replaces_the_queue_without_backup_artifacts() {
        let root = test_root();
        let binding = ClientEventBinding::new("instance-a", "alice").unwrap();
        let queue = ClientEventQueue::open(root.clone()).unwrap();
        let first = queue
            .enqueue_export(&binding, "job-1", ClientEventOutcome::Success)
            .unwrap();
        queue
            .enqueue_export(&binding, "job-2", ClientEventOutcome::Failed)
            .unwrap();
        queue.acknowledge(&first.event_id).unwrap();
        drop(queue);

        let reopened = ClientEventQueue::open(root.clone()).unwrap();
        assert_eq!(reopened.ready(&binding, u64::MAX, 10).unwrap().len(), 1);
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(std::result::Result::ok)
                .count(),
            1
        );
        cleanup_test_root(&root);
    }
}
