use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};
use tauri::State;

use crate::commands::db::{get_column_type, validate_identifier_labeled};
use crate::commands::qualified_table::QualifiedTable;
use crate::connection_registry::ConnectionRegistry;
use crate::local_db::LocalDb;
use crate::secrets::SecretStore;

/// One staged intention. Ordered: Apply replays the set in staging order, so
/// an insert followed by an update of the same row behaves the way the user
/// watched it being built.
///
/// `table` is a `QualifiedTable`, not the plain string spec §10 sketches, for
/// the reason §10 itself gives for splitting a primary key into column and
/// value: a pre-joined string is a string that ends up interpolated into SQL.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PendingChange {
    Update {
        table: QualifiedTable,
        pk_column: String,
        pk_value: String,
        column: String,
        /// The value this edit was staged against. It travels into the WHERE
        /// so a row someone else moved matches nothing instead of being
        /// silently overwritten.
        old_value: Option<String>,
        new_value: Option<String>,
    },
    Insert {
        table: QualifiedTable,
        /// A JSON object on the wire. A BTreeMap rather than a HashMap so the
        /// generated column list and VALUES list are built from one
        /// deterministic iteration order and cannot drift apart.
        values: BTreeMap<String, Option<String>>,
    },
    Delete {
        table: QualifiedTable,
        pk_column: String,
        pk_value: String,
    },
    /// Staged from the query console (spec §12). No UI stages one in Slice 3;
    /// the variant exists because Apply must handle whatever the set holds,
    /// and a set that cannot represent it would have to change again in
    /// Slice 4. The statement is re-run here, inside the changeset
    /// transaction — `previewed_effect` is what the frontend displays
    /// alongside it so a divergence is visible rather than silent.
    Sql {
        table: Option<QualifiedTable>,
        statement: String,
        previewed_effect: String,
    },
}

