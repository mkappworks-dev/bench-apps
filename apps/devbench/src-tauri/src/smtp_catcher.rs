use mailin_embedded::response::{self, Response};
use mailin_embedded::{Handler, Server, SslConfig};
use sqlx::SqlitePool;
use std::io;
use std::net::{IpAddr, TcpListener};

use crate::email_state::insert_captured_email;

/// Ceiling on one captured message. Checked INSIDE `Handler::data`.
pub const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;

/// Binds the catcher's socket, separately from `serve`, so a port conflict
/// surfaces as an ordinary `Result` at app startup.
pub fn bind(port: u16) -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        format!("SMTP port {port} is unavailable ({e}) — another catcher (Mailhog/Mailpit) may be running")
    })
}

/// Runs the SMTP server. BLOCKS FOREVER — call on a dedicated thread.
pub fn serve(listener: TcpListener, pool: SqlitePool) -> Result<(), String> {
    let handler = CatcherHandler::new(pool);
    let mut server = Server::new(handler);
    server
        .with_name("devbench")
        .with_ssl(SslConfig::None)
        .map_err(|e| format!("failed to configure SMTP server: {e}"))?;
    server.with_tcp_listener(listener);
    server.serve().map_err(|e| format!("SMTP server stopped: {e}"))
}

#[derive(Clone)]
pub struct CatcherHandler {
    pool: SqlitePool,
    from: String,
    to: Vec<String>,
    data: Vec<u8>,
    overflowed: bool,
}

impl CatcherHandler {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool, from: String::new(), to: Vec::new(), data: Vec::new(), overflowed: false }
    }
}

impl Handler for CatcherHandler {
    fn helo(&mut self, _ip: IpAddr, _domain: &str) -> Response {
        response::OK
    }

    fn mail(&mut self, _ip: IpAddr, _domain: &str, from: &str) -> Response {
        self.from = from.to_string();
        response::OK
    }

    fn rcpt(&mut self, _to: &str) -> Response {
        response::OK
    }

    fn data_start(&mut self, _domain: &str, from: &str, _is8bit: bool, to: &[String]) -> Response {
        self.from = from.to_string();
        self.to = to.to_vec();
        self.data.clear();
        self.overflowed = false;
        response::OK
    }

