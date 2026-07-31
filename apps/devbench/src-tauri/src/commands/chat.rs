use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

use crate::commands::mcp::{list_mcp_servers_impl, probe_server};
use crate::commands::settings::get_settings_impl;
use crate::local_db::LocalDb;
use crate::mcp_client::connect_stdio;
use crate::secrets::SecretStore;

const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Covers thinking AND response text on models where thinking is on by
/// default (Claude Opus 5) — sizing it tightly truncates mid-answer.
const MAX_TOKENS: u32 = 16_000;
/// Bounds the tool loop so a model that keeps calling tools cannot spin.
const MAX_TOOL_ITERATIONS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChatReply {
    pub content: String,
    /// Names of MCP tools invoked while producing this reply, so the UI can
    /// show what the assistant actually did rather than only what it said.
    pub tool_calls: Vec<String>,
}

const SYSTEM_PROMPT: &str = "You are DevBench's assistant. DevBench is a local-first developer \
workbench that correlates an HTTP request with the database rows it changed, the log lines it \
produced, and the mail it sent. Answer concisely and concretely about what the user is debugging.";

pub async fn send_chat_message_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    base_url: &str,
    messages: Vec<ChatMessage>,
) -> Result<ChatReply, String> {
    let settings = get_settings_impl(pool).await?;
    let api_key = secrets
        .get(&settings.provider)?
        .ok_or("No API key stored. Add one in Settings > Provider.")?;

    // Gather MCP tools. A broken server must not disable chat entirely — it
    // just contributes no tools, and the Settings > MCP status says why.
    let mut tool_defs: Vec<Value> = Vec::new();
    let mut tool_owner: std::collections::HashMap<String, _> = Default::default();
    for config in list_mcp_servers_impl(pool).await.unwrap_or_default() {
        if let Ok(tools) = probe_server(&config).await {
            for tool in tools {
                tool_defs.push(json!({
                    "name": tool.name,
                    "description": tool.description.unwrap_or_default(),
                    "input_schema": tool.input_schema,
                }));
                tool_owner.insert(tool.name, config.clone());
            }
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;

    let mut api_messages: Vec<Value> = messages
        .iter()
        .map(|m| json!({"role": m.role, "content": m.content}))
        .collect();
    let mut used_tools: Vec<String> = Vec::new();

    for _ in 0..MAX_TOOL_ITERATIONS {
        let mut body = json!({
            "model": settings.model,
            "max_tokens": MAX_TOKENS,
            // Effort is inside output_config, not top-level. `medium` keeps a
            // chat dock responsive; low/medium are strong on Claude Opus 5.
            "output_config": {"effort": "medium"},
            "system": SYSTEM_PROMPT,
            "messages": api_messages,
        });
        // NOTE: temperature / top_p / top_k are deliberately absent. They are
        // removed on Claude Opus 5 and sending any of them returns a 400.
        if !tool_defs.is_empty() {
            body["tools"] = json!(tool_defs);
        }

        let response = client
            .post(format!("{base_url}/v1/messages"))
            .header("x-api-key", &api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("chat request failed: {e}"))?;

        let status = response.status();
        let text = response.text().await.map_err(|e| format!("cannot read chat response: {e}"))?;
        if !status.is_success() {
            return Err(format!("provider returned {status}: {text}"));
        }
        let parsed: Value =
            serde_json::from_str(&text).map_err(|e| format!("cannot parse chat response: {e}"))?;

        // A refusal is an HTTP 200 with an empty content array. Checking
        // stop_reason BEFORE reading content is what keeps this from looking
        // like an empty successful reply.
        if parsed.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
            let category = parsed
                .get("stop_details")
                .and_then(|d| d.get("category"))
                .and_then(Value::as_str)
                .unwrap_or("unspecified");
            return Err(format!("The provider declined this request ({category})."));
        }

        let content = parsed.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
        let text_out: String = content
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");

        if parsed.get("stop_reason").and_then(Value::as_str) != Some("tool_use") {
            return Ok(ChatReply { content: text_out, tool_calls: used_tools });
        }

        // Echo the assistant turn back verbatim, then answer every tool_use
        // block in ONE user message — splitting them trains the model out of
        // parallel tool calls.
        api_messages.push(json!({"role": "assistant", "content": content}));
        let mut results: Vec<Value> = Vec::new();
        for block in content.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use")) {
            let name = block.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
            let id = block.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let input = block.get("input").cloned().unwrap_or_else(|| json!({}));

            let (text, is_error) = match tool_owner.get(&name) {
                Some(config) => match connect_stdio(&config.command, &config.args).await {
                    Ok((mut child, mut session)) => {
                        let outcome = async {
                            session.initialize().await?;
                            session.call_tool(&name, input).await
                        }
                        .await;
                        let _ = child.kill().await;
                        match outcome {
                            Ok(r) => (r.text, r.is_error),
                            Err(e) => (e, true),
                        }
                    }
                    Err(e) => (e, true),
                },
                None => (format!("no MCP server provides the tool `{name}`"), true),
            };
            used_tools.push(name);
            // A failed tool is returned as an error tool_result, never dropped:
            // omitting a result for a tool_use id makes the next request invalid.
            results.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": text,
                "is_error": is_error,
            }));
        }
        api_messages.push(json!({"role": "user", "content": results}));
    }

    Err(format!(
        "the assistant kept requesting tools after {MAX_TOOL_ITERATIONS} rounds — stopping"
    ))
}

