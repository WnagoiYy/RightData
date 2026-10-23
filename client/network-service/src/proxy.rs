use crate::network::Network;
use anyhow::{Context, Result, ensure};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use url::Url;

struct ProxyRequest {
    connect: bool,
    first_bytes: Vec<u8>,
}

fn parse_header(header: &[u8], expected: &Url, authorization: &str) -> Result<ProxyRequest> {
    let text = std::str::from_utf8(header).context("代理请求头无效")?;
    let mut lines = text.split("\r\n");
    let start = lines
        .next()
        .context("请求行缺失")?
        .split_whitespace()
        .collect::<Vec<_>>();
    ensure!(
        start.len() == 3 && start[2] == "HTTP/1.1",
        "代理仅接受 HTTP/1.1"
    );
    let mut authenticated = false;
    let mut kept = Vec::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').context("代理请求头无效")?;
        if name.eq_ignore_ascii_case("proxy-authorization") {
            authenticated = value.trim() == authorization;
            continue;
        }
        if name.eq_ignore_ascii_case("proxy-connection")
            || name.eq_ignore_ascii_case("connection")
            || name.eq_ignore_ascii_case("host")
        {
            continue;
        }
        ensure!(
            !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "代理请求头名称无效"
        );
        kept.push(line);
    }
    ensure!(authenticated, "代理凭据无效");
    if start[0] == "CONNECT" {
        let target = Url::parse(&format!("https://{}/", start[1]))?;
        ensure!(
            expected.scheme() == "https"
                && target.host_str() == expected.host_str()
                && target.port_or_known_default() == expected.port_or_known_default(),
            "代理目标不匹配"
        );
        return Ok(ProxyRequest {
            connect: true,
            first_bytes: Vec::new(),
        });
    }
    ensure!(
        matches!(
            start[0],
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
        ),
        "请求方法不支持"
    );
    let target = Url::parse(start[1])?;
    ensure!(
        expected.scheme() == "http"
            && target.scheme() == "http"
            && target.host_str() == expected.host_str()
            && target.port_or_known_default() == expected.port_or_known_default()
            && target.username().is_empty()
            && target.password().is_none(),
        "代理目标不匹配"
    );
    ensure!(
        target.path() == "/api" || target.path().starts_with("/api/"),
        "仅允许访问业务 API"
    );
    let path = &target[url::Position::BeforePath..url::Position::AfterQuery];
    let authority = &expected[url::Position::BeforeHost..url::Position::AfterPort];
    let rewritten = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\n{}\r\nConnection: close\r\n\r\n",
        start[0],
        path,
        authority,
        kept.join("\r\n")
    );
    Ok(ProxyRequest {
        connect: false,
        first_bytes: rewritten.into_bytes(),
    })
}

async fn handle(service: Arc<Network>, mut client: TcpStream) -> Result<()> {
    let started = Instant::now();
    let mut bytes = Vec::new();
    let header_end = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            ensure!(bytes.len() <= 16384, "代理请求头超限");
            if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                return Ok::<_, anyhow::Error>(index + 4);
            }
            let mut chunk = [0u8; 1024];
            let count = client.read(&mut chunk).await?;
            ensure!(count > 0, "代理请求未完成");
            bytes.extend_from_slice(&chunk[..count]);
        }
    })
    .await??;
    let config = service.config_snapshot().await;
    let target = Url::parse(&config.server_url)?;
    let request = match parse_header(
        &bytes[..header_end],
        &target,
        &service.proxy_authorization(),
    ) {
        Ok(request) => request,
        Err(error) => {
            let _ = client
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                )
                .await;
            return Err(error);
        }
    };
    let (mut tunnel, _, peer_id) = match service.connect_backend(&config).await {
        Ok(value) => value,
        Err(error) => {
            let _ = client
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                )
                .await;
            return Err(error);
        }
    };
    if request.connect {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
    } else {
        tunnel.write_all(&request.first_bytes).await?;
    }
    if bytes.len() > header_end {
        tunnel.write_all(&bytes[header_end..]).await?;
    }
    let result = tokio::io::copy_bidirectional(&mut client, &mut tunnel).await;
    let (sent, received) = result.as_ref().copied().unwrap_or_default();
    service
        .log(
            "tunnel",
            "backend",
            if result.is_ok() { "success" } else { "failed" },
            started.elapsed(),
            peer_id.as_deref(),
            sent,
            received,
        )
        .await;
    result?;
    Ok(())
}

pub async fn serve(service: Arc<Network>, listener: TcpListener) -> Result<()> {
    loop {
        let (client, _) = listener.accept().await?;
        let Ok(permit) = service.local_slots.clone().try_acquire_owned() else {
            continue;
        };
        let service = service.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = handle(service, client).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proxy_is_authenticated_and_fixed_target() {
        let target = Url::parse("http://127.0.0.1:8003").unwrap();
        let valid = b"GET http://127.0.0.1:8003/api/probe HTTP/1.1\r\nHost: 127.0.0.1:8003\r\nProxy-Authorization: Basic secret\r\n\r\n";
        let request = parse_header(valid, &target, "Basic secret").unwrap();
        let result = String::from_utf8(request.first_bytes).unwrap();
        assert!(result.starts_with("GET /api/probe HTTP/1.1"));
        assert!(!result.contains("secret"));
        assert!(parse_header(valid, &target, "Basic different").is_err());
        assert!(
            parse_header(
                valid,
                &Url::parse("http://other:8003").unwrap(),
                "Basic secret"
            )
            .is_err()
        );
        assert!(
            parse_header(
                &String::from_utf8_lossy(valid)
                    .replace("/api/probe", "/private")
                    .into_bytes(),
                &target,
                "Basic secret"
            )
            .is_err()
        );
    }
}
