use serde::{Deserialize, Serialize};

use crate::commands::db::validate_identifier_labeled;

/// A schema-qualified table. Fields are private and the only constructor
/// validates both identifiers, so an unvalidated `QualifiedTable` cannot
/// exist anywhere in the process — including one that arrived over IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "QualifiedTableWire")]
pub struct QualifiedTable {
    schema: String,
    name: String,
}

impl QualifiedTable {
    pub fn new(schema: &str, name: &str) -> Result<Self, String> {
        validate_identifier_labeled("schema name", schema)?;
        validate_identifier_labeled("table name", name)?;
        Ok(Self { schema: schema.to_string(), name: name.to_string() })
    }

    /// `"public"."orders"` — the only path by which a table reaches SQL.
    pub fn quoted(&self) -> String {
        format!("\"{}\".\"{}\"", self.schema, self.name)
    }

    pub fn schema(&self) -> &str {
        &self.schema
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

/// The wire shape, deserialized then funnelled through `new` so validation
/// cannot be bypassed by populating fields directly.
#[derive(Deserialize)]
struct QualifiedTableWire {
    schema: String,
    name: String,
}

impl TryFrom<QualifiedTableWire> for QualifiedTable {
    type Error = String;

    fn try_from(wire: QualifiedTableWire) -> Result<Self, Self::Error> {
        QualifiedTable::new(&wire.schema, &wire.name)
    }
}

impl std::fmt::Display for QualifiedTable {
    /// Unquoted `public.orders`, for error messages — never for SQL.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.schema, self.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_both_parts_separately() {
        let t = QualifiedTable::new("public", "orders").unwrap();
        assert_eq!(t.quoted(), "\"public\".\"orders\"");
    }

    #[test]
    fn exposes_its_parts() {
        let t = QualifiedTable::new("alt", "orders").unwrap();
        assert_eq!(t.schema(), "alt");
        assert_eq!(t.name(), "orders");
    }

    // The schema is new attack surface: before this type existed, nothing
    // validated it because nothing carried it.
    #[test]
    fn rejects_an_injection_payload_in_the_schema() {
        let result = QualifiedTable::new("public\"; DROP TABLE users; --", "orders");
        assert!(result.is_err(), "a schema is an identifier and must be validated");
    }

    #[test]
    fn rejects_an_injection_payload_in_the_name() {
        let result = QualifiedTable::new("public", "orders\"; DROP TABLE users; --");
        assert!(result.is_err());
    }

    // The error must name which half was wrong, or the reader checks the
    // wrong input.
    #[test]
    fn names_the_offending_part_in_the_error() {
        let err = QualifiedTable::new("bad-schema", "orders").unwrap_err();
        assert!(err.contains("schema"), "expected the error to name the schema, got: {err}");

        let err = QualifiedTable::new("public", "bad-table").unwrap_err();
        assert!(err.contains("table"), "expected the error to name the table, got: {err}");
    }

    #[test]
    fn rejects_empty_parts() {
        assert!(QualifiedTable::new("", "orders").is_err());
        assert!(QualifiedTable::new("public", "").is_err());
    }

    // `#[serde(try_from = "...")]` only governs Deserialize; Serialize is a
    // separate derive reading the struct's own private fields directly. This
    // proves the two didn't drift into different wire shapes.
    #[test]
    fn serializes_to_the_same_shape_it_deserializes_from() {
        let t = QualifiedTable::new("public", "orders").unwrap();
        assert_eq!(serde_json::to_string(&t).unwrap(), r#"{"schema":"public","name":"orders"}"#);
    }

    // Deserialization is the real boundary. A plain derive would let the
    // frontend populate the fields directly and skip validation entirely,
    // which would make the type's guarantee fiction.
    #[test]
    fn deserializing_runs_the_validating_constructor() {
        let ok: Result<QualifiedTable, _> =
            serde_json::from_str(r#"{"schema":"public","name":"orders"}"#);
        assert_eq!(ok.unwrap().quoted(), "\"public\".\"orders\"");

        let bad: Result<QualifiedTable, _> =
            serde_json::from_str(r#"{"schema":"public","name":"orders\"; DROP TABLE users; --"}"#);
        assert!(bad.is_err(), "an invalid identifier must fail deserialization");
    }
}
