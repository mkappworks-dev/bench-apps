use serde::Serialize;

/// One observed log line. `captured_at_ms` is DevBench's own clock at the
/// moment the bytes were read — correlation windows are bounded by this, NOT
/// by `timestamp`, which comes from the target backend and may be skewed,
/// missing, or in a format we do not parse.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LogLine {
    pub id: u64,
    pub source_id: String,
    pub captured_at_ms: i64,
    pub timestamp: Option<String>,
    pub level: Option<String>,
    pub message: String,
    pub raw: String,
}

/// The parsed-out fields of a single raw line, before it is given an id and a
/// capture timestamp.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLine {
    pub timestamp: Option<String>,
    pub level: Option<String>,
    pub message: String,
}

/// Maps a numeric log level to a name. These are the `pino` / Bunyan numeric
/// levels, which are what a large share of Node backends emit; without this,
/// every line from such a backend would render with a level of "30".
fn numeric_level_name(n: i64) -> Option<&'static str> {
    match n {
        0..=14 => Some("TRACE"),
        15..=24 => Some("DEBUG"),
        25..=34 => Some("INFO"),
        35..=44 => Some("WARN"),
        45..=54 => Some("ERROR"),
        _ => Some("FATAL"),
    }
}

fn level_from_value(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.to_uppercase()),
        serde_json::Value::Number(n) => n.as_i64().and_then(numeric_level_name).map(str::to_string),
        _ => None,
    }
}

fn first_string<'a>(obj: &'a serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<&'a serde_json::Value> {
    keys.iter().find_map(|k| obj.get(*k))
}

/// Parses one raw line. A JSON object line has its well-known fields lifted
/// out; anything else (plain text, a JSON array, malformed JSON) is kept
/// verbatim as the message with no level and no timestamp.
pub fn parse_log_line(raw: &str) -> ParsedLine {
    let fallback = ParsedLine {
        timestamp: None,
        level: None,
        message: raw.to_string(),
    };

    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return fallback,
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => return fallback,
    };

    let message = first_string(obj, &["msg", "message", "text"])
        .and_then(|v| match v {
            serde_json::Value::String(s) => Some(s.clone()),
            other => Some(other.to_string()),
        })
        .unwrap_or_else(|| raw.to_string());

    let level = first_string(obj, &["level", "severity", "lvl"]).and_then(level_from_value);

    let timestamp = first_string(obj, &["time", "timestamp", "ts", "@timestamp"]).map(|v| match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    });

    ParsedLine { timestamp, level, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_pino_style_json_line_with_a_numeric_level() {
        let parsed = parse_log_line(
            r#"{"level":30,"time":"2026-07-30T14:02:11.482Z","msg":"order created id=8841"}"#,
        );
        assert_eq!(parsed.level.as_deref(), Some("INFO"));
        assert_eq!(parsed.timestamp.as_deref(), Some("2026-07-30T14:02:11.482Z"));
        assert_eq!(parsed.message, "order created id=8841");
    }

    #[test]
    fn parses_a_string_level_and_uppercases_it() {
        let parsed = parse_log_line(r#"{"level":"warn","message":"inventory low"}"#);
        assert_eq!(parsed.level.as_deref(), Some("WARN"));
        assert_eq!(parsed.message, "inventory low");
        assert_eq!(parsed.timestamp, None);
    }

    #[test]
    fn keeps_plain_text_verbatim_with_no_level() {
        let parsed = parse_log_line("2026-07-30 14:02:11 starting server on :3000");
        assert_eq!(parsed.level, None);
        assert_eq!(parsed.timestamp, None);
        assert_eq!(parsed.message, "2026-07-30 14:02:11 starting server on :3000");
    }

    #[test]
    fn treats_malformed_json_as_plain_text_rather_than_dropping_it() {
        let raw = r#"{"level":"info","msg":"truncated mid-writ"#;
        let parsed = parse_log_line(raw);
        assert_eq!(parsed.level, None);
        assert_eq!(parsed.message, raw);
    }

    #[test]
    fn falls_back_to_the_whole_line_when_a_json_object_has_no_known_message_field() {
        let raw = r#"{"unexpected":"shape"}"#;
        let parsed = parse_log_line(raw);
        assert_eq!(parsed.message, raw);
    }
}
