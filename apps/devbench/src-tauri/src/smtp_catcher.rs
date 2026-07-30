use mailin_embedded::response::{self, Response};
use mailin_embedded::{Handler, Server, SslConfig};
use std::io;
use std::net::{IpAddr, TcpListener};
use std::sync::{Arc, Mutex};

use crate::email_state::EmailStore;

/// Ceiling on one captured message. Checked INSIDE `Handler::data`, which is
/// called once per received chunk — the same bounded-incremental shape as
/// `fire_request`'s streamed response reader, never buffer-then-check.
pub const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;

/// Binds the catcher's socket. Done separately from `serve` so a port
/// conflict (Mailhog or Mailpit already running) surfaces as an ordinary
/// `Result` at app startup, per the v1 spec's error-handling requirement.
/// `serve` blocks forever and could not report this.
pub fn bind(port: u16) -> Result<TcpListener, String> {
    // 127.0.0.1, never 0.0.0.0: a local-first tool must not expose an open
    // mail relay-shaped listener to the network.
    TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        format!("SMTP port {port} is unavailable ({e}) — another catcher (Mailhog/Mailpit) may be running")
    })
}

/// Runs the SMTP server. BLOCKS FOREVER — call on a dedicated thread.
pub fn serve(listener: TcpListener, store: Arc<Mutex<EmailStore>>) -> Result<(), String> {
    let handler = CatcherHandler::new(store);
    let mut server = Server::new(handler);
    server
        .with_name("devbench")
        // No STARTTLS: this is a loopback catcher for a developer's own
        // backend. TLS here would add a certificate to manage and secure
        // nothing that is not already inside the machine's trust boundary.
        .with_ssl(SslConfig::None)
        .map_err(|e| format!("failed to configure SMTP server: {e}"))?;
    server.with_tcp_listener(listener);
    server.serve().map_err(|e| format!("SMTP server stopped: {e}"))
}

/// `mailin-embedded` CLONES the handler once per connection, so the envelope
/// and body fields below are naturally per-connection state; only `store` is
/// shared. That is exactly the isolation a per-session accumulator needs.
#[derive(Clone)]
pub struct CatcherHandler {
    store: Arc<Mutex<EmailStore>>,
    from: String,
    to: Vec<String>,
    data: Vec<u8>,
    overflowed: bool,
}

impl CatcherHandler {
    pub fn new(store: Arc<Mutex<EmailStore>>) -> Self {
        Self { store, from: String::new(), to: Vec::new(), data: Vec::new(), overflowed: false }
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
        // Accept every recipient: a catcher's job is to catch, not to route.
        // The authoritative recipient list arrives in `data_start`.
        response::OK
    }

    fn data_start(&mut self, _domain: &str, from: &str, _is8bit: bool, to: &[String]) -> Response {
        // The SMTP ENVELOPE, which is what the backend actually addressed the
        // message to — including Bcc recipients, which never appear in headers.
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
        // Budget checked per chunk, before appending — a hostile or runaway
        // sender can never make us allocate past the cap.
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
        // Lossy: a message can legitimately carry 8-bit bytes in a charset we
        // do not decode. Dropping it would under-report what the backend sent,
        // which principle 4 forbids; replacement characters are honest.
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let captured_at_ms = chrono::Utc::now().timestamp_millis();

        match self.store.lock() {
            Ok(mut store) => {
                store.push(&self.from, &self.to, &raw, captured_at_ms);
                response::OK
            }
            // A poisoned mutex means a previous panic. Rejecting is better than
            // silently accepting a message we cannot store: the sending backend
            // sees a failure it can log, rather than DevBench claiming zero mail.
            Err(_) => response::INTERNAL_ERROR,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email_state::MAX_INBOX_MESSAGES;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;

    /// Reads SMTP reply lines until one has a space (not '-') after the code,
    /// which is how a multiline EHLO reply terminates.
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

    fn start_catcher() -> (u16, Arc<Mutex<EmailStore>>) {
        let store = Arc::new(Mutex::new(EmailStore::new(MAX_INBOX_MESSAGES)));
        // Port 0 lets the OS pick a free one, so tests never collide with a
        // real Mailhog on 1025 or with each other under `cargo test`.
        let listener = bind(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let store_for_server = Arc::clone(&store);
        std::thread::spawn(move || {
            let _ = serve(listener, store_for_server);
        });
        (port, store)
    }

    fn wait_for_messages(store: &Arc<Mutex<EmailStore>>, want: usize) {
        for _ in 0..100 {
            if store.lock().unwrap().list(10).len() >= want {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("timed out waiting for {want} captured message(s)");
    }

    #[test]
    fn catches_a_message_sent_by_a_plain_smtp_client() {
        let (port, store) = start_catcher();

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

        wait_for_messages(&store, 1);
        let guard = store.lock().unwrap();
        let listed = guard.list(10);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].from, "orders@shop.test");
        assert_eq!(listed[0].to, vec!["customer@example.com".to_string()]);
        assert_eq!(listed[0].subject, "Order confirmation #8841");

        let full = guard.get(listed[0].id).unwrap();
        assert!(full.text_body.unwrap().contains("Thanks for your order"));
        assert!(full.raw.contains("Subject: Order confirmation #8841"));
    }

    #[test]
    fn captures_the_envelope_recipient_even_when_it_is_absent_from_the_headers() {
        let (port, store) = start_catcher();

        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);

        let _ = read_reply(&mut reader);
        write!(writer, "EHLO tester\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "MAIL FROM:<orders@shop.test>\r\n").unwrap();
        let _ = read_reply(&mut reader);
        // A Bcc recipient: present in the envelope, deliberately absent from
        // the headers. Parsing `To:` would silently lose it.
        write!(writer, "RCPT TO:<audit@shop.test>\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "DATA\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "Subject: Receipt\r\nTo: customer@example.com\r\n\r\nbody\r\n.\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "QUIT\r\n").unwrap();

        wait_for_messages(&store, 1);
        let guard = store.lock().unwrap();
        assert_eq!(guard.list(10)[0].to, vec!["audit@shop.test".to_string()]);
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

    #[test]
    fn data_rejects_a_message_past_the_size_cap_without_buffering_it() {
        let store = Arc::new(Mutex::new(EmailStore::new(MAX_INBOX_MESSAGES)));
        let mut handler = CatcherHandler::new(Arc::clone(&store));
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
        assert_eq!(store.lock().unwrap().list(10).len(), 0, "an overflowed message is not stored");
    }
}
