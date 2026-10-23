use anyhow::{Context, Result, ensure};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use crate::network::{Config, Network};

const MAX_FRAME: usize = 65536;
#[cfg(windows)]
static CONTROLLER_SID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

#[cfg(windows)]
pub fn initialize_controller(configured: Option<String>) -> Result<()> {
    let sid = configured.map(Ok).unwrap_or_else(current_user_sid)?;
    ensure!(sid.len() <= 184 && sid.starts_with("S-1-") && sid.split('-').skip(1).all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())), "安装控制用户 SID 无效");
    CONTROLLER_SID.set(sid).map_err(|_| anyhow::anyhow!("控制用户已经初始化"))
}

#[cfg(windows)]
fn current_user_sid() -> Result<String> {
    use windows_sys::Win32::{Foundation::{CloseHandle, LocalFree}, Security::{Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER}, System::Threading::{GetCurrentProcess, OpenProcessToken}};
    use std::ptr;
    // SAFETY: token storage is correctly aligned, pointer strings are read before their matching frees.
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return Err(std::io::Error::last_os_error().into()); }
        let mut length = 0;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
        let mut storage = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        if GetTokenInformation(token, TokenUser, storage.as_mut_ptr().cast(), length, &mut length) == 0 {
            let error = std::io::Error::last_os_error(); CloseHandle(token); return Err(error.into());
        }
        let user = &*(storage.as_ptr().cast::<TOKEN_USER>());
        let mut text = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            let error = std::io::Error::last_os_error(); CloseHandle(token); return Err(error.into());
        }
        let mut count = 0; while *text.add(count) != 0 { count += 1; }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(text, count));
        LocalFree(text.cast()); CloseHandle(token); Ok(result)
    }
}
pub async fn read_frame<T: DeserializeOwned>(stream: &mut (impl AsyncRead + Unpin)) -> Result<T> {
    let length = stream.read_u32().await? as usize;
    ensure!(length > 0 && length <= MAX_FRAME, "控制帧长度无效");
    let mut data = vec![0u8; length]; stream.read_exact(&mut data).await?;
    Ok(serde_json::from_slice(&data)?)
}
pub async fn write_frame(stream: &mut (impl AsyncWrite + Unpin), value: &impl Serialize) -> Result<()> {
    let data = serde_json::to_vec(value)?;
    ensure!(data.len() <= MAX_FRAME, "控制帧过大");
    stream.write_u32(data.len() as u32).await?; stream.write_all(&data).await?; stream.flush().await?;
    Ok(())
}

async fn dispatch(service: Arc<Network>, request: &Value) -> Result<Value> {
    ensure!(request.get("v").and_then(Value::as_u64) == Some(1), "网络服务协议版本不兼容");
    ensure!(request.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty() && id.len() <= 100), "请求标识无效");
    match request.get("op").and_then(Value::as_str).unwrap_or("") {
        "status" => Ok(service.status().await),
        "configure" => {
            let config: Config = serde_json::from_value(request.get("config").cloned().context("缺少连接设置")?)?;
            service.configure(config).await
        },
        "start" => service.enable(true).await,
        "stop" => service.enable(false).await,
        "autostart" => service.set_autostart(request.get("autoStart").and_then(Value::as_bool).context("缺少开机启动选项")?).await,
        "logs" => Ok(service.logs(request.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize, request.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize).await),
        _ => anyhow::bail!("不支持的本机服务操作"),
    }
}

async fn handle(service: Arc<Network>, mut stream: impl AsyncRead + AsyncWrite + Unpin) -> Result<()> {
    let request: Value = tokio::time::timeout(std::time::Duration::from_secs(5), read_frame(&mut stream)).await??;
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let result = dispatch(service, &request).await;
    let response = match result { Ok(data) => json!({"v":1,"id":id,"ok":true,"data":data}), Err(error) => json!({"v":1,"id":id,"ok":false,"error":{"code":"network_service_error","message":error.to_string()}}) };
    write_frame(&mut stream, &response).await?;
    stream.shutdown().await?;
    Ok(())
}

