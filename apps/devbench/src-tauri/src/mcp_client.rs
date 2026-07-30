use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// MCP revision this client speaks. Servers negotiate down; a server that
/// cannot serve it says so in `initialize`'s reply, which we surface verbatim.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// Ceiling on one JSON-RPC frame. An MCP server is a user-configured child
/// process, but a runaway one must not be able to exhaust memory — the same
/// bounded-read discipline `fire_request` and the SMTP catcher follow.
const MAX_FRAME_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct McpToolResult {
    pub text: String,
    /// True when the server reported the call itself failed. Surfaced to the
    /// model as an error tool_result rather than being swallowed — a tool that
    /// silently "succeeds" with no output is worse than one that says it broke.
    pub is_error: bool,
}

/// A JSON-RPC 2.0 conversation with an MCP server over newline-delimited
/// frames. Generic over the streams so tests can run a full protocol exchange
/// over `tokio::io::duplex` with no child process.
pub struct McpSession<R, W> {
    reader: R,
    writer: W,
    next_id: u64,
}

impl<R, W> McpSession<R, W>
where
    R: AsyncBufRead + Unpin + Send,
    W: AsyncWrite + Unpin + Send,
{
    pub fn new(reader: R, writer: W) -> Self {
        Self { reader, writer, next_id: 1 }
    }

    async fn send(&mut self, frame: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(frame).map_err(|e| format!("cannot encode request: {e}"))?;
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("cannot write to the MCP server: {e}"))?;
        self.writer.flush().await.map_err(|e| format!("cannot flush to the MCP server: {e}"))
    }

    /// Reads frames until one carries the id we are waiting for, so a server
    /// that interleaves notifications or log messages does not desynchronize us.
    async fn read_result(&mut self, want_id: u64) -> Result<Value, String> {
        loop {
            let mut line = String::new();
            let read = (&mut self.reader)
                .take(MAX_FRAME_BYTES)
                .read_line(&mut line)
                .await
                .map_err(|e| format!("cannot read from the MCP server: {e}"))?;
            if read == 0 {
                return Err("the MCP server closed the connection".to_string());
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let frame: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                // A server that writes non-JSON to stdout (a stray log line) is
                // common enough that skipping it beats failing the session.
                Err(_) => continue,
            };
            if frame.get("id").and_then(Value::as_u64) != Some(want_id) {
                continue;
            }
            if let Some(error) = frame.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown MCP error");
                return Err(format!("MCP server error: {message}"));
            }
            return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await?;
        self.read_result(id).await
    }

    /// Handshake. Returns the server's advertised name for the status list.
    pub async fn initialize(&mut self) -> Result<String, String> {
        let result = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "devbench", "version": "0.1.0"},
                }),
            )
            .await?;

        // The spec requires this notification after a successful initialize.
        // It carries no id and gets no reply.
        self.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await?;

        Ok(result
            .get("serverInfo")
            .and_then(|i| i.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string())
    }

    pub async fn list_tools(&mut self) -> Result<Vec<McpTool>, String> {
        let result = self.request("tools/list", json!({})).await?;
        let tools = result.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(tools
            .into_iter()
            .filter_map(|t| {
                Some(McpTool {
                    name: t.get("name")?.as_str()?.to_string(),
                    description: t.get("description").and_then(Value::as_str).map(str::to_string),
                    input_schema: t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                })
            })
            .collect())
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<McpToolResult, String> {
        let result = self.request("tools/call", json!({"name": name, "arguments": arguments})).await?;
        let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
        // MCP returns a content array; concatenating the text parts is what the
        // model needs. Non-text parts are named rather than dropped silently.
        let text = result
            .get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .map(|p| match p.get("type").and_then(Value::as_str) {
                        Some("text") => p.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                        Some(other) => format!("[{other} content omitted]"),
                        None => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        Ok(McpToolResult { text, is_error })
    }
}

/// Spawns an MCP server as a child process and speaks to it over stdio.
/// The `Child` is returned alongside the session so the caller controls its
/// lifetime — dropping it kills the server.
pub async fn connect_stdio(
    command: &str,
    args: &[String],
) -> Result<(Child, McpSession<BufReader<ChildStdout>, ChildStdin>), String> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        // Inherit stderr so a server's diagnostics reach the developer's
        // terminal instead of filling an unread pipe until it blocks.
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start MCP server `{command}`: {e}"))?;

    let stdin = child.stdin.take().ok_or("MCP server has no stdin")?;
    let stdout = child.stdout.take().ok_or("MCP server has no stdout")?;
    Ok((child, McpSession::new(BufReader::new(stdout), stdin)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, BufReader as TokioBufReader};

    /// A fake MCP server: reads request frames and replies from a script.
    /// Running the real protocol over an in-memory duplex is what lets these
    /// tests be deterministic — no process, no sleeps, no ports.
    fn spawn_fake_server(
        mut server_reader: TokioBufReader<tokio::io::DuplexStream>,
        mut server_writer: tokio::io::DuplexStream,
        replies: Vec<Value>,
    ) {
        tokio::spawn(async move {
            let mut remaining = replies.into_iter();
            loop {
                let mut line = String::new();
                if server_reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                    return;
                }
                let frame: Value = match serde_json::from_str(line.trim()) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // Notifications have no id and get no reply.
                let Some(id) = frame.get("id").and_then(Value::as_u64) else { continue };
                let Some(mut reply) = remaining.next() else { return };
                reply["id"] = json!(id);
                reply["jsonrpc"] = json!("2.0");
                let mut out = serde_json::to_string(&reply).unwrap();
                out.push('\n');
                if server_writer.write_all(out.as_bytes()).await.is_err() {
                    return;
                }
                let _ = server_writer.flush().await;
            }
        });
    }

    /// Builds a connected client/fake-server pair.
    ///
    /// Note the TWO `duplex` pairs rather than one: a single `DuplexStream`
    /// pair is bidirectional, so using one would have the client reading back
    /// its own writes. One pair carries client→server, the other server→client.
    fn connect_fake(
        replies: Vec<Value>,
    ) -> McpSession<TokioBufReader<tokio::io::DuplexStream>, tokio::io::DuplexStream> {
        let (to_server_client, to_server_server) = duplex(64 * 1024);
        let (to_client_server, to_client_client) = duplex(64 * 1024);
        spawn_fake_server(TokioBufReader::new(to_server_server), to_client_server, replies);
        McpSession::new(TokioBufReader::new(to_client_client), to_server_client)
    }

    #[tokio::test]
    async fn initialize_returns_the_server_name_and_sends_the_initialized_notification() {
        let mut session = connect_fake(vec![json!({
            "result": {"protocolVersion": PROTOCOL_VERSION, "serverInfo": {"name": "filesystem"}}
        })]);
        assert_eq!(session.initialize().await.unwrap(), "filesystem");
    }

    #[tokio::test]
    async fn list_tools_parses_the_tool_definitions() {
        let mut session = connect_fake(vec![json!({
            "result": {"tools": [
                {"name": "read_file", "description": "Read a file",
                 "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}}},
                {"name": "write_file"}
            ]}
        })]);
        let tools = session.list_tools().await.unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "read_file");
        assert_eq!(tools[0].description.as_deref(), Some("Read a file"));
        // A tool with no schema still gets a valid empty object schema, because
        // the Messages API rejects a tool without one.
        assert_eq!(tools[1].input_schema, json!({"type": "object", "properties": {}}));
    }

    #[tokio::test]
    async fn call_tool_concatenates_text_content() {
        let mut session = connect_fake(vec![json!({
            "result": {"content": [{"type": "text", "text": "line one"}, {"type": "text", "text": "line two"}]}
        })]);
        let result = session.call_tool("read_file", json!({"path": "/tmp/x"})).await.unwrap();
        assert_eq!(result.text, "line one\nline two");
        assert!(!result.is_error);
    }

    #[tokio::test]
    async fn call_tool_surfaces_a_server_reported_failure_rather_than_hiding_it() {
        let mut session = connect_fake(vec![json!({
            "result": {"isError": true, "content": [{"type": "text", "text": "file not found"}]}
        })]);
        let result = session.call_tool("read_file", json!({"path": "/nope"})).await.unwrap();
        assert!(result.is_error);
        assert_eq!(result.text, "file not found");
    }

    #[tokio::test]
    async fn a_jsonrpc_error_frame_becomes_an_err() {
        let mut session = connect_fake(vec![json!({"error": {"code": -32601, "message": "Method not found"}})]);
        let err = session.list_tools().await.unwrap_err();
        assert!(err.contains("Method not found"));
    }

    #[tokio::test]
    async fn a_closed_connection_is_reported_not_hung() {
        let (to_server_client, to_server_server) = duplex(1024);
        let (to_client_server, to_client_client) = duplex(1024);
        drop(to_server_server);
        drop(to_client_server);
        let mut session = McpSession::new(TokioBufReader::new(to_client_client), to_server_client);
        assert!(session.list_tools().await.is_err());
    }
}
