mod control;
#[path = "../../platform/build_defaults.rs"]
mod build_defaults;
mod discovery;
mod network;
mod proxy;
#[path = "../../platform/launch_agent.rs"]
mod launch_agent;
#[cfg(windows)]
mod windows_service;

use anyhow::{Context, Result, bail};
use std::path::PathBuf;
use tokio::sync::watch;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut service = false;
    let mut controller_sid = None;
    let mut data_dir = std::env::var_os("PROGRAMDATA").map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("." )).join("RightData/network");
    #[cfg(target_os = "macos")]
    { data_dir = launch_agent::AgentLayout::current()?.root; }
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--service" => service = true,
            "--data-dir" => data_dir = PathBuf::from(args.next().context("--data-dir requires a path")?),
            "--controller-sid" => controller_sid = Some(args.next().context("--controller-sid requires a Windows SID")?),
            "--help" => { println!("rightdata-network-service [--service] --data-dir <absolute path>\nTest pipe: RIGHTDATA_NETWORK_PIPE"); return Ok(()); }
            _ => bail!("Unknown argument: {arg}"),
        }
    }
    if !data_dir.is_absolute() { bail!("--data-dir must be absolute"); }
    #[cfg(windows)]
    {
        if service && controller_sid.is_none() { bail!("Windows service requires an installation-bound --controller-sid"); }
        control::initialize_controller(controller_sid)?;
    }
    #[cfg(windows)]
    if service { return windows_service::run_as_service(data_dir).map_err(|error| anyhow::anyhow!(error.to_string())); }
    #[cfg(not(windows))]
    if service { bail!("Windows service mode is only available on Windows"); }
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(async move {
        let (stop, receiver) = watch::channel(false);
        tokio::spawn(async move {
            #[cfg(unix)]
            {
                let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            }
            #[cfg(not(unix))]
            { let _ = tokio::signal::ctrl_c().await; }
            let _ = stop.send(true);
        });
        run(data_dir, receiver).await
    })
}

pub async fn run(data_dir: PathBuf, mut shutdown: watch::Receiver<bool>) -> Result<()> {
    #[cfg(unix)]
    let _control_lock = control::lock_data_dir(&data_dir)?;
    let service = network::Network::open(data_dir).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    service.set_proxy(listener.local_addr()?).await;
    let proxy_task = tokio::spawn(proxy::serve(service.clone(), listener));
    let mut control_task = tokio::spawn(control::serve(service.clone()));
    let maintenance = tokio::spawn(network::maintain(service.clone()));
    tokio::select! {
        _ = shutdown.wait_for(|value| *value) => {},
        result = &mut control_task => { result??; },
    }
    service.shutdown().await;
    proxy_task.abort();
    control_task.abort();
    maintenance.abort();
    Ok(())
}