#[cfg(windows)]
fn create_pipe(name: &str, first: bool) -> Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::{SECURITY_ATTRIBUTES, Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW}};
    use std::{ffi::c_void, ptr};
    // Only the installation-bound desktop user can control this machine's proxy.
    // FILE_GENERIC_WRITE contains FILE_CREATE_PIPE_INSTANCE; use an explicit mask excluding it.
    let sid = CONTROLLER_SID.get().context("控制用户尚未初始化")?;
    let sddl: Vec<u16> = format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x0012019b;;;{sid})\0").encode_utf16().collect();
    let mut descriptor: *mut c_void = ptr::null_mut();
    // SAFETY: descriptor is initialized by the Win32 API and freed after CreateNamedPipe copies it.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, ptr::null_mut()) == 0 { return Err(std::io::Error::last_os_error().into()); }
        let mut attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
        let pipe = tokio::net::windows::named_pipe::ServerOptions::new().reject_remote_clients(true).first_pipe_instance(first).create_with_security_attributes_raw(name, (&mut attributes as *mut SECURITY_ATTRIBUTES).cast());
        LocalFree(descriptor);
        pipe.map_err(Into::into)
    }
}

#[cfg(windows)]
pub async fn serve(service: Arc<Network>) -> Result<()> {
    let name = std::env::var("RIGHTDATA_NETWORK_PIPE").unwrap_or_else(|_| r"\\.\pipe\rightdata-network-v1".into());
    ensure!(name.starts_with(r"\\.\pipe\rightdata-") && name.len() <= 200, "控制管道名称无效");
    let mut server = create_pipe(&name, true)?;
    loop {
        server.connect().await?;
        let connected = server;
        server = create_pipe(&name, false)?;
        let service = service.clone();
        tokio::spawn(async move { let _ = handle(service, connected).await; });
    }
}

#[cfg(unix)]
pub fn lock_data_dir(root: &std::path::Path) -> Result<std::fs::File> {
    use std::os::unix::{fs::{MetadataExt, OpenOptionsExt}, io::AsRawFd};
    crate::launch_agent::ensure_private_dir(root)?;
    let lock = std::fs::OpenOptions::new().read(true).write(true).create(true)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(root.join("network.lock"))?;
    let metadata = lock.metadata()?;
    ensure!(metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() }, "控制锁不是当前用户的普通文件");
    ensure!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0, "网络服务已运行");
    Ok(lock)
}

#[cfg(unix)]
struct SocketPathGuard { path: std::path::PathBuf, inode: u64 }

#[cfg(unix)]
impl Drop for SocketPathGuard {
    fn drop(&mut self) {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        if std::fs::symlink_metadata(&self.path).is_ok_and(|m| m.file_type().is_socket() && m.ino() == self.inode) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
pub async fn serve(service: Arc<Network>) -> Result<()> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use tokio::net::UnixListener;
    let path = service.root.join("network.sock");
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            ensure!(metadata.file_type().is_socket() && metadata.uid() == unsafe { libc::geteuid() }, "控制套接字路径不安全");
            match std::os::unix::net::UnixStream::connect(&path) {
                Ok(_) => anyhow::bail!("网络服务已运行"),
                Err(error) if matches!(error.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound) => {
                    std::fs::remove_file(&path)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.into()),
    }
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    let _socket = SocketPathGuard { path: path.clone(), inode: std::fs::symlink_metadata(&path)?.ino() };
    loop {
        let (stream, _) = listener.accept().await?;
        if stream.peer_cred()?.uid() != unsafe { libc::geteuid() } { continue; }
        let service = service.clone();
        tokio::spawn(async move { let _ = handle(service, stream).await; });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn frame_roundtrip_and_oversize_rejection() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        let writer = tokio::spawn(async move { write_frame(&mut a, &json!({"v":1,"id":"one"})).await.unwrap(); });
        assert_eq!(read_frame::<Value>(&mut b).await.unwrap()["id"], "one"); writer.await.unwrap();
        let (mut a, mut b) = tokio::io::duplex(8);
        a.write_u32(65537).await.unwrap();
        assert!(read_frame::<Value>(&mut b).await.is_err());
    }
}
