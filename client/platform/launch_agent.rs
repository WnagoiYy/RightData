//! Per-user macOS network service. Both executables share the same paths and plist.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Path, PathBuf};

pub const LABEL: &str = "com.rightdata.network";

#[derive(Clone, Debug)]
pub struct AgentLayout {
    pub root: PathBuf,
    pub executable: PathBuf,
    pub plist: PathBuf,
}

impl AgentLayout {
    pub fn from_home(home: &Path) -> std::io::Result<Self> {
        if !home.is_absolute() {
            return Err(std::io::Error::other("macOS home must be an absolute path"));
        }
        let root = home.join("Library/Application Support/RightData/network");
        Ok(Self {
            executable: root.join("bin/rightdata-network-service"),
            plist: home.join("Library/LaunchAgents").join(format!("{LABEL}.plist")),
            root,
        })
    }

    pub fn current() -> std::io::Result<Self> {
        let home = std::env::var_os("HOME").ok_or_else(|| std::io::Error::other("HOME is missing"))?;
        Self::from_home(Path::new(&home))
    }

    pub fn socket(&self) -> PathBuf {
        self.root.join("network.sock")
    }

    pub fn plist_text(&self, auto_start: bool) -> std::io::Result<String> {
        let executable = xml_path(&self.executable)?;
        let root = xml_path(&self.root)?;
        // KeepAlive must not imply RunAtLoad when the user disabled login startup.
        Ok(format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{LABEL}</string>
<key>ProgramArguments</key><array><string>{executable}</string><string>--data-dir</string><string>{root}</string></array>
<key>RunAtLoad</key><{auto_start}/>
<key>KeepAlive</key><false/>
<key>ProcessType</key><string>Background</string>
<key>AssociatedBundleIdentifiers</key><array><string>com.rightdata.client</string></array>
<key>ExitTimeOut</key><integer>10</integer>
<key>Umask</key><integer>63</integer>
</dict></plist>
"#))
    }
}

fn xml_path(path: &Path) -> std::io::Result<String> {
    let value = path.to_str().ok_or_else(|| std::io::Error::other("Path is not valid UTF-8"))?;
    if value.chars().any(|c| c.is_control()) {
        return Err(std::io::Error::other("Path contains control characters"));
    }
    Ok(value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .replace('"', "&quot;").replace('\'', "&apos;"))
}

#[cfg(unix)]
pub fn ensure_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(std::io::Error::other("Service directory is not owned by the current user"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir_all(path)?,
        Err(error) => return Err(error),
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(target_os = "macos")]
pub fn write_plist(layout: &AgentLayout, auto_start: bool) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let parent = layout.plist.parent().ok_or_else(|| std::io::Error::other("Invalid plist path"))?;
    std::fs::create_dir_all(parent)?;
    let metadata = std::fs::symlink_metadata(parent)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(std::io::Error::other("LaunchAgents directory is not owned by the current user"));
    }
    let text = layout.plist_text(auto_start)?;
    if std::fs::read_to_string(&layout.plist).ok().as_deref() == Some(&text) {
        return Ok(());
    }
    let temporary = parent.join(format!(".{LABEL}-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &layout.plist)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}

#[cfg(target_os = "macos")]
fn domain() -> String {
    format!("gui/{}", unsafe { libc::geteuid() })
}

#[cfg(target_os = "macos")]
fn job() -> String {
    format!("{}/{LABEL}", domain())
}

#[cfg(target_os = "macos")]
fn loaded() -> bool {
    std::process::Command::new("/bin/launchctl").args(["print", &job()])
        .output().is_ok_and(|output| output.status.success())
}

#[cfg(target_os = "macos")]
fn launchctl(args: &[&std::ffi::OsStr]) -> std::io::Result<()> {
    let output = std::process::Command::new("/bin/launchctl").args(args).output()?;
    if output.status.success() { return Ok(()); }
    Err(std::io::Error::other(format!("launchctl failed: {}", String::from_utf8_lossy(&output.stderr).trim())))
}

#[cfg(target_os = "macos")]
pub fn install_helper(layout: &AgentLayout, source: &Path, auto_start: bool) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    ensure_private_dir(&layout.root)?;
    ensure_private_dir(layout.executable.parent().unwrap())?;
    let bytes = std::fs::read(source)?;
    if bytes.is_empty() { return Err(std::io::Error::other("Bundled network service is empty")); }
    if std::fs::read(&layout.executable).ok().as_deref() != Some(bytes.as_slice()) {
        // Stop only our own launchd job before replacing its executable.
        if loaded() {
            launchctl(&["bootout".as_ref(), job().as_ref()])?;
        }
        let temporary = layout.executable.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o700).open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &layout.executable)
        })();
        if result.is_err() { let _ = std::fs::remove_file(&temporary); }
        result?;
    }
    write_plist(layout, auto_start)
}

#[cfg(target_os = "macos")]
pub fn start(layout: &AgentLayout) -> std::io::Result<()> {
    if !loaded() {
        launchctl(&["bootstrap".as_ref(), domain().as_ref(), layout.plist.as_os_str()])?;
    }
    launchctl(&["kickstart".as_ref(), job().as_ref()])
}

#[cfg(target_os = "macos")]
pub fn set_auto_start(root: &Path, enabled: bool) -> std::io::Result<()> {
    let layout = AgentLayout::current()?;
    if root != layout.root || !layout.executable.is_file() || !layout.plist.is_file() {
        return Err(std::io::Error::other("Login startup is available only for the installed user service"));
    }
    // Rewriting RunAtLoad takes effect at the next login; it does not stop the current service.
    write_plist(&layout, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_preserves_arguments_and_escapes_user_paths() {
        let home = std::env::temp_dir().join("user & <name>");
        let layout = AgentLayout::from_home(&home).unwrap();
        let text = layout.plist_text(false).unwrap();
        assert!(text.contains("user &amp; &lt;name&gt;"));
        assert!(text.contains("<string>--data-dir</string>"));
        assert!(text.contains("<key>RunAtLoad</key><false/>"));
        assert!(text.contains("<key>KeepAlive</key><false/>"));
        assert!(!text.contains("/bin/sh"));
        assert!(layout.plist_text(true).unwrap().contains("<key>RunAtLoad</key><true/>"));
    }

    #[test]
    fn relative_and_control_character_paths_are_rejected() {
        assert!(AgentLayout::from_home(Path::new("relative")).is_err());
        let layout = AgentLayout::from_home(&std::env::temp_dir().join("bad\nname")).unwrap();
        assert!(layout.plist_text(false).is_err());
    }
}
