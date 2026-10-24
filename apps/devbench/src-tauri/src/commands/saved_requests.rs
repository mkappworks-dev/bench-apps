use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use tauri::State;
use crate::local_db::LocalDb;

fn enabled_default() -> bool { true }
fn body_type_default() -> String { "none".into() }
fn auth_default() -> Value { serde_json::json!({"type":"none"}) }

// Storage rows remember unchecked headers; the request wire type stays HeaderPair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedHeaderRow {
    pub key: String,
    pub value: String,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SavedRequestInput {
    pub name: String,
    pub session_id: Option<String>,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<SavedHeaderRow>,
    pub body: Option<String>,
    #[serde(default = "body_type_default")]
    pub body_type: String,
    // Auth is an opaque saved definition. Only the frontend compiles it for sending.
    #[serde(default = "auth_default")]
    pub auth: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SavedRequest {
    pub id: String,
    pub name: String,
    pub session_id: Option<String>,
    pub method: String,
    pub url: String,
    pub headers: Vec<SavedHeaderRow>,
    pub body: Option<String>,
    pub body_type: String,
    pub auth: Value,
    pub created_at: String,
    pub updated_at: String,
}

const SELECT: &str = "SELECT id,name,session_id,method,url,headers,body,body_type,auth,created_at,updated_at FROM saved_requests";

fn read_row(row: sqlx::sqlite::SqliteRow) -> Result<SavedRequest, String> {
    Ok(SavedRequest {
        id: row.get("id"), name: row.get("name"), session_id: row.get("session_id"),
        method: row.get("method"), url: row.get("url"), body: row.get("body"),
        body_type: row.get("body_type"), created_at: row.get("created_at"), updated_at: row.get("updated_at"),
        headers: serde_json::from_str(&row.get::<String, _>("headers")).map_err(|e| format!("invalid saved headers: {e}"))?,
        auth: serde_json::from_str(&row.get::<String, _>("auth")).map_err(|e| format!("invalid saved auth: {e}"))?,
    })
}

async fn get(pool: &SqlitePool, id: &str) -> Result<SavedRequest, String> {
    let row = sqlx::query(&format!("{SELECT} WHERE id = ?")).bind(id).fetch_optional(pool).await
        .map_err(|e| format!("failed to read saved request: {e}"))?
        .ok_or_else(|| format!("no saved request with id {id}"))?;
    read_row(row)
}

fn validate(input: &mut SavedRequestInput) -> Result<(), String> {
    input.name = input.name.trim().to_string();
    if input.name.is_empty() { return Err("a saved request needs a name".into()); }
    if !matches!(input.body_type.as_str(), "none" | "json" | "text") { return Err("invalid saved request body type".into()); }
    if !input.auth.is_object() { return Err("saved request auth must be an object".into()); }
    Ok(())
}

pub async fn list_saved_requests_impl(pool: &SqlitePool, session_id: Option<&str>) -> Result<Vec<SavedRequest>, String> {
    let rows = match session_id {
        Some(id) => sqlx::query(&format!("{SELECT} WHERE session_id = ? ORDER BY updated_at DESC, id")).bind(id).fetch_all(pool).await,
        None => sqlx::query(&format!("{SELECT} ORDER BY updated_at DESC, id")).fetch_all(pool).await,
    }.map_err(|e| format!("failed to list saved requests: {e}"))?;
    rows.into_iter().map(read_row).collect()
}

pub async fn create_saved_request_impl(pool: &SqlitePool, mut input: SavedRequestInput) -> Result<SavedRequest, String> {
    validate(&mut input)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO saved_requests (id,name,session_id,method,url,headers,body,body_type,auth,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&id).bind(&input.name).bind(&input.session_id).bind(&input.method).bind(&input.url)
        .bind(serde_json::to_string(&input.headers).map_err(|e| e.to_string())?).bind(&input.body).bind(&input.body_type)
        .bind(input.auth.to_string()).bind(&now).bind(&now).execute(pool).await
        .map_err(|e| format!("failed to create saved request: {e}"))?;
    get(pool, &id).await
}

pub async fn update_saved_request_impl(pool: &SqlitePool, id: &str, mut input: SavedRequestInput) -> Result<SavedRequest, String> {
    validate(&mut input)?;
    let result = sqlx::query("UPDATE saved_requests SET name=?,session_id=?,method=?,url=?,headers=?,body=?,body_type=?,auth=?,updated_at=? WHERE id=?")
        .bind(&input.name).bind(&input.session_id).bind(&input.method).bind(&input.url)
        .bind(serde_json::to_string(&input.headers).map_err(|e| e.to_string())?).bind(&input.body).bind(&input.body_type)
        .bind(input.auth.to_string()).bind(Utc::now().to_rfc3339()).bind(id).execute(pool).await
        .map_err(|e| format!("failed to update saved request: {e}"))?;
    if result.rows_affected() == 0 { return Err(format!("no saved request with id {id}")); }
    get(pool, id).await
}

pub async fn rename_saved_request_impl(pool: &SqlitePool, id: &str, name: &str) -> Result<SavedRequest, String> {
    let name = name.trim();
    if name.is_empty() { return Err("a saved request needs a name".into()); }
    let result = sqlx::query("UPDATE saved_requests SET name=?,updated_at=? WHERE id=?")
        .bind(name).bind(Utc::now().to_rfc3339()).bind(id).execute(pool).await
        .map_err(|e| format!("failed to rename saved request: {e}"))?;
    if result.rows_affected() == 0 { return Err(format!("no saved request with id {id}")); }
    get(pool, id).await
}

pub async fn delete_saved_request_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query("DELETE FROM saved_requests WHERE id=?").bind(id).execute(pool).await
        .map_err(|e| format!("failed to delete saved request: {e}"))?;
    if result.rows_affected() == 0 { return Err(format!("no saved request with id {id}")); }
    Ok(())
}

