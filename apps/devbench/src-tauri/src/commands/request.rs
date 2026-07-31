use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use futures::stream::StreamExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeaderPair {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct FireRequestInput {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderPair>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FireRequestOutput {
    pub status_code: u16,
    pub headers: Vec<HeaderPair>,
    pub body: String,
    pub duration_ms: u64,
}

const MAX_BODY_SIZE: usize = 10 * 1024 * 1024; // 10 MiB

pub async fn fire_request_impl(input: FireRequestInput) -> Result<FireRequestOutput, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;
    let method: reqwest::Method = input
        .method
        .parse()
        .map_err(|e| format!("invalid method '{}': {e}", input.method))?;
    let mut req = client.request(method, &input.url);

    let has_content_type = input.headers.iter().any(|h| h.key.eq_ignore_ascii_case("content-type"));
    for h in &input.headers {
        req = req.header(&h.key, &h.value);
    }
    if let Some(body) = &input.body {
        if !has_content_type {
            req = req.header("content-type", "application/json");
        }
        req = req.body(body.clone());
    }

    let started = Instant::now();
    let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status_code = resp.status().as_u16();
    // A response header whose value isn't valid UTF-8 is skipped rather than
    // failing the whole request — one odd header shouldn't turn a real 200
    // into an error.
    let headers = resp
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|v| HeaderPair { key: name.as_str().to_string(), value: v.to_string() })
        })
        .collect();

    // Read response body with size limit
    let mut body_bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("failed to read response body: {e}"))?;
        body_bytes.extend_from_slice(&chunk);
        if body_bytes.len() > MAX_BODY_SIZE {
            return Err(format!("response body exceeds maximum size of {} bytes", MAX_BODY_SIZE));
        }
    }
    let body = String::from_utf8(body_bytes)
        .map_err(|e| format!("response body is not valid utf8: {e}"))?;
    let duration_ms = started.elapsed().as_millis() as u64;

    Ok(FireRequestOutput { status_code, headers, body, duration_ms })
}

#[tauri::command]
pub async fn fire_request(input: FireRequestInput) -> Result<FireRequestOutput, String> {
    fire_request_impl(input).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fires_a_get_request_and_reports_status() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/ping")
            .with_status(200)
            .with_body("pong")
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "GET".to_string(),
            url: format!("{}/ping", server.url()),
            headers: vec![],
            body: None,
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert_eq!(result.status_code, 200);
        assert_eq!(result.body, "pong");
    }

    #[tokio::test]
    async fn rejects_an_invalid_method() {
        let result = fire_request_impl(FireRequestInput {
            method: "NOT-A-METHOD lol".to_string(),
            url: "http://localhost".to_string(),
            headers: vec![],
            body: None,
        })
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn sends_every_provided_header() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/ping")
            .match_header("x-debug", "true")
            .match_header("authorization", "Bearer abc123")
            .with_status(200)
            .with_body("pong")
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "GET".to_string(),
            url: format!("{}/ping", server.url()),
            headers: vec![
                HeaderPair { key: "X-Debug".to_string(), value: "true".to_string() },
                HeaderPair { key: "Authorization".to_string(), value: "Bearer abc123".to_string() },
            ],
            body: None,
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert_eq!(result.body, "pong");
    }

    #[tokio::test]
    async fn a_user_supplied_content_type_overrides_the_default() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/echo")
            .match_header("content-type", "text/plain")
            .with_status(200)
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "POST".to_string(),
            url: format!("{}/echo", server.url()),
            headers: vec![HeaderPair { key: "Content-Type".to_string(), value: "text/plain".to_string() }],
            body: Some("hello".to_string()),
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert_eq!(result.status_code, 200);
    }

    #[tokio::test]
    async fn default_content_type_is_applied_when_body_is_present_and_not_overridden() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/orders")
            .match_header("content-type", "application/json")
            .with_status(201)
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "POST".to_string(),
            url: format!("{}/orders", server.url()),
            headers: vec![],
            body: Some("{}".to_string()),
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert_eq!(result.status_code, 201);
    }

    #[tokio::test]
    async fn no_content_type_is_added_when_there_is_no_body() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/ping")
            .match_header("content-type", mockito::Matcher::Missing)
            .with_status(200)
            .with_body("pong")
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "GET".to_string(),
            url: format!("{}/ping", server.url()),
            headers: vec![],
            body: None,
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert_eq!(result.body, "pong");
    }

    #[tokio::test]
    async fn captures_response_headers() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/ping")
            .with_status(200)
            .with_header("x-request-id", "req_123")
            .with_body("pong")
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "GET".to_string(),
            url: format!("{}/ping", server.url()),
            headers: vec![],
            body: None,
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert!(result
            .headers
            .iter()
            .any(|h| h.key.eq_ignore_ascii_case("x-request-id") && h.value == "req_123"));
    }
}
