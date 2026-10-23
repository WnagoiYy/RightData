#![cfg(windows)]

use anyhow::{Context, Result, anyhow};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::watch;
use windows_service::define_windows_service;
use windows_service::service::{
    ServiceAccess, ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceStartType,
    ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{
    self, ServiceControlHandlerResult, ServiceStatusHandle,
};
use windows_service::service_dispatcher;
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_sys::Win32::System::Services::{
    ChangeServiceConfigW, SERVICE_AUTO_START, SERVICE_DEMAND_START,
};

pub const SERVICE_NAME: &str = "RightDataNetwork";

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static SERVICE_ERROR: Mutex<Option<anyhow::Error>> = Mutex::new(None);
static SCM_SERVICE_CONTEXT: AtomicBool = AtomicBool::new(false);

define_windows_service!(ffi_service_main, service_main);

/// Connects this process to the Windows Service Control Manager and blocks until
/// the service has stopped.
pub fn run_as_service(data_dir: PathBuf) -> Result<()> {
    DATA_DIR
        .set(data_dir)
        .map_err(|_| anyhow!("Windows service dispatcher was already started"))?;

    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .context("failed to connect RightDataNetwork to the service dispatcher")?;

    let mut error = SERVICE_ERROR
        .lock()
        .map_err(|_| anyhow!("Windows service error state is poisoned"))?;
    if let Some(error) = error.take() {
        return Err(error);
    }
    Ok(())
}

/// Changes only the startup type of the fixed RightData service registration.
/// All other service configuration fields are left unchanged.
pub fn set_auto_start(enabled: bool) -> Result<()> {
    ensure_scm_service_context()?;
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .context("failed to open the local service manager")?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::CHANGE_CONFIG)
        .context("failed to open RightDataNetwork for configuration")?;

    let start_type = if enabled {
        SERVICE_AUTO_START
    } else {
        SERVICE_DEMAND_START
    };
    // ChangeServiceConfigW uses u32::MAX as SERVICE_NO_CHANGE. Passing null for
    // every optional string keeps the binary, account, dependencies and display
    // name intact.
    let changed = unsafe {
        ChangeServiceConfigW(
            service.raw_handle(),
            u32::MAX,
            start_type,
            u32::MAX,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if changed == 0 {
        return Err(std::io::Error::last_os_error())
            .context("failed to update RightDataNetwork startup type");
    }
    Ok(())
}

pub fn query_auto_start() -> Result<bool> {
    ensure_scm_service_context()?;
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .context("failed to open the local service manager")?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_CONFIG)
        .context("failed to open RightDataNetwork for inspection")?;
    let config = service
        .query_config()
        .context("failed to query RightDataNetwork configuration")?;
    Ok(config.start_type == ServiceStartType::AutoStart)
}

fn service_main(_arguments: Vec<OsString>) {
    SCM_SERVICE_CONTEXT.store(true, Ordering::Release);
    let result = run_service();
    SCM_SERVICE_CONTEXT.store(false, Ordering::Release);

    if let Err(error) = result {
        if let Ok(mut slot) = SERVICE_ERROR.lock() {
            *slot = Some(error);
        }
    }
}

fn ensure_scm_service_context() -> Result<()> {
    if !SCM_SERVICE_CONTEXT.load(Ordering::Acquire) {
        return Err(anyhow!(
            "SCM startup management is unsupported outside the Windows service context"
        ));
    }
    Ok(())
}

fn run_service() -> Result<()> {
    let data_dir = DATA_DIR
        .get()
        .cloned()
        .ok_or_else(|| anyhow!("Windows service data directory was not initialized"))?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let status_slot: Arc<Mutex<Option<ServiceStatusHandle>>> = Arc::new(Mutex::new(None));
    let handler_status_slot = Arc::clone(&status_slot);

    let event_handler = move |control_event| -> ServiceControlHandlerResult {
        match control_event {
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            ServiceControl::Stop | ServiceControl::Shutdown => {
                if let Ok(status_slot) = handler_status_slot.lock()
                    && let Some(status_handle) = *status_slot
                {
                    let _ = status_handle.set_service_status(service_status(
                        ServiceState::StopPending,
                        ServiceControlAccept::empty(),
                        ServiceExitCode::Win32(0),
                        1,
                        Duration::from_secs(30),
                    ));
                }
                let _ = shutdown_tx.send(true);
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };

    let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)
        .context("failed to register the RightDataNetwork control handler")?;
    *status_slot
        .lock()
        .map_err(|_| anyhow!("Windows service status state is poisoned"))? = Some(status_handle);

    status_handle
        .set_service_status(service_status(
            ServiceState::StartPending,
            ServiceControlAccept::empty(),
            ServiceExitCode::Win32(0),
            1,
            Duration::from_secs(30),
        ))
        .context("failed to report RightDataNetwork start-pending status")?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to build the RightDataNetwork async runtime")?;

    status_handle
        .set_service_status(service_status(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            ServiceExitCode::Win32(0),
            0,
            Duration::ZERO,
        ))
        .context("failed to report RightDataNetwork running status")?;

    let run_result = runtime.block_on(crate::run(data_dir, shutdown_rx));
    if run_result.is_ok() {
        let _ = status_handle.set_service_status(service_status(
            ServiceState::StopPending,
            ServiceControlAccept::empty(),
            ServiceExitCode::Win32(0),
            1,
            Duration::from_secs(30),
        ));
    }

    let exit_code = if run_result.is_ok() {
        ServiceExitCode::Win32(0)
    } else {
        ServiceExitCode::ServiceSpecific(1)
    };
    status_handle
        .set_service_status(service_status(
            ServiceState::Stopped,
            ServiceControlAccept::empty(),
            exit_code,
            0,
            Duration::ZERO,
        ))
        .context("failed to report RightDataNetwork stopped status")?;

    run_result.context("RightDataNetwork stopped with an application error")
}

fn service_status(
    current_state: ServiceState,
    controls_accepted: ServiceControlAccept,
    exit_code: ServiceExitCode,
    checkpoint: u32,
    wait_hint: Duration,
) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state,
        controls_accepted,
        exit_code,
        checkpoint,
        wait_hint,
        process_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::ensure_scm_service_context;

    #[test]
    fn standalone_process_cannot_access_scm_startup_management() {
        let error = ensure_scm_service_context().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsupported outside the Windows service context")
        );
    }
}
