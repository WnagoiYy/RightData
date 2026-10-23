use serde::Serialize;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportError {
    pub kind: ErrorKind,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Validation,
    Network,
    Timeout,
    Server,
    Auth,
    Storage,
}

impl TransportError {
    pub fn new(kind: ErrorKind, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.into(),
            message: message.into(),
            status: None,
            request_id: None,
            retryable: false,
        }
    }

    pub fn validation(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Validation, code, message)
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Storage, "local_storage_failed", message)
    }

    pub fn from_reqwest(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            let mut result = Self::new(ErrorKind::Timeout, "request_timeout", "请求超时");
            result.retryable = true;
            return result;
        }
        let mut result = Self::new(ErrorKind::Network, "network_unavailable", "无法连接服务端");
        result.retryable = error.is_connect() || error.is_request();
        result
    }

    pub fn server(
        status: u16,
        code: impl Into<String>,
        message: impl Into<String>,
        request_id: Option<String>,
    ) -> Self {
        let kind = if status == 401 {
            ErrorKind::Auth
        } else {
            ErrorKind::Server
        };
        Self {
            kind,
            code: code.into(),
            message: message.into(),
            status: Some(status),
            request_id,
            retryable: status == 408 || status == 429 || status >= 500,
        }
    }
}

impl Display for TransportError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TransportError {}

pub type Result<T> = std::result::Result<T, TransportError>;