#[tauri::command]
pub async fn send_chat_message(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
    messages: Vec<ChatMessage>,
) -> Result<ChatReply, String> {
    send_chat_message_impl(&db.pool, secrets.as_ref(), ANTHROPIC_BASE_URL, messages).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::provider::set_provider_api_key_impl;
    use crate::secrets::InMemorySecretStore;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    fn user(text: &str) -> Vec<ChatMessage> {
        vec![ChatMessage { role: "user".into(), content: text.into() }]
    }

    #[tokio::test]
    async fn refuses_to_send_without_a_stored_key() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let err = send_chat_message_impl(&db.pool, &secrets, "http://unused", user("hi"))
            .await
            .unwrap_err();
        assert!(err.contains("Settings > Provider"));
    }

    #[tokio::test]
    async fn sends_the_message_and_returns_the_text_reply() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant-test").await.unwrap();

        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/messages")
            .match_header("x-api-key", "sk-ant-test")
            .match_header("anthropic-version", ANTHROPIC_VERSION)
            .with_status(200)
            .with_body(r#"{"stop_reason":"end_turn","content":[{"type":"text","text":"Three rows changed."}]}"#)
            .create_async()
            .await;

        let reply = send_chat_message_impl(&db.pool, &secrets, &server.url(), user("what happened?"))
            .await
            .unwrap();
        mock.assert_async().await;
        assert_eq!(reply.content, "Three rows changed.");
        assert!(reply.tool_calls.is_empty());
    }

    // Sending any of these to Claude Opus 5 is a 400. This asserts the request
    // builder never includes them, rather than relying on nobody adding them.
    //
    // NOTE: this installed mockito (1.7.2) has no `Server::received_requests`
    // — that method does not exist on `ServerGuard` in this version. The body
    // is instead captured via `match_request`, whose closure runs against the
    // real `Request` for every incoming call; the captured bytes are then
    // parsed and asserted below, same as the request-inspection the brief
    // called for.
    #[tokio::test]
    async fn never_sends_sampling_parameters() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant-test").await.unwrap();

        let captured_body: std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>> = Default::default();
        let captured_for_matcher = std::sync::Arc::clone(&captured_body);

        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/messages")
            .match_request(move |request| {
                if let Ok(body) = request.body() {
                    *captured_for_matcher.lock().unwrap() = Some(body.clone());
                }
                true
            })
            .with_status(200)
            .with_body(r#"{"stop_reason":"end_turn","content":[{"type":"text","text":"ok"}]}"#)
            .create_async()
            .await;

        send_chat_message_impl(&db.pool, &secrets, &server.url(), user("hi")).await.unwrap();
        mock.assert_async().await;

        let sent = captured_body.lock().unwrap().clone().expect("request body was captured");
        let body: Value = serde_json::from_slice(&sent).unwrap();
        assert_eq!(body["model"], "claude-opus-5");
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("top_k").is_none());
        assert_eq!(body["output_config"]["effort"], "medium");
    }

    // HTTP 200 + empty content. Reading content[0] blindly would look like an
    // empty successful reply.
    #[tokio::test]
    async fn a_refusal_becomes_a_readable_error_not_an_empty_reply() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant-test").await.unwrap();

        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(r#"{"stop_reason":"refusal","stop_details":{"category":"cyber"},"content":[]}"#)
            .create_async()
            .await;

        let err = send_chat_message_impl(&db.pool, &secrets, &server.url(), user("hi"))
            .await
            .unwrap_err();
        assert!(err.contains("declined"));
        assert!(err.contains("cyber"));
    }

    #[tokio::test]
    async fn a_provider_error_surfaces_its_body() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant-test").await.unwrap();

        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/v1/messages")
            .with_status(401)
            .with_body(r#"{"error":{"message":"invalid x-api-key"}}"#)
            .create_async()
            .await;

        let err = send_chat_message_impl(&db.pool, &secrets, &server.url(), user("hi"))
            .await
            .unwrap_err();
        assert!(err.contains("401"));
        assert!(err.contains("invalid x-api-key"));
    }
}
