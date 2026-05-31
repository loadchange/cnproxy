//! Flow — a single captured HTTP request/response pair.

use serde::{Deserialize, Serialize};

/// Unique flow identifier.
pub type FlowId = String;

/// Summary sent to the web inspector for the flow list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowSummary {
    pub id: FlowId,
    pub method: String,
    pub url: String,
    pub host: String,
    pub path: String,
    pub status_code: Option<u16>,
    pub content_type: Option<String>,
    pub req_size: u64,
    pub res_size: u64,
    pub duration: Option<u64>, // ms
    pub flow_type: Option<String>,
    pub ws_messages: Option<u64>,
    pub mocked: bool,
    pub intercepted: bool,
    pub error: Option<String>,
    pub color: Option<String>,
    pub applied_rules: Vec<String>,
}

/// Full flow detail (headers, bodies, timings).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flow {
    pub id: FlowId,
    pub method: String,
    pub url: String,
    pub host: String,
    pub path: String,
    pub client: ClientInfo,
    pub request: RequestInfo,
    pub response: Option<ResponseInfo>,
    pub timing: Option<TimingInfo>,
    pub flow_type: String,
    pub ws_messages: Vec<WsMessage>,
    pub intercepted: bool,
    pub mocked: bool,
    pub error: Option<String>,
    pub color: Option<String>,
    pub applied_rules: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub address: String,
    pub port: u16,
    pub tls: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestInfo {
    pub headers: Vec<(String, String)>,
    pub body: Option<String>, // base64
    pub body_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseInfo {
    pub status_code: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>, // base64
    pub body_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimingInfo {
    pub dns: Option<u64>,
    pub connect: Option<u64>,
    pub tls: Option<u64>,
    pub ttfb: Option<u64>,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsMessage {
    pub from_client: bool,
    pub content: String, // base64
    pub msg_type: String, // "text" | "binary"
    pub timestamp: u64,   // ms epoch
}

impl Flow {
    /// Convert to a lightweight summary for the flow list.
    pub fn to_summary(&self) -> FlowSummary {
        FlowSummary {
            id: self.id.clone(),
            method: self.method.clone(),
            url: self.url.clone(),
            host: self.host.clone(),
            path: self.path.clone(),
            status_code: self.response.as_ref().map(|r| r.status_code),
            content_type: self.response.as_ref().and_then(|r| {
                r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-type")).map(|(_, v)| v.clone())
            }),
            req_size: self.request.body.as_ref().map(|b| b.len() as u64).unwrap_or(0),
            res_size: self.response.as_ref().and_then(|r| r.body.as_ref().map(|b| b.len() as u64)).unwrap_or(0),
            duration: self.timing.as_ref().and_then(|t| t.total),
            flow_type: if self.flow_type.is_empty() { None } else { Some(self.flow_type.clone()) },
            ws_messages: if self.ws_messages.is_empty() { None } else { Some(self.ws_messages.len() as u64) },
            mocked: self.mocked,
            intercepted: self.intercepted,
            error: self.error.clone(),
            color: self.color.clone(),
            applied_rules: self.applied_rules.clone(),
        }
    }
}