/// A staged entry that no longer matches the database. Reported rather than
/// papered over: the alternative is overwriting someone else's write with a
/// value staged before it happened.
#[derive(Debug, Serialize, PartialEq)]
pub struct ConflictReport {
    /// Position in the submitted set, so the panel can mark the exact entry.
    pub index: usize,
    /// `public.orders` — for display only, never for SQL.
    pub table: String,
    /// `id = 42`, the row this entry targeted.
    pub description: String,
    /// `None` for a delete, which targets a row rather than a column.
    pub column: Option<String>,
    pub expected: Option<String>,
    pub found: Option<String>,
    /// The primary key matched no row at all — someone deleted it. Distinct
    /// from `found: None`, which means the row is there holding NULL.
    pub row_missing: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ApplyOutcome {
    /// Entries applied, not rows touched — it backs the "Apply 3" label.
    pub applied: usize,
    /// `Some(_)` means the transaction rolled back whole and `applied` is 0.
    pub conflict: Option<ConflictReport>,
}

/// Resolves a column's Postgres type for interpolation into a cast. The type
/// comes from the catalog rather than user input, but is validated anyway
/// before it reaches a format string — the same two-layer discipline the rest
/// of this codebase applies to identifiers.
async fn cast_type(
    pool: &PgPool,
    table: &QualifiedTable,
    column: &str,
    kind: &str,
) -> Result<String, String> {
    validate_identifier_labeled(kind, column)?;
    let ty = get_column_type(pool, table, column).await?;
    validate_identifier_labeled(&format!("{kind} type"), &ty)?;
    Ok(ty)
}

/// Reads a column's current value *inside the aborted transaction*, so the
/// conflict reports what this entry actually collided with — including any
/// earlier entry in the same set that already wrote to that cell.
/// `::text` is safe here in a way it would not be in a WHERE: the row is
/// already located by its primary key, so there is no index to defeat.
async fn read_current(
    tx: &mut Transaction<'_, Postgres>,
    table: &QualifiedTable,
    pk_column: &str,
    pk_type: &str,
    pk_value: &str,
    column: &str,
) -> (bool, Option<String>) {
    let sql = format!(
        "SELECT \"{column}\"::text AS v FROM {} WHERE \"{pk_column}\" = $1::{pk_type}",
        table.quoted()
    );
    match sqlx::query(&sql).bind(pk_value).fetch_optional(&mut **tx).await {
        Ok(Some(row)) => (false, row.try_get::<Option<String>, _>("v").ok().flatten()),
        // No row: the primary key matches nothing any more.
        Ok(None) => (true, None),
        // The read itself failed. Reporting "row missing" would be a claim
        // about the data that this call did not establish.
        Err(_) => (false, None),
    }
}

pub async fn apply_changes_impl(
    pool: &PgPool,
    changes: &[PendingChange],
) -> Result<ApplyOutcome, String> {
    let mut tx = pool.begin().await.map_err(|e| format!("failed to open a transaction: {e}"))?;
    let mut applied = 0usize;

    for (index, change) in changes.iter().enumerate() {
        match change {
            PendingChange::Update { table, pk_column, pk_value, column, old_value, new_value } => {
                let pk_type = cast_type(pool, table, pk_column, "pk column").await?;
                let col_type = cast_type(pool, table, column, "column").await?;

                let sql = format!(
                    "UPDATE {} SET \"{column}\" = $1::{col_type} \
                     WHERE \"{pk_column}\" = $2::{pk_type} \
                       AND \"{column}\" IS NOT DISTINCT FROM $3::{col_type}",
                    table.quoted()
                );
                let result = sqlx::query(&sql)
                    .bind(new_value.as_deref())
                    .bind(pk_value)
                    .bind(old_value.as_deref())
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("update on {table} failed: {e}"))?;

                if result.rows_affected() != 1 {
                    let (row_missing, found) =
                        read_current(&mut tx, table, pk_column, &pk_type, pk_value, column).await;
                    tx.rollback().await.ok();
                    return Ok(ApplyOutcome {
                        applied: 0,
                        conflict: Some(ConflictReport {
                            index,
                            table: table.to_string(),
                            description: format!("{pk_column} = {pk_value}"),
                            column: Some(column.clone()),
                            expected: old_value.clone(),
                            found,
                            row_missing,
                        }),
                    });
                }
                applied += 1;
            }

            PendingChange::Insert { table, values } => {
                if values.is_empty() {
                    return Err(format!("insert into {table} has no values"));
                }
                let mut names = Vec::with_capacity(values.len());
                let mut placeholders = Vec::with_capacity(values.len());
                let mut binds: Vec<Option<&str>> = Vec::with_capacity(values.len());
                for (position, (column, value)) in values.iter().enumerate() {
                    let col_type = cast_type(pool, table, column, "insert column").await?;
                    names.push(format!("\"{column}\""));
                    placeholders.push(format!("${}::{col_type}", position + 1));
                    binds.push(value.as_deref());
                }
                let sql = format!(
                    "INSERT INTO {} ({}) VALUES ({})",
                    table.quoted(),
                    names.join(", "),
                    placeholders.join(", ")
                );
                let mut query = sqlx::query(&sql);
                for bind in binds {
                    query = query.bind(bind);
                }
                query
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("insert into {table} failed: {e}"))?;
                applied += 1;
            }

            PendingChange::Delete { table, pk_column, pk_value } => {
                let pk_type = cast_type(pool, table, pk_column, "pk column").await?;
                let sql = format!(
                    "DELETE FROM {} WHERE \"{pk_column}\" = $1::{pk_type}",
                    table.quoted()
                );
                let result = sqlx::query(&sql)
                    .bind(pk_value)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("delete from {table} failed: {e}"))?;

                if result.rows_affected() != 1 {
                    tx.rollback().await.ok();
                    return Ok(ApplyOutcome {
                        applied: 0,
                        conflict: Some(ConflictReport {
                            index,
                            table: table.to_string(),
                            description: format!("{pk_column} = {pk_value}"),
                            column: None,
                            expected: None,
                            found: None,
                            row_missing: true,
                        }),
                    });
                }
                applied += 1;
            }

            // Re-run verbatim: the console previewed it in a transaction that
            // was rolled back, so this is the first time it runs for real.
            PendingChange::Sql { statement, .. } => {
                sqlx::query(statement)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("staged statement failed: {e}"))?;
                applied += 1;
            }
        }
    }

    tx.commit().await.map_err(|e| format!("commit failed: {e}"))?;
    Ok(ApplyOutcome { applied, conflict: None })
}