#[tauri::command]
pub async fn list_saved_requests(db: State<'_, LocalDb>, session_id: Option<String>) -> Result<Vec<SavedRequest>, String> {
    list_saved_requests_impl(&db.pool, session_id.as_deref()).await
}
#[tauri::command]
pub async fn create_saved_request(db: State<'_, LocalDb>, input: SavedRequestInput) -> Result<SavedRequest, String> {
    create_saved_request_impl(&db.pool, input).await
}
#[tauri::command]
pub async fn update_saved_request(db: State<'_, LocalDb>, id: String, input: SavedRequestInput) -> Result<SavedRequest, String> {
    update_saved_request_impl(&db.pool, &id, input).await
}
#[tauri::command]
pub async fn rename_saved_request(db: State<'_, LocalDb>, id: String, name: String) -> Result<SavedRequest, String> {
    rename_saved_request_impl(&db.pool, &id, &name).await
}
#[tauri::command]
pub async fn delete_saved_request(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    delete_saved_request_impl(&db.pool, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_db::LocalDb;
    use crate::commands::sessions::{create_session_impl, delete_session_impl};
    use serde_json::json;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    fn input(name: &str, session_id: Option<String>) -> SavedRequestInput {
        SavedRequestInput {
            name: name.into(), session_id, method: "POST".into(), url: "/orders?a=1&a=2".into(),
            headers: vec![SavedHeaderRow { key: "X-Debug".into(), value: "yes".into(), enabled: false }],
            body: Some("{\"a\":1}".into()), body_type: "json".into(),
            auth: json!({"type":"apikey","keyName":"key","keyValue":"secret","keyIn":"query"}),
        }
    }

    #[tokio::test]
    async fn saved_snapshot_round_trips_and_updates_in_place() {
        let (_dir, db) = db().await;
        let made = create_saved_request_impl(&db.pool, input("  Orders  ", None)).await.unwrap();
        assert_eq!(made.name, "Orders");
        assert_eq!(made.headers[0].enabled, false);
        assert_eq!(made.body.as_deref(), Some("{\"a\":1}"));
        assert_eq!(made.auth["keyValue"], "secret");
        assert_eq!(list_saved_requests_impl(&db.pool, None).await.unwrap(), vec![made.clone()]);
        let mut edited = input("Updated", None);
        edited.url = "/orders?status=paid".into();
        edited.headers[0].enabled = true;
        edited.body_type = "none".into();
        let updated = update_saved_request_impl(&db.pool, &made.id, edited).await.unwrap();
        assert_eq!(updated.id, made.id);
        assert_eq!(updated.created_at, made.created_at);
        assert_eq!(updated.url, "/orders?status=paid");
        assert!(updated.headers[0].enabled);
        assert_eq!(updated.body.as_deref(), Some("{\"a\":1}"), "None preserves the stored body draft");
        assert_eq!(list_saved_requests_impl(&db.pool, None).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn rename_only_touches_name_and_update_time_and_delete_removes_the_row() {
        let (_dir, db) = db().await;
        let made = create_saved_request_impl(&db.pool, input("Orders", None)).await.unwrap();
        let renamed = rename_saved_request_impl(&db.pool, &made.id, "  Checkout  ").await.unwrap();
        let mut expected = made.clone();
        expected.name = "Checkout".into();
        expected.updated_at = renamed.updated_at.clone();
        assert_eq!(renamed, expected);
        delete_saved_request_impl(&db.pool, &made.id).await.unwrap();
        assert!(list_saved_requests_impl(&db.pool, None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn named_sessions_are_isolated_and_unscoped_lists_every_definition() {
        let (_dir, db) = db().await;
        let a = create_session_impl(&db.pool, "A", None).await.unwrap();
        let b = create_session_impl(&db.pool, "B", None).await.unwrap();
        let first = create_saved_request_impl(&db.pool, input("First", Some(a.id.clone()))).await.unwrap();
        let second = create_saved_request_impl(&db.pool, input("Second", Some(b.id.clone()))).await.unwrap();
        let third = create_saved_request_impl(&db.pool, input("Third", None)).await.unwrap();
        assert_eq!(list_saved_requests_impl(&db.pool, Some(&a.id)).await.unwrap(), vec![first.clone()]);
        assert_eq!(list_saved_requests_impl(&db.pool, Some(&b.id)).await.unwrap(), vec![second.clone()]);
        sqlx::query("UPDATE saved_requests SET updated_at = '2000-01-01T00:00:00Z'").execute(&db.pool).await.unwrap();
        let before = list_saved_requests_impl(&db.pool, None).await.unwrap();
        assert_eq!(before.len(), 3);
        let mut ids: Vec<_> = before.iter().map(|r| r.id.clone()).collect();
        let mut sorted = ids.clone(); sorted.sort();
        assert_eq!(ids, sorted, "equal timestamps have stable ID ordering");
        rename_saved_request_impl(&db.pool, &first.id, "Moved first").await.unwrap();
        ids = list_saved_requests_impl(&db.pool, None).await.unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids[0], first.id);
        assert!(ids.contains(&second.id) && ids.contains(&third.id));
    }

    #[tokio::test]
    async fn deleting_a_session_keeps_definitions_and_nulls_their_scope() {
        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Investigation", None).await.unwrap();
        let made = create_saved_request_impl(&db.pool, input("Orders", Some(session.id.clone()))).await.unwrap();
        delete_session_impl(&db.pool, &session.id).await.unwrap();
        let all = list_saved_requests_impl(&db.pool, None).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, made.id);
        assert_eq!(all[0].session_id, None);
        assert_eq!(all[0].headers, made.headers);
        assert_eq!(all[0].auth, made.auth);
    }

    #[tokio::test]
    async fn missing_ids_and_invalid_names_report_errors_without_creating_rows() {
        let (_dir, db) = db().await;
        assert!(create_saved_request_impl(&db.pool, input("  ", None)).await.is_err());
        assert!(update_saved_request_impl(&db.pool, "missing", input("Valid", None)).await.is_err());
        assert!(rename_saved_request_impl(&db.pool, "missing", "Name").await.is_err());
        assert!(delete_saved_request_impl(&db.pool, "missing").await.is_err());
        let made = create_saved_request_impl(&db.pool, input("Valid", None)).await.unwrap();
        assert!(rename_saved_request_impl(&db.pool, &made.id, " ").await.is_err());
        let mut invalid = input("Name", None); invalid.body_type = "binary".into();
        assert!(update_saved_request_impl(&db.pool, &made.id, invalid).await.is_err());
        assert_eq!(list_saved_requests_impl(&db.pool, None).await.unwrap(), vec![made]);
    }

    #[tokio::test]
    async fn migration_0010_preserves_existing_history_and_creates_no_params_column() {
        use sqlx::{migrate::Migration, sqlite::SqlitePoolOptions, Row};
        use std::borrow::Cow;
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}?mode=rwc", dir.path().join("devbench.db").display());
        let legacy = SqlitePoolOptions::new().max_connections(1).connect(&url).await.unwrap();
        let mut migrator = sqlx::migrate!("./migrations");
        let earlier: Vec<Migration> = migrator.migrations.iter().filter(|m| m.version < 10).cloned().collect();
        assert_eq!(earlier.len(), 9);
        migrator.migrations = Cow::Owned(earlier);
        migrator.run(&legacy).await.unwrap();
        sqlx::query("INSERT INTO request_history (id,method,url,status_code,response_body,duration_ms,fired_at) VALUES ('legacy','GET','/legacy',200,'{}',1,'2000-01-01')").execute(&legacy).await.unwrap();
        legacy.close().await;
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        assert!(list_saved_requests_impl(&db.pool, None).await.unwrap().is_empty());
        assert_eq!(crate::commands::history::list_history_impl(&db.pool, None).await.unwrap()[0].url, "/legacy");
        let columns = sqlx::query("PRAGMA table_info(saved_requests)").fetch_all(&db.pool).await.unwrap();
        assert!(!columns.iter().any(|row| row.get::<String, _>("name") == "params"));
    }
}