    fn data(&mut self, buf: &[u8]) -> io::Result<()> {
        if self.overflowed {
            return Ok(());
        }
        if self.data.len() + buf.len() > MAX_MESSAGE_BYTES {
            self.overflowed = true;
            self.data.clear();
            self.data.shrink_to_fit();
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("message exceeds the {MAX_MESSAGE_BYTES}-byte limit"),
            ));
        }
        self.data.extend_from_slice(buf);
        Ok(())
    }

    fn data_end(&mut self) -> Response {
        if self.overflowed {
            return response::INTERNAL_ERROR;
        }
        let bytes = std::mem::take(&mut self.data);
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let captured_at_ms = chrono::Utc::now().timestamp_millis();

        // `mailin-embedded` calls every Handler method synchronously from
        // this blocking OS thread. `insert_captured_email` is async (it goes
        // through the SQLite pool), so this bridges exactly the way
        // `main.rs`'s synchronous `.setup()` closure already bridges to
        // async for `LocalDb::connect` — `tauri::async_runtime::block_on`
        // manages its own runtime independently of the caller's, so it
        // works from a foreign, non-tokio thread like this one.
        match tauri::async_runtime::block_on(insert_captured_email(
            &self.pool,
            &self.from,
            &self.to,
            &raw,
            captured_at_ms,
        )) {
            Ok(()) => response::OK,
            // A failed write is better rejected than silently dropped: the
            // sending backend sees a failure it can log, rather than
            // DevBench claiming zero mail.
            Err(_) => response::INTERNAL_ERROR,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email_state::{get_captured_email, list_captured_emails};
    use crate::local_db::LocalDb;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;

    fn read_reply(reader: &mut BufReader<TcpStream>) -> String {
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).unwrap();
            if n == 0 {
                return String::new();
            }
            if line.len() >= 4 && line.as_bytes()[3] == b' ' {
                return line;
            }
        }
    }

    async fn start_catcher() -> (u16, tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let pool = db.pool.clone();
        let listener = bind(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pool_for_server = pool.clone();
        std::thread::spawn(move || {
            let _ = serve(listener, pool_for_server);
        });
        (port, dir, pool)
    }

    async fn wait_for_messages(pool: &SqlitePool, want: usize) {
        for _ in 0..100 {
            if list_captured_emails(pool, None, 10).await.unwrap().emails.len() >= want {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("timed out waiting for {want} captured message(s)");
    }

    #[tokio::test]
    async fn catches_a_message_sent_by_a_plain_smtp_client() {
        let (port, _dir, pool) = start_catcher().await;

        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);

        assert!(read_reply(&mut reader).starts_with("220"));
        write!(writer, "EHLO tester\r\n").unwrap();
        assert!(read_reply(&mut reader).starts_with("250"));
        write!(writer, "MAIL FROM:<orders@shop.test>\r\n").unwrap();
        assert!(read_reply(&mut reader).starts_with("250"));
        write!(writer, "RCPT TO:<customer@example.com>\r\n").unwrap();
        assert!(read_reply(&mut reader).starts_with("250"));
        write!(writer, "DATA\r\n").unwrap();
        assert!(read_reply(&mut reader).starts_with("354"));
        write!(
            writer,
            "Subject: Order confirmation #8841\r\nFrom: orders@shop.test\r\n\r\nThanks for your order, Jamie.\r\n.\r\n"
        )
        .unwrap();
        assert!(read_reply(&mut reader).starts_with("250"));
        write!(writer, "QUIT\r\n").unwrap();
        let _ = read_reply(&mut reader);

        wait_for_messages(&pool, 1).await;
        let listed = list_captured_emails(&pool, None, 10).await.unwrap().emails;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].from, "orders@shop.test");
        assert_eq!(listed[0].to, vec!["customer@example.com".to_string()]);
        assert_eq!(listed[0].subject, "Order confirmation #8841");

        let full = get_captured_email(&pool, listed[0].id).await.unwrap().unwrap();
        assert!(full.text_body.unwrap().contains("Thanks for your order"));
        assert!(full.raw.contains("Subject: Order confirmation #8841"));
    }

    #[tokio::test]
    async fn captures_the_envelope_recipient_even_when_it_is_absent_from_the_headers() {
        let (port, _dir, pool) = start_catcher().await;

        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);

        let _ = read_reply(&mut reader);
        write!(writer, "EHLO tester\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "MAIL FROM:<orders@shop.test>\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "RCPT TO:<audit@shop.test>\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "DATA\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "Subject: Receipt\r\nTo: customer@example.com\r\n\r\nbody\r\n.\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "QUIT\r\n").unwrap();

        wait_for_messages(&pool, 1).await;
        let listed = list_captured_emails(&pool, None, 10).await.unwrap().emails;
        assert_eq!(listed[0].to, vec!["audit@shop.test".to_string()]);
    }

    #[test]
    fn bind_reports_a_clear_error_when_the_port_is_already_taken() {
        let first = bind(0).unwrap();
        let port = first.local_addr().unwrap().port();
        let second = bind(port);
        assert!(second.is_err());
        let message = second.unwrap_err();
        assert!(message.contains(&port.to_string()));
        assert!(message.contains("Mailhog"), "the error must tell the user what to look for");
    }

    #[tokio::test]
    async fn data_rejects_a_message_past_the_size_cap_without_buffering_it() {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let mut handler = CatcherHandler::new(db.pool.clone());
        handler.data_start("tester", "a@x.test", false, &["b@y.test".to_string()]);

        let chunk = vec![b'x'; 1024 * 1024];
        let mut rejected_at = None;
        for i in 0..20 {
            if handler.data(&chunk).is_err() {
                rejected_at = Some(i);
                break;
            }
        }
        assert!(rejected_at.is_some(), "an oversized message must be rejected");
        assert!(rejected_at.unwrap() <= 10, "rejection must happen at the cap, not after 20 MiB");

        handler.data_end();
        assert_eq!(
            list_captured_emails(&db.pool, None, 10).await.unwrap().emails.len(),
            0,
            "an overflowed message is not stored"
        );
    }
}