#[tauri::command]
pub async fn apply_changes(
    db: State<'_, LocalDb>,
    secrets: State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: State<'_, std::sync::Arc<ConnectionRegistry>>,
    connection_id: String,
    changes: Vec<PendingChange>,
) -> Result<ApplyOutcome, String> {
    let pool = registry.pool_for(&connection_id, &db.pool, secrets.as_ref()).await?;
    apply_changes_impl(&pool, &changes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each test module in this codebase builds its own pool (see db.rs,
    // db_columns.rs and correlation.rs); there is no shared helper to import.
    async fn test_pool() -> PgPool {
        let host = std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into());
        let database = std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into());
        let username = std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into());
        let password = std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into());
        let connection_string = crate::connection_registry::postgres_connection_string(
            &host, 5432, &database, &username, Some(&password), "disable",
        );
        sqlx::postgres::PgPoolOptions::new()
            .connect(&connection_string)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup")
    }

    fn public(name: &str) -> QualifiedTable {
        QualifiedTable::new("public", name).unwrap()
    }

    fn update(
        table: &str, pk_value: &str, column: &str,
        old_value: Option<&str>, new_value: Option<&str>,
    ) -> PendingChange {
        PendingChange::Update {
            table: public(table),
            pk_column: "id".into(),
            pk_value: pk_value.into(),
            column: column.into(),
            old_value: old_value.map(str::to_string),
            new_value: new_value.map(str::to_string),
        }
    }

    // Fixture names are unique per test on purpose: cargo runs these
    // concurrently against one shared database, so two tests sharing a table
    // name would race and fail intermittently.
    async fn fixture(pool: &PgPool, name: &str, columns: &str) {
        sqlx::query(&format!("DROP TABLE IF EXISTS {name}")).execute(pool).await.unwrap();
        sqlx::query(&format!("CREATE TABLE {name} ({columns})")).execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn commits_an_update_an_insert_and_a_delete_in_one_transaction() {
        let pool = test_pool().await;
        fixture(&pool, "apply_mixed", "id serial PRIMARY KEY, status text").await;
        sqlx::query("INSERT INTO apply_mixed (status) VALUES ('pending'), ('doomed')")
            .execute(&pool).await.unwrap();

        let outcome = apply_changes_impl(&pool, &[
            update("apply_mixed", "1", "status", Some("pending"), Some("shipped")),
            PendingChange::Insert {
                table: public("apply_mixed"),
                values: BTreeMap::from([("status".to_string(), Some("fresh".to_string()))]),
            },
            PendingChange::Delete {
                table: public("apply_mixed"),
                pk_column: "id".into(),
                pk_value: "2".into(),
            },
        ]).await.unwrap();

        assert_eq!(outcome, ApplyOutcome { applied: 3, conflict: None });

        let rows: Vec<(i32, Option<String>)> =
            sqlx::query_as("SELECT id, status FROM apply_mixed ORDER BY id")
                .fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![(1, Some("shipped".into())), (3, Some("fresh".into()))]);

        sqlx::query("DROP TABLE apply_mixed").execute(&pool).await.unwrap();
    }

    // The regression that motivated casting at all: sqlx binds every value as
    // TEXT, and Postgres has no assignment cast from text to integer or
    // boolean, so an uncast `SET "n" = $1` is a hard error on any column that
    // is not text. The retired single-preview cell-edit path had exactly this
    // bug and never tripped it: of its five tests, two rejected a malicious
    // identifier before reaching SQL at all, and the three that did issue an
    // UPDATE all edited a text column.
    #[tokio::test]
    async fn casts_values_for_non_text_columns() {
        let pool = test_pool().await;
        fixture(&pool, "apply_casts", "id serial PRIMARY KEY, n int4, flag bool").await;
        sqlx::query("INSERT INTO apply_casts (n, flag) VALUES (5, true)")
            .execute(&pool).await.unwrap();

        let outcome = apply_changes_impl(&pool, &[
            update("apply_casts", "1", "n", Some("5"), Some("7")),
            update("apply_casts", "1", "flag", Some("true"), Some("false")),
        ]).await.unwrap();

        assert_eq!(outcome.applied, 2);
        assert_eq!(outcome.conflict, None);

        let (n, flag): (i32, bool) = sqlx::query_as("SELECT n, flag FROM apply_casts WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!((n, flag), (7, false));

        sqlx::query("DROP TABLE apply_casts").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn reports_a_conflict_and_writes_nothing_when_the_stored_value_moved() {
        let pool = test_pool().await;
        fixture(&pool, "apply_conflict", "id serial PRIMARY KEY, status text").await;
        sqlx::query("INSERT INTO apply_conflict (status) VALUES ('moved_underneath')")
            .execute(&pool).await.unwrap();

        // The first entry would succeed on its own. It must still be rolled
        // back, because the conflicting second entry aborts the whole set.
        let outcome = apply_changes_impl(&pool, &[
            update("apply_conflict", "1", "status", Some("moved_underneath"), Some("first")),
            update("apply_conflict", "1", "status", Some("stale_expectation"), Some("second")),
        ]).await.unwrap();

        assert_eq!(outcome.applied, 0, "a conflict means nothing was written");
        let conflict = outcome.conflict.expect("the stale expectation must be reported");
        assert_eq!(conflict.index, 1);
        assert_eq!(conflict.column.as_deref(), Some("status"));
        assert_eq!(conflict.expected.as_deref(), Some("stale_expectation"));
        // Read back inside the aborted transaction: what the first entry had
        // already written, which is what the second entry actually collided with.
        assert_eq!(conflict.found.as_deref(), Some("first"));
        assert!(!conflict.row_missing);

        let status: Option<String> = sqlx::query_scalar("SELECT status FROM apply_conflict WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(status.as_deref(), Some("moved_underneath"), "the whole set rolled back");

        sqlx::query("DROP TABLE apply_conflict").execute(&pool).await.unwrap();
    }

    // `IS NOT DISTINCT FROM` rather than `=` exists for exactly this case: `=`
    // against NULL is NULL, never true, so every staged edit of a NULL cell
    // would match zero rows and report a conflict that did not happen.
    #[tokio::test]
    async fn stages_over_a_null_without_reporting_a_conflict() {
        let pool = test_pool().await;
        fixture(&pool, "apply_null_old", "id serial PRIMARY KEY, note text").await;
        sqlx::query("INSERT INTO apply_null_old (note) VALUES (NULL)")
            .execute(&pool).await.unwrap();

        let outcome = apply_changes_impl(&pool, &[
            update("apply_null_old", "1", "note", None, Some("written")),
        ]).await.unwrap();

        assert_eq!(outcome, ApplyOutcome { applied: 1, conflict: None });

        let note: Option<String> = sqlx::query_scalar("SELECT note FROM apply_null_old WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(note.as_deref(), Some("written"));

        sqlx::query("DROP TABLE apply_null_old").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn rolls_everything_back_when_one_entry_errors() {
        let pool = test_pool().await;
        fixture(&pool, "apply_atomic", "id serial PRIMARY KEY, status text NOT NULL").await;
        sqlx::query("INSERT INTO apply_atomic (status) VALUES ('before')")
            .execute(&pool).await.unwrap();

        // The second entry violates NOT NULL — a database error, not a
        // conflict, so it surfaces as Err rather than an ApplyOutcome.
        let result = apply_changes_impl(&pool, &[
            update("apply_atomic", "1", "status", Some("before"), Some("after")),
            update("apply_atomic", "1", "status", Some("after"), None),
        ]).await;
        assert!(result.is_err(), "a failing entry must fail the call, not be skipped");

        let status: String = sqlx::query_scalar("SELECT status FROM apply_atomic WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(status, "before", "the earlier entry must not survive the failure");

        sqlx::query("DROP TABLE apply_atomic").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn reports_a_missing_row_for_a_delete_that_matches_nothing() {
        let pool = test_pool().await;
        fixture(&pool, "apply_gone", "id serial PRIMARY KEY, status text").await;

        let outcome = apply_changes_impl(&pool, &[
            PendingChange::Delete {
                table: public("apply_gone"),
                pk_column: "id".into(),
                pk_value: "404".into(),
            },
        ]).await.unwrap();

        let conflict = outcome.conflict.expect("a delete matching no row is a conflict");
        assert!(conflict.row_missing);
        assert_eq!(conflict.column, None, "a delete targets a row, not a column");
        assert_eq!(outcome.applied, 0);

        sqlx::query("DROP TABLE apply_gone").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_a_malicious_column_before_it_reaches_sql() {
        let pool = test_pool().await;
        let result = apply_changes_impl(&pool, &[
            update("apply_never_created", "1", "status\" = 'x'; DROP TABLE users; --", Some("a"), Some("b")),
        ]).await;
        assert!(result.is_err(), "an invalid identifier must be rejected before interpolation");
    }
}
