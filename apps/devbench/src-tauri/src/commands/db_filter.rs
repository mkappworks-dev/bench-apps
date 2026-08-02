use serde::Deserialize;

use crate::commands::db::validate_identifier;

/// Operators the grid offers. Serialised from the frontend in snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    Gt,
    Lt,
    Contains,
    StartsWith,
    IsNull,
    IsNotNull,
    IsTrue,
    IsFalse,
}

impl FilterOp {
    /// Whether this operator consumes a bound value. `IS NULL` and friends do
    /// not, and a condition using one is complete without any input.
    fn takes_value(self) -> bool {
        !matches!(
            self,
            FilterOp::IsNull | FilterOp::IsNotNull | FilterOp::IsTrue | FilterOp::IsFalse
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilterCondition {
    pub column: String,
    pub op: FilterOp,
    pub value: Option<String>,
    /// An unticked rule is kept by the UI but must not reach the query.
    pub enabled: bool,
}

pub struct CompiledFilter {
    /// Either empty, or a clause with a leading space: ` WHERE ...`.
    pub where_sql: String,
    pub params: Vec<String>,
}

/// `%` and `_` are LIKE syntax. A user typing them means the characters, so
/// they are escaped and the pattern declares its escape character.
fn escape_like(input: &str) -> String {
    input
        .replace('\\', r"\\")
        .replace('%', r"\%")
        .replace('_', r"\_")
}

/// Compiles conditions into a parameterised WHERE clause. `first_param_index`
/// is the number of the first `$n` placeholder this clause may use.
pub fn compile_filter(
    conditions: &[FilterCondition],
    first_param_index: usize,
) -> Result<CompiledFilter, String> {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();
    let mut next = first_param_index;

    for condition in conditions {
        if !condition.enabled {
            continue;
        }
        // An unfinished rule is inert rather than an error — the UI lets one
        // exist while the user is still typing it.
        if condition.op.takes_value() && condition.value.as_deref().unwrap_or("").is_empty() {
            continue;
        }
        validate_identifier(&condition.column)?;
        let column = format!("\"{}\"", condition.column);

        let clause = match condition.op {
            FilterOp::IsNull => format!("{column} IS NULL"),
            FilterOp::IsNotNull => format!("{column} IS NOT NULL"),
            FilterOp::IsTrue => format!("{column} IS TRUE"),
            FilterOp::IsFalse => format!("{column} IS FALSE"),
            FilterOp::Eq | FilterOp::Ne | FilterOp::Gt | FilterOp::Lt => {
                let operator = match condition.op {
                    FilterOp::Eq => "=",
                    FilterOp::Ne => "<>",
                    FilterOp::Gt => ">",
                    FilterOp::Lt => "<",
                    _ => unreachable!(),
                };
                params.push(condition.value.clone().unwrap_or_default());
                let clause = format!("{column} {operator} ${next}");
                next += 1;
                clause
            }
            FilterOp::Contains | FilterOp::StartsWith => {
                let value = condition.value.as_deref().unwrap_or("");
                let escaped = escape_like(value);
                let needs_escape = escaped != value;
                let pattern = if condition.op == FilterOp::Contains {
                    format!("%{escaped}%")
                } else {
                    format!("{escaped}%")
                };
                params.push(pattern);
                let clause = if needs_escape {
                    format!(r"{column} LIKE ${next} ESCAPE '\'")
                } else {
                    format!("{column} LIKE ${next}")
                };
                next += 1;
                clause
            }
        };
        clauses.push(clause);
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    Ok(CompiledFilter { where_sql, params })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cond(column: &str, op: FilterOp, value: Option<&str>) -> FilterCondition {
        FilterCondition {
            column: column.to_string(),
            op,
            value: value.map(|v| v.to_string()),
            enabled: true,
        }
    }

    #[test]
    fn no_conditions_compiles_to_no_clause() {
        let c = compile_filter(&[], 1).unwrap();
        assert_eq!(c.where_sql, "");
        assert!(c.params.is_empty());
    }

    // Values are bound, never interpolated: the compiled SQL must not contain
    // the user's value anywhere in it.
    #[test]
    fn a_value_is_bound_as_a_parameter_not_inlined() {
        let c = compile_filter(&[cond("status", FilterOp::Eq, Some("paid"))], 1).unwrap();
        assert_eq!(c.where_sql, " WHERE \"status\" = $1");
        assert_eq!(c.params, vec!["paid".to_string()]);
        assert!(!c.where_sql.contains("paid"));
    }

    #[test]
    fn conditions_are_and_joined_and_numbered_in_order() {
        let c = compile_filter(
            &[
                cond("status", FilterOp::Eq, Some("paid")),
                cond("notes", FilterOp::Contains, Some("rush")),
            ],
            1,
        )
        .unwrap();
        assert_eq!(c.where_sql, " WHERE \"status\" = $1 AND \"notes\" LIKE $2");
        assert_eq!(c.params, vec!["paid".to_string(), "%rush%".to_string()]);
    }

    // The caller may already have bound parameters (limit/offset), so numbering
    // has to start where they left off.
    #[test]
    fn parameter_numbering_starts_at_the_given_index() {
        let c = compile_filter(&[cond("status", FilterOp::Eq, Some("paid"))], 3).unwrap();
        assert_eq!(c.where_sql, " WHERE \"status\" = $3");
    }

    // A wildcard typed by the user is data, not syntax.
    #[test]
    fn like_wildcards_in_user_input_are_escaped() {
        let c = compile_filter(&[cond("notes", FilterOp::Contains, Some("50%_off"))], 1).unwrap();
        assert_eq!(c.params, vec![r"%50\%\_off%".to_string()]);
        assert!(c.where_sql.ends_with(r"LIKE $1 ESCAPE '\'"));
    }

    #[test]
    fn starts_with_anchors_the_pattern_at_the_front() {
        let c = compile_filter(&[cond("email", FilterOp::StartsWith, Some("ada"))], 1).unwrap();
        assert_eq!(c.params, vec!["ada%".to_string()]);
    }

    // Valueless operators take no parameter at all.
    #[test]
    fn valueless_operators_bind_nothing() {
        let c = compile_filter(
            &[cond("notes", FilterOp::IsNull, None), cond("paid", FilterOp::IsTrue, None)],
            1,
        )
        .unwrap();
        assert_eq!(c.where_sql, " WHERE \"notes\" IS NULL AND \"paid\" IS TRUE");
        assert!(c.params.is_empty());
    }

    // Mirrors the UI rule: a condition that needs a value and has none is
    // inert, so an unfinished rule cannot empty the grid.
    #[test]
    fn a_value_operator_with_no_value_is_skipped() {
        let c = compile_filter(
            &[cond("status", FilterOp::Eq, None), cond("paid", FilterOp::IsTrue, None)],
            1,
        )
        .unwrap();
        assert_eq!(c.where_sql, " WHERE \"paid\" IS TRUE");
    }

    #[test]
    fn a_disabled_condition_is_skipped() {
        let mut disabled = cond("status", FilterOp::Eq, Some("paid"));
        disabled.enabled = false;
        let c = compile_filter(&[disabled], 1).unwrap();
        assert_eq!(c.where_sql, "");
    }

    #[test]
    fn a_malicious_column_name_is_rejected() {
        let result = compile_filter(
            &[cond("id\"; DROP TABLE users; --", FilterOp::Eq, Some("1"))],
            1,
        );
        assert!(result.is_err(), "a column name is an identifier and must be validated");
    }
}
