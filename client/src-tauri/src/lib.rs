mod client_events;
#[path = "../../platform/build_defaults.rs"]
mod build_defaults;
mod commands;
mod error;
mod models;
mod network_service;
mod screen;
mod storage;
mod transport;
mod updater;
#[path = "../../platform/launch_agent.rs"]
mod launch_agent;

use commands::*;
use error::TransportError;
use screen::ScreenManager;
use std::path::PathBuf;
use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};
use transport::AppState;

const TRAY_SHOW_ID: &str = "show-main";
const TRAY_EXIT_ID: &str = "exit-app";

pub(crate) fn debug_browser_args() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        let port = std::env::var("RIGHTDATA_TEST_DEBUG_PORT")
            .ok()?
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)?;
        Some(format!(
            "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
        ))
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW_ID, "打开主窗口", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, TRAY_EXIT_ID, "完全退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &exit])?;
    let mut tray = TrayIconBuilder::with_id("rightdata-main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("贵州权益数据平台")
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => show_main_window(app),
            TRAY_EXIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

fn app_data_root(app: &tauri::App) -> error::Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os("RIGHTDATA_CLIENT_DATA_DIR") {
        let root = PathBuf::from(value);
        if !root.is_absolute() {
            return Err(TransportError::validation(
                "invalid_data_dir",
                "RIGHTDATA_CLIENT_DATA_DIR 必须是绝对路径",
            ));
        }
        return Ok(root);
    }
    app.path()
        .app_data_dir()
        .map_err(|_| TransportError::storage("无法确定客户端本地数据目录"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    if let Some(args) = debug_browser_args()
        && let Some(window) = context.config_mut().app.windows.first_mut()
    {
        window.additional_browser_args = Some(args);
    }
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("rd-screen", |context, request, responder| {
            let manager = context
                .app_handle()
                .state::<ScreenManager>()
                .inner()
                .clone();
            let window_label = context.webview_label().to_string();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                responder.respond(manager.protocol_response(&window_label, request));
            });
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let root = app_data_root(app)?;
            #[cfg(target_os = "macos")]
            network_service::initialize_macos(&app.path().resource_dir()?)?;
            let state = AppState::new(root.clone())?;
            app.manage(state);
            let event_queue = client_events::ClientEventQueue::open(root.clone())?;
            let event_queue_error = event_queue.initialization_error();
            app.manage(event_queue);
            app.manage(updater::UpdateManager::from_build(root.join("updates")));
            app.manage(ScreenManager::new(root.join("screens")));
            app.manage(PreviewStore::default());
            install_tray(app)?;
            let initialization_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = initialization_handle.state::<AppState>();
                if let Err(error) = state.initialize_network_service().await {
                    state.mark_disconnected(&error).await;
                }
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(error) = event_queue_error {
                    handle
                        .state::<AppState>()
                        .record_transport(
                            "CLIENT_EVENT_QUEUE",
                            &error.code,
                            None,
                            None,
                            false,
                            std::time::Duration::ZERO,
                        )
                        .await;
                }
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
                loop {
                    interval.tick().await;
                    let _ = flush_pending_client_events(&handle).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            transport_get_state,
            transport_get_logs,
            transport_configure,
            transport_probe,
            network_service_get_state,
            network_service_set_enabled,
            network_service_set_autostart,
            export_event_enqueue,
            export_event_status,
            client_update_check,
            client_update_download,
            client_update_install,
            auth_login,
            auth_restore,
            auth_logout,
            api_request,
            api_upload,
            api_download,
            api_download_read,
            desktop_save_file,
            app_exit,
            preview_open,
            preview_get_state,
            screen_prepare,
            screen_release,
        ])
        .run(context)
        .expect("error while running RightData desktop application");
}

#[cfg(test)]
mod security_tests {
    #[test]
    fn production_csp_blocks_web_network_and_capability_has_no_remote_origin() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config
            .pointer("/app/security/csp")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        assert!(csp.contains("connect-src ipc: http://ipc.localhost"));
        assert!(csp.contains(
            "connect-src ipc: http://ipc.localhost http://rd-screen.localhost rd-screen:"
        ));
        assert!(!csp.contains("connect-src *"));
        assert!(csp.contains("base-uri http://rd-screen.localhost rd-screen:"));
        assert!(csp.contains("object-src 'none'"));

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(capability.get("remote").is_none());
        assert_eq!(
            config.pointer("/app/security/capabilities/0"),
            Some(&serde_json::Value::String("default".into()))
        );
        assert_eq!(
            config.pointer("/bundle/windows/nsis/installerHooks"),
            Some(&serde_json::Value::String(
                "../../deploy/windows/installer-hooks.nsh".into()
            ))
        );
        assert_eq!(
            config
                .pointer("/bundle/resources")
                .and_then(|resources| resources
                    .get("../target/x86_64-pc-windows-msvc/release/rightdata-network-service.exe")),
            Some(&serde_json::Value::String(
                "rightdata-network-service.exe".into()
            ))
        );
    }
}
