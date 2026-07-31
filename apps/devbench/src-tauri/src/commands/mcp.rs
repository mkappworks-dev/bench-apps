use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::State;
use uuid::Uuid;

use crate::local_db::LocalDb;
use crate::mcp_client::{connect_stdio, McpTool};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct McpServerStatus {
    pub config: McpServerConfig,
    /// "connected" | "error" | "unchecked"
    pub state: String,
    pub error: Option<String>,
    pub tool_count: usize,
}

pub async fn list_mcp_servers_impl(pool: &SqlitePool) -> Result<Vec<McpServerConfig>, String> {
    let rows = sqlx::query("SELECT id, name, command, args FROM mcp_servers ORDER BY name")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to list MCP servers: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| McpServerConfig {
            id: r.get("id"),
            name: r.get("name"),
            command: r.get("command"),
            // A corrupt args column degrades to "no args" rather than making
            // the whole list unreadable.
            args: serde_json::from_str(&r.get::<String, _>("args")).unwrap_or_default(),
        })
        .collect())
}

pub async fn add_mcp_server_impl(
    pool: &SqlitePool,
    name: &str,
    command: &str,
    args: &[String],
) -> Result<McpServerConfig, String> {
    let (name, command) = (name.trim(), command.trim());
    if name.is_empty() || command.is_empty() {
        return Err("an MCP server needs a name and a command".to_string());
    }
    let config = McpServerConfig {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        command: command.to_string(),
        args: args.to_vec(),
    };
    sqlx::query("INSERT INTO mcp_servers (id, name, command, args, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&config.id)
        .bind(&config.name)
        .bind(&config.command)
        .bind(serde_json::to_string(&config.args).unwrap_or_else(|_| "[]".to_string()))
        .bind(Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                format!("an MCP server named `{name}` already exists")
            } else {
                format!("failed to add MCP server: {e}")
            }
        })?;
    Ok(config)
}

pub async fn remove_mcp_server_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query("DELETE FROM mcp_servers WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to remove MCP server: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("no MCP server with id {id}"));
    }
    Ok(())
}

/// Spawns the server, handshakes, lists its tools, then shuts it down.
/// Used both by the Settings status check and by the chat tool loop.
pub async fn probe_server(config: &McpServerConfig) -> Result<Vec<McpTool>, String> {
    let (mut child, mut session) = connect_stdio(&config.command, &config.args).await?;
    let result = async {
        session.initialize().await?;
        session.list_tools().await
    }
    .await;
    // kill_on_drop is set, but being explicit means a failed probe does not
    // leave a process alive until the Child value happens to be dropped.
    let _ = child.kill().await;
    result
}

#[tauri::command]
pub async fn list_mcp_servers(db: State<'_, LocalDb>) -> Result<Vec<McpServerConfig>, String> {
    list_mcp_servers_impl(&db.pool).await
}

#[tauri::command]
pub async fn add_mcp_server(
    db: State<'_, LocalDb>,
    name: String,
    command: String,
    args: Vec<String>,
) -> Result<McpServerConfig, String> {
    add_mcp_server_impl(&db.pool, &name, &command, &args).await
}

#[tauri::command]
pub async fn remove_mcp_server(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    remove_mcp_server_impl(&db.pool, &id).await
}

#[tauri::command]
pub async fn check_mcp_server(db: State<'_, LocalDb>, id: String) -> Result<McpServerStatus, String> {
    let config = list_mcp_servers_impl(&db.pool)
        .await?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("no MCP server with id {id}"))?;
    Ok(match probe_server(&config).await {
        Ok(tools) => McpServerStatus {
            config,
            state: "connected".to_string(),
            error: None,
            tool_count: tools.len(),
        },
        Err(e) => McpServerStatus { config, state: "error".to_string(), error: Some(e), tool_count: 0 },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn adds_and_lists_a_server_with_its_args() {
        let (_dir, db) = db().await;
        add_mcp_server_impl(&db.pool, "filesystem", "npx", &["@mcp/server-filesystem".into()])
            .await
            .unwrap();
        let listed = list_mcp_servers_impl(&db.pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].command, "npx");
        assert_eq!(listed[0].args, vec!["@mcp/server-filesystem".to_string()]);
    }

    #[tokio::test]
    async fn rejects_a_duplicate_name_with_a_readable_message() {
        let (_dir, db) = db().await;
        add_mcp_server_impl(&db.pool, "fs", "npx", &[]).await.unwrap();
        let err = add_mcp_server_impl(&db.pool, "fs", "other", &[]).await.unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[tokio::test]
    async fn rejects_a_blank_name_or_command() {
        let (_dir, db) = db().await;
        assert!(add_mcp_server_impl(&db.pool, "  ", "npx", &[]).await.is_err());
        assert!(add_mcp_server_impl(&db.pool, "fs", "  ", &[]).await.is_err());
    }

    #[tokio::test]
    async fn removing_reports_an_unknown_id() {
        let (_dir, db) = db().await;
        assert!(remove_mcp_server_impl(&db.pool, "nope").await.is_err());
    }

    // A command that does not exist must surface as an error status, not a
    // panic and not a server that silently reports zero tools.
    #[tokio::test]
    async fn probing_a_nonexistent_command_is_a_readable_error() {
        let config = McpServerConfig {
            id: "x".into(),
            name: "broken".into(),
            command: "definitely-not-a-real-binary-xyz".into(),
            args: vec![],
        };
        let err = probe_server(&config).await.unwrap_err();
        assert!(err.contains("cannot start MCP server"));
    }
}
