use crate::error::{Result, TransportError};
use crate::models::{ConnectionSettings, TransportLogEntry};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use zeroize::{Zeroize, Zeroizing};

const SESSION_MAGIC: &[u8; 8] = b"RDSESS01";
const SESSION_AAD: &[u8] = b"rightdata/client-session/v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub instance_id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub access_expires_at_ms: u64,
    pub user: Value,
    pub remember: bool,
}

impl StoredSession {
    pub fn clear_secrets(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

pub struct Storage {
    root: PathBuf,
}

impl Storage {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)
            .map_err(|_| TransportError::storage("无法创建客户端本地数据目录"))?;
        Ok(Self { root })
    }

    pub fn load_settings(&self) -> Result<ConnectionSettings> {
        let path = self.root.join("connection.json");
        if !path.exists() {
            return Ok(ConnectionSettings::default());
        }
        let bytes = fs::read(path).map_err(|_| TransportError::storage("无法读取连接设置"))?;
        serde_json::from_slice(&bytes).map_err(|_| TransportError::storage("连接设置已损坏"))
    }

    pub fn has_settings(&self) -> bool {
        self.root.join("connection.json").is_file()
    }

    pub fn save_settings(&self, settings: &ConnectionSettings) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|_| TransportError::storage("无法编码连接设置"))?;
        self.atomic_write(&self.root.join("connection.json"), &bytes)
    }

    pub fn load_session(&self) -> Result<Option<StoredSession>> {
        let path = self.root.join("session.enc");
        if !path.exists() {
            return Ok(None);
        }
        let encrypted =
            fs::read(path).map_err(|_| TransportError::storage("无法读取登录恢复信息"))?;
        if encrypted.len() < SESSION_MAGIC.len() + 12 || &encrypted[..8] != SESSION_MAGIC {
            return Err(TransportError::storage("登录恢复信息格式无效"));
        }
        let key = self.read_or_create_key(false)?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| TransportError::storage("无法初始化本地凭据保护"))?;
        let nonce = Nonce::from_slice(&encrypted[8..20]);
        let plaintext = cipher
            .decrypt(
                nonce,
                aes_gcm::aead::Payload {
                    msg: &encrypted[20..],
                    aad: SESSION_AAD,
                },
            )
            .map_err(|_| TransportError::storage("登录恢复信息无法解密"))?;
        let plaintext = Zeroizing::new(plaintext);
        serde_json::from_slice(&plaintext)
            .map(Some)
            .map_err(|_| TransportError::storage("登录恢复信息已损坏"))
    }

    pub fn save_session(&self, session: &StoredSession) -> Result<()> {
        let key = self.read_or_create_key(true)?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| TransportError::storage("无法初始化本地凭据保护"))?;
        let plaintext = Zeroizing::new(
            serde_json::to_vec(session)
                .map_err(|_| TransportError::storage("无法编码登录恢复信息"))?,
        );
        let mut nonce_bytes = [0_u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                aes_gcm::aead::Payload {
                    msg: &plaintext,
                    aad: SESSION_AAD,
                },
            )
            .map_err(|_| TransportError::storage("无法保护登录恢复信息"))?;
        let mut output = Vec::with_capacity(20 + ciphertext.len());
        output.extend_from_slice(SESSION_MAGIC);
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);
        self.atomic_write(&self.root.join("session.enc"), &output)
    }

    pub fn delete_session(&self) -> Result<()> {
        let path = self.root.join("session.enc");
        if path.exists() {
            fs::remove_file(path).map_err(|_| TransportError::storage("无法清除登录恢复信息"))?;
        }
        Ok(())
    }

    pub fn load_transport_logs(&self) -> Result<Vec<TransportLogEntry>> {
        let path = self.root.join("transport-logs.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(path).map_err(|_| TransportError::storage("无法读取本地中转日志"))?;
        serde_json::from_slice(&bytes).map_err(|_| TransportError::storage("本地中转日志已损坏"))
    }

    pub fn save_transport_logs(&self, entries: &[TransportLogEntry]) -> Result<()> {
        let bytes = serde_json::to_vec(entries)
            .map_err(|_| TransportError::storage("无法编码本地中转日志"))?;
        self.atomic_write(&self.root.join("transport-logs.json"), &bytes)
    }

    fn read_or_create_key(&self, create: bool) -> Result<Zeroizing<Vec<u8>>> {
        let path = self.root.join("session.key");
        if path.exists() {
            let key =
                fs::read(path).map_err(|_| TransportError::storage("无法读取本地凭据保护密钥"))?;
            if key.len() != 32 {
                return Err(TransportError::storage("本地凭据保护密钥已损坏"));
            }
            return Ok(Zeroizing::new(key));
        }
        if !create {
            return Err(TransportError::storage("本地凭据保护密钥不存在"));
        }
        let mut key = Zeroizing::new(vec![0_u8; 32]);
        rand::rngs::OsRng.fill_bytes(&mut key);
        self.atomic_write(&path, &key)?;
        Ok(key)
    }

    fn atomic_write(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, bytes)
            .map_err(|_| TransportError::storage("无法写入客户端本地数据"))?;
        let backup = path.with_extension(format!("backup-{}", uuid::Uuid::new_v4()));
        let had_previous = path.exists();
        if had_previous && fs::rename(path, &backup).is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(TransportError::storage("无法替换客户端本地数据"));
        }
        if fs::rename(&temporary, path).is_err() {
            if had_previous {
                let _ = fs::rename(&backup, path);
            }
            let _ = fs::remove_file(&temporary);
            return Err(TransportError::storage("无法提交客户端本地数据"));
        }
        if had_previous {
            let _ = fs::remove_file(backup);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_session_round_trip_does_not_store_tokens_as_plaintext() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/runtime/rust-tests")
            .join(format!("storage-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(root.clone()).unwrap();
        let session = StoredSession {
            instance_id: "instance-a".into(),
            access_token: "plain-access-secret".into(),
            refresh_token: "plain-refresh-secret".into(),
            access_expires_at_ms: 123,
            user: serde_json::json!({"id":"user-a"}),
            remember: true,
        };
        storage.save_session(&session).unwrap();
        let encrypted = fs::read(root.join("session.enc")).unwrap();
        assert!(
            !encrypted
                .windows(19)
                .any(|part| part == b"plain-access-secret")
        );
        assert_eq!(
            storage.load_session().unwrap().unwrap().refresh_token,
            "plain-refresh-secret"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
