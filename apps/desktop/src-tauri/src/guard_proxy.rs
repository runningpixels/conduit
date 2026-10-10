//! A loopback CONNECT proxy for the main webview's own loads (Windows).
//!
//! The main WebView2 is built with a proxy (`webview_args`): that is what
//! closes WebRTC's TCP path, since WebRTC may then only leave through the
//! proxy. That proxy used to accept nothing, so the webview loaded nothing
//! remote except origins on the artifact remote allowlist (the bypass list).
//!
//! A page the reader gave full web access (ADR-007) loads scripts, images,
//! fonts and media straight from https sites, so those loads need a proxy that
//! answers. This one is deliberately narrow:
//!
//! * `CONNECT` only (an https tunnel; the proxy never sees the content), to
//!   port 443 only;
//! * the name is resolved here and the tunnel pinned to the checked address,
//!   which must be public — the same check as the fetch bridge
//!   ([`artifact_network::resolve_checked`]) — so no load reaches the reader's
//!   machine or network through it, DNS rebinding included;
//! * only while a page with full web access is on screen (the `gate`): with
//!   none open, it refuses everything, exactly like the old dead proxy, so the
//!   WebRTC lockdown is unchanged for every other page;
//! * a cap on open tunnels.
//!
//! Loopback itself never goes through a proxy in Chromium, so the app's own
//! dev server and schemes are unaffected.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

use crate::artifact_network::{self, AddressPolicy};

/// Longest a client may take to send its request line and headers.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest the upstream connection may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest request head read before giving up.
const MAX_HEAD_BYTES: usize = 8 * 1024;
/// Tunnels open at once.
const MAX_TUNNELS: usize = 128;
/// The only port a tunnel may reach in the app.
const HTTPS_PORT: u16 = 443;

/// Whether a full-access page is open right now (tunnels allowed at all).
pub type Gate = Arc<dyn Fn() -> bool + Send + Sync>;

/// Bind the proxy to an ephemeral loopback port. Synchronous so the port is
/// known before the webview is built; [`serve`] takes the listener.
pub fn bind() -> std::io::Result<std::net::TcpListener> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// Accept connections until the listener fails.
pub async fn serve(listener: std::net::TcpListener, gate: Gate, policy: AddressPolicy) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        return;
    };
    let tunnels = Arc::new(Semaphore::new(MAX_TUNNELS));
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            // Out of sockets or similar: back off rather than spin.
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let Ok(permit) = tunnels.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let gate = gate.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = handle(stream, gate, policy).await;
        });
    }
}

/// Why a CONNECT was refused, as the status line sent back.
#[derive(Debug, PartialEq, Eq)]
enum Refusal {
    BadRequest,
    MethodNotAllowed,
    Forbidden,
    BadGateway,
}

impl Refusal {
    fn status_line(&self) -> &'static str {
        match self {
            Refusal::BadRequest => "HTTP/1.1 400 Bad Request",
            Refusal::MethodNotAllowed => "HTTP/1.1 405 Method Not Allowed",
            Refusal::Forbidden => "HTTP/1.1 403 Forbidden",
            Refusal::BadGateway => "HTTP/1.1 502 Bad Gateway",
        }
    }
}

async fn handle(mut client: TcpStream, gate: Gate, policy: AddressPolicy) -> std::io::Result<()> {
    let head = match tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut client)).await {
        Ok(Ok(Some(head))) => head,
        _ => return refuse(&mut client, Refusal::BadRequest).await,
    };
    let (host, port) = match parse_connect(&head) {
        Ok(target) => target,
        Err(refusal) => return refuse(&mut client, refusal).await,
    };
    if !gate() || !target_allowed(&host, port, policy) {
        return refuse(&mut client, Refusal::Forbidden).await;
    }
    let addr: SocketAddr = match artifact_network::resolve_checked(&host, port, policy).await {
        Ok(addr) => addr,
        Err(_) => return refuse(&mut client, Refusal::Forbidden).await,
    };
    let mut upstream = match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
        Ok(Ok(stream)) => stream,
        _ => return refuse(&mut client, Refusal::BadGateway).await,
    };
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

async fn refuse(client: &mut TcpStream, refusal: Refusal) -> std::io::Result<()> {
    let response = format!(
        "{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        refusal.status_line()
    );
    client.write_all(response.as_bytes()).await?;
    client.shutdown().await
}

/// Read up to the blank line that ends the request head. `None` when the
/// client closed early or the head is too large. Bytes past the head (a
/// client that starts TLS before the 200) are not expected and are dropped.
async fn read_head(client: &mut TcpStream) -> std::io::Result<Option<String>> {
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 1024];
    loop {
        let n = client.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            buf.truncate(end);
            return Ok(String::from_utf8(buf).ok());
        }
        if buf.len() > MAX_HEAD_BYTES {
            return Ok(None);
        }
    }
}

