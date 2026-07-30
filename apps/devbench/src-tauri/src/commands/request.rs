use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Deserialize)]
pub struct FireRequestInput {
    pub method: String,
    pub url: String,
    pub body: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FireRequestOutput {
    pub status_code: u16,
    pub body: String,
    pub duration_ms: u64,
}

pub async fn fire_request_impl(input: FireRequestInput) -> Result<FireRequestOutput, String> {
    let client = reqwest::Client::new();
    let method: reqwest::Method = input
        .method
        .parse()
        .map_err(|e| format!("invalid method '{}': {e}", input.method))?;
    let mut req = client.request(method, &input.url);
    if let Some(body) = &input.body {
        req = req.header("content-type", "application/json").body(body.clone());
    }

    let started = Instant::now();
    let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status_code = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| format!("failed to read response body: {e}"))?;
    let duration_ms = started.elapsed().as_millis() as u64;

    Ok(FireRequestOutput { status_code, body, duration_ms })
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
            body: None,
        })
        .await;

        assert!(result.is_err());
    }
}
