use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use iroh::EndpointAddr;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{net::SocketAddr, time::{Duration, SystemTime, UNIX_EPOCH}};
use crate::network::{Config, Network};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub protocol: String,
    pub endpoint_id: String,
    pub direct_addresses: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    pub expires_at: u64,
}
impl Node {
    pub fn address(&self, allow_public_relay: bool) -> Result<EndpointAddr> {
        ensure!(self.protocol == "rightdata/relay/1" && self.expires_at > now_ms() && self.expires_at <= now_ms() + 90_000, "节点租约无效");
        ensure!(self.endpoint_id.len() == 64 && self.endpoint_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "节点公钥无效");
        ensure!(self.direct_addresses.len() <= 32, "节点地址过多");
        let mut address = EndpointAddr::new(self.endpoint_id.parse()?);
        for ip in &self.direct_addresses {
            let socket: SocketAddr = ip.parse().context("节点直连地址必须为数值 IP 与端口")?;
            ensure!(socket.port() != 0 && !socket.ip().is_unspecified() && !socket.ip().is_multicast(), "节点直连地址不可用");
            address = address.with_ip_addr(socket);
        }
        if allow_public_relay && let Some(relay) = &self.relay_url {
            let url = url::Url::parse(relay)?;
            ensure!(url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && url.fragment().is_none(), "公网中继地址无效");
            address = address.with_relay_url(relay.parse()?);
        }
        ensure!(!address.is_empty(), "节点没有允许的可用地址");
        Ok(address)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeList { protocol: String, instance_id: String, nodes: Vec<Node> }

pub fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_millis() as u64 }

fn node_path(config: &Config, endpoint: &str) -> Result<String> { Ok(format!("/v1/instances/{}/nodes/{endpoint}", config.bound_instance_id.as_ref().context("尚未绑定服务实例")?)) }

pub fn signature_message(method: &str, path: &str, payload: &Value) -> Result<String> {
    // serde_json's default Map is a BTreeMap. All schema keys are ASCII and values contain no floats.
    Ok(format!("{}\n{}\n{}\n{}", method.to_ascii_uppercase(), path, payload.get("expiresAt").and_then(Value::as_u64).context("租约缺少截止时间")?, serde_json::to_string(payload)?))
}
fn signed(service: &Network, method: &str, path: &str, mut payload: Value) -> Result<Value> {
    let signature = service.key.sign(signature_message(method, path, &payload)?.as_bytes());
    payload.as_object_mut().context("登记内容无效")?.insert("signature".into(), Value::String(STANDARD.encode(signature.to_bytes())));
    Ok(payload)
}

pub async fn register(service: &Network, config: &Config) -> Result<()> {
    let Some(base) = config.discovery_url.as_ref() else { return Ok(()); };
    let endpoint = service.endpoint().await?;
    let address = endpoint.addr();
    let mut ips = address.ip_addrs().map(ToString::to_string).collect::<Vec<_>>(); ips.sort(); ips.dedup();
    ensure!(!ips.is_empty(), "本机尚无可登记的地址");
    let relay = if config.allow_public_relay { address.relay_urls().next().map(ToString::to_string) } else { None };
    let node = Node { protocol: "rightdata/relay/1".into(), endpoint_id: service.device_id(), direct_addresses: ips, relay_url: relay, expires_at: now_ms() + 60_000 };
    let path = node_path(config, &node.endpoint_id)?;
    let body = signed(service, "PUT", &path, serde_json::to_value(node)?)?;
    let response = service.client.put(format!("{base}{path}")).json(&body).send().await?;
    ensure!(response.status().is_success(), "节点登记失败 ({})", response.status().as_u16());
    Ok(())
}

pub async fn unregister(service: &Network, config: &Config) -> Result<()> {
    let Some(base) = config.discovery_url.as_ref() else { return Ok(()); };
    if config.bound_instance_id.is_none() { return Ok(()); }
    let path = node_path(config, &service.device_id())?;
    let body = signed(service, "DELETE", &path, json!({"protocol":"rightdata/relay/1","endpointId":service.device_id(),"expiresAt":now_ms()+60_000}))?;
    let response = service.client.delete(format!("{base}{path}")).json(&body).send().await?;
    ensure!(response.status().is_success(), "节点离线登记失败");
    Ok(())
}

pub async fn lookup(service: &Network, config: &Config) -> Result<Vec<Node>> {
    let base = config.discovery_url.as_ref().context("未配置节点发现地址")?;
    let instance = config.bound_instance_id.as_ref().context("尚未绑定服务实例")?;
    let mut response = service.client.get(format!("{base}/v1/instances/{instance}/nodes")).send().await?;
    ensure!(response.status().is_success(), "节点发现失败 ({})", response.status().as_u16());
    ensure!(response.content_length().is_none_or(|length| length <= 512 * 1024), "节点发现响应超限");
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? { ensure!(bytes.len() + chunk.len() <= 512 * 1024, "节点发现响应超限"); bytes.extend_from_slice(&chunk); }
    let list: NodeList = serde_json::from_slice(&bytes)?;
    ensure!(list.protocol == "rightdata/discovery/1" && list.instance_id == *instance && list.nodes.len() <= 256, "节点发现响应与实例不匹配");
    Ok(list.nodes.into_iter().filter(|node| node.address(config.allow_public_relay).is_ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_signature_is_stable() {
        let value = json!({"protocol":"rightdata/relay/1","endpointId":"aa","expiresAt":123});
        assert_eq!(signature_message("put", "/v1/a", &value).unwrap(), "PUT\n/v1/a\n123\n{\"endpointId\":\"aa\",\"expiresAt\":123,\"protocol\":\"rightdata/relay/1\"}");
    }
    #[test]
    fn unapproved_relay_url_is_never_dialed() {
        let key = iroh::SecretKey::generate();
        let node = Node { protocol: "rightdata/relay/1".into(), endpoint_id: key.public().to_string(), direct_addresses: vec![], relay_url: Some("https://relay.example.org".into()), expires_at: now_ms()+60_000 };
        assert!(node.address(false).is_err());
        assert!(node.address(true).is_ok());
    }
}