/// `CONNECT host:port HTTP/1.x` → `(host, port)`, the host lowercased and an
/// IPv6 literal without its brackets.
fn parse_connect(head: &str) -> Result<(String, u16), Refusal> {
    let line = head.lines().next().ok_or(Refusal::BadRequest)?;
    let mut parts = line.split(' ');
    let (method, target, version) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(t), Some(v), None) => (m, t, v),
        _ => return Err(Refusal::BadRequest),
    };
    if !version.starts_with("HTTP/1.") {
        return Err(Refusal::BadRequest);
    }
    if method != "CONNECT" {
        return Err(Refusal::MethodNotAllowed);
    }
    let (host, port) = target.rsplit_once(':').ok_or(Refusal::BadRequest)?;
    let port: u16 = port.parse().map_err(|_| Refusal::BadRequest)?;
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
        .to_ascii_lowercase();
    let valid = !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    if !valid {
        return Err(Refusal::BadRequest);
    }
    Ok((host, port))
}

/// The port and name checks made before resolving: https's port only, and no
/// name that is this machine or the local network by definition.
fn target_allowed(host: &str, port: u16, policy: AddressPolicy) -> bool {
    if !policy.public_only {
        return true;
    }
    port == HTTPS_PORT
        && host != "localhost"
        && !host.ends_with(".localhost")
        && !host.ends_with(".local")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn parses_connect_lines_and_refuses_everything_else() {
        assert_eq!(
            parse_connect("CONNECT cdnjs.cloudflare.com:443 HTTP/1.1\r\nHost: x"),
            Ok(("cdnjs.cloudflare.com".to_string(), 443))
        );
        assert_eq!(
            parse_connect("CONNECT [2606:4700::1]:443 HTTP/1.1"),
            Ok(("2606:4700::1".to_string(), 443))
        );
        assert_eq!(
            parse_connect("CONNECT Example.COM:8443 HTTP/1.0"),
            Ok(("example.com".to_string(), 8443))
        );
        assert_eq!(
            parse_connect("GET http://example.com/ HTTP/1.1"),
            Err(Refusal::MethodNotAllowed)
        );
        for bad in [
            "",
            "CONNECT example.com HTTP/1.1",
            "CONNECT example.com:https HTTP/1.1",
            "CONNECT example.com:443 SPDY/3",
            "CONNECT exa mple.com:443 HTTP/1.1",
            "CONNECT ex/ample.com:443 HTTP/1.1",
            "CONNECT :443 HTTP/1.1",
        ] {
            assert_eq!(parse_connect(bad), Err(Refusal::BadRequest), "{bad:?}");
        }
    }

    #[test]
    fn only_https_port_to_names_that_are_not_local() {
        let app = AddressPolicy::APP;
        assert!(target_allowed("cdnjs.cloudflare.com", 443, app));
        assert!(!target_allowed("cdnjs.cloudflare.com", 80, app));
        assert!(!target_allowed("cdnjs.cloudflare.com", 3478, app));
        assert!(!target_allowed("localhost", 443, app));
        assert!(!target_allowed("app.localhost", 443, app));
        assert!(!target_allowed("printer.local", 443, app));
    }

    async fn exchange(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; 256];
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf))
            .await
            .unwrap()
            .unwrap();
        String::from_utf8_lossy(&buf[..n]).to_string()
    }

    fn start(gate: Gate, policy: AddressPolicy) -> u16 {
        let listener = bind().unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve(listener, gate, policy));
        port
    }

    #[tokio::test]
    async fn refuses_private_targets_and_everything_while_no_full_page_is_open() {
        let open = Arc::new(AtomicBool::new(false));
        let flag = open.clone();
        let port = start(
            Arc::new(move || flag.load(Ordering::SeqCst)),
            AddressPolicy::APP,
        );
        // Gate closed: refused before any lookup, like the old dead proxy.
        let reply = exchange(port, "CONNECT example.com:443 HTTP/1.1\r\n\r\n").await;
        assert!(reply.starts_with("HTTP/1.1 403"), "{reply}");

        open.store(true, Ordering::SeqCst);
        for target in [
            "127.0.0.1:443",
            "10.0.0.1:443",
            "[::1]:443",
            "localhost:443",
        ] {
            let reply = exchange(port, &format!("CONNECT {target} HTTP/1.1\r\n\r\n")).await;
            assert!(reply.starts_with("HTTP/1.1 403"), "{target}: {reply}");
        }
        let reply = exchange(port, "CONNECT 1.1.1.1:80 HTTP/1.1\r\n\r\n").await;
        assert!(reply.starts_with("HTTP/1.1 403"), "{reply}");
        let reply = exchange(port, "GET http://example.com/ HTTP/1.1\r\n\r\n").await;
        assert!(reply.starts_with("HTTP/1.1 405"), "{reply}");
    }

    #[tokio::test]
    async fn tunnels_bytes_both_ways_once_allowed() {
        // A local echo server stands in for a site; the test policy allows
        // loopback, which the app's policy never does.
        let echo = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = echo.accept().await.unwrap();
            let mut buf = [0u8; 64];
            let n = s.read(&mut buf).await.unwrap();
            s.write_all(&buf[..n]).await.unwrap();
        });
        let port = start(Arc::new(|| true), AddressPolicy { public_only: false });

        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(format!("CONNECT 127.0.0.1:{echo_port} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut buf = vec![0u8; 64];
        let n = stream.read(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"));
        stream.write_all(b"ping").await.unwrap();
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf[..n], b"ping");
    }
}
