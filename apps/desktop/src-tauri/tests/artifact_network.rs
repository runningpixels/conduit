//! `artifact_network::perform` against a scripted local HTTP server (ADR-010).
//!
//! The app policy refuses loopback and plain http, so these tests use the
//! relaxed test policy to reach the server — except where the point is that
//! the app policy refuses it.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use conduit_desktop::artifact_network::{
    self, AddressPolicy, ArtifactFetchRequest, MAX_RESPONSE_BYTES,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const TEST_POLICY: AddressPolicy = AddressPolicy { public_only: false };

/// No site allowed beyond the one requested.
fn nothing_else(_: &str) -> bool {
    false
}
const NOTHING_ELSE: fn(&str) -> bool = nothing_else;

/// What the server saw: request line + headers, per request.
type Seen = Arc<Mutex<Vec<String>>>;

/// Serve `respond(path)` for every request; returns the address and the log.
async fn serve(respond: fn(&str, SocketAddr) -> Vec<u8>) -> (SocketAddr, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    accept_loop(listener, addr, respond, seen.clone());
    // `localhost` may resolve to ::1 first: answer there too, on the same port,
    // so a redirect to http://localhost:<port> reaches this server.
    if let Ok(v6) = TcpListener::bind(format!("[::1]:{}", addr.port())).await {
        accept_loop(v6, addr, respond, seen.clone());
    }
    (addr, seen)
}

fn accept_loop(
    listener: TcpListener,
    addr: SocketAddr,
    respond: fn(&str, SocketAddr) -> Vec<u8>,
    log: Seen,
) {
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(end) = find(&buf, b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..end]).to_string();
                        let length = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        while buf.len() < end + 4 + length {
                            let n = socket.read(&mut chunk).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        let body = String::from_utf8_lossy(&buf[end + 4..]).to_string();
                        log.lock().unwrap().push(format!("{head}\n\n{body}"));
                        let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                        let _ = socket.write_all(&respond(&path, addr)).await;
                        let _ = socket.shutdown().await;
                        return;
                    }
                }
            });
        }
    });
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn response(status: &str, headers: &[(&str, String)], body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn get(url: String) -> ArtifactFetchRequest {
    ArtifactFetchRequest {
        artifact_id: "art-1".into(),
        url,
        method: "GET".into(),
        headers: vec![],
        body: None,
    }
}

fn routes(path: &str, addr: SocketAddr) -> Vec<u8> {
    match path {
        "/forecast" => response(
            "200 OK",
            &[
                ("Content-Type", "application/json".into()),
                ("Set-Cookie", "session=secret".into()),
            ],
            br#"{"temp":21}"#,
        ),
        "/moved" => response("302 Found", &[("Location", "/forecast".into())], b""),
        "/elsewhere" => response(
            "302 Found",
            &[(
                "Location",
                format!("http://localhost:{}/forecast", addr.port()),
            )],
            b"",
        ),
        "/huge" => response("200 OK", &[], &vec![b'x'; MAX_RESPONSE_BYTES + 1]),
        "/echo" => response("200 OK", &[], b"ok"),
        _ => response("404 Not Found", &[], b""),
    }
}

#[tokio::test]
async fn a_granted_get_returns_the_body_without_cookies() {
    let (addr, _) = serve(routes).await;
    let res = artifact_network::perform(
        &get(format!("http://{addr}/forecast")),
        TEST_POLICY,
        &NOTHING_ELSE,
    )
    .await
    .expect("request succeeds");
    assert_eq!(res.status, 200);
    assert_eq!(B64.decode(res.body).unwrap(), br#"{"temp":21}"#);
    assert!(res.headers.iter().any(|(k, _)| k == "content-type"));
    assert!(
        !res.headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("set-cookie")),
        "cookies never reach the page"
    );
}

#[tokio::test]
async fn a_redirect_on_the_same_host_is_followed() {
    let (addr, _) = serve(routes).await;
    let res = artifact_network::perform(
        &get(format!("http://{addr}/moved")),
        TEST_POLICY,
        &NOTHING_ELSE,
    )
    .await
    .expect("followed");
    assert_eq!(res.status, 200);
    assert!(res.url.ends_with("/forecast"));
}

#[tokio::test]
async fn a_redirect_to_another_host_is_refused() {
    let (addr, _) = serve(routes).await;
    let error = artifact_network::perform(
        &get(format!("http://{addr}/elsewhere")),
        TEST_POLICY,
        &NOTHING_ELSE,
    )
    .await
    .expect_err("another host");
    // Not a dead end: the error names the site so the reader can be asked.
    let origin = format!("http://localhost:{}", addr.port());
    assert!(
        error.starts_with(&format!(
            "{}{origin} ",
            artifact_network::REDIRECT_ERROR_PREFIX
        )),
        "{error}"
    );
}

#[tokio::test]
async fn a_redirect_to_an_allowed_site_is_followed() {
    let (addr, _) = serve(routes).await;
    let target = format!("http://localhost:{}", addr.port());
    let allowed = move |origin: &str| origin == target;
    let res = artifact_network::perform(
        &get(format!("http://{addr}/elsewhere")),
        TEST_POLICY,
        &allowed,
    )
    .await
    .expect("followed to the allowed site");
    assert_eq!(res.status, 200);
    assert!(res.url.contains("localhost"), "{}", res.url);
}

#[tokio::test]
async fn a_response_over_the_cap_is_refused() {
    let (addr, _) = serve(routes).await;
    let error = artifact_network::perform(
        &get(format!("http://{addr}/huge")),
        TEST_POLICY,
        &NOTHING_ELSE,
    )
    .await
    .expect_err("too large");
    assert!(error.contains("larger than"), "{error}");
}

#[tokio::test]
async fn credentials_and_identity_headers_are_stripped_and_the_body_is_sent() {
    let (addr, seen) = serve(routes).await;
    let request = ArtifactFetchRequest {
        artifact_id: "art-1".into(),
        url: format!("http://{addr}/echo"),
        method: "POST".into(),
        headers: vec![
            ("Content-Type".into(), "application/json".into()),
            ("Cookie".into(), "stolen=1".into()),
            ("Authorization".into(), "Bearer x".into()),
            ("Origin".into(), "https://evil.example".into()),
            ("X-Custom".into(), "kept".into()),
        ],
        body: Some(B64.encode(br#"{"city":"Paris"}"#)),
    };
    artifact_network::perform(&request, TEST_POLICY, &NOTHING_ELSE)
        .await
        .expect("sent");
    let log = seen.lock().unwrap().join("\n").to_ascii_lowercase();
    assert!(log.starts_with("post /echo"), "{log}");
    assert!(log.contains("x-custom: kept"));
    assert!(log.contains(r#"{"city":"paris"}"#));
    for gone in ["cookie:", "authorization:", "origin:"] {
        assert!(!log.contains(gone), "{gone} must not be sent: {log}");
    }
    assert!(log.contains("user-agent: conduit-artifact/"));
}

#[tokio::test]
async fn the_app_policy_refuses_loopback_and_plain_http() {
    let (addr, _) = serve(routes).await;
    let http = artifact_network::perform(
        &get(format!("http://{addr}/forecast")),
        AddressPolicy::APP,
        &NOTHING_ELSE,
    )
    .await
    .expect_err("plain http");
    assert!(http.contains("Only https"), "{http}");
    let loopback = artifact_network::perform(
        &get(format!("https://127.0.0.1:{}/forecast", addr.port())),
        AddressPolicy::APP,
        &NOTHING_ELSE,
    )
    .await
    .expect_err("loopback");
    assert!(loopback.contains("private or local address"), "{loopback}");
}

#[tokio::test]
async fn methods_outside_the_list_and_oversized_bodies_are_refused() {
    let (addr, _) = serve(routes).await;
    let mut trace = get(format!("http://{addr}/echo"));
    trace.method = "TRACE".into();
    assert!(
        artifact_network::perform(&trace, TEST_POLICY, &NOTHING_ELSE)
            .await
            .unwrap_err()
            .contains("not allowed")
    );
    let mut big = get(format!("http://{addr}/echo"));
    big.method = "POST".into();
    big.body = Some(B64.encode(vec![0u8; artifact_network::MAX_REQUEST_BYTES + 1]));
    assert!(artifact_network::perform(&big, TEST_POLICY, &NOTHING_ELSE)
        .await
        .unwrap_err()
        .contains("limit"));
}

// ── Remembered grants ────────────────────────────────────────────────────────

#[path = "common/mod.rs"]
mod common;

use conduit_desktop::db::repository::{artifact_network as grants, artifacts, conversations};

#[tokio::test]
async fn remembered_grants_list_revoke_and_go_with_their_conversation() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    let page = artifacts::create(&pool, &conv.id, "html", Some("Paris Weather"), None)
        .await
        .unwrap();
    let other = artifacts::create(&pool, &conv.id, "html", Some("Other"), None)
        .await
        .unwrap();

    grants::grant(&pool, &page.id, "https://api.open-meteo.com")
        .await
        .unwrap();
    grants::grant(&pool, &page.id, "https://api.open-meteo.com")
        .await
        .unwrap(); // idempotent
    grants::grant(&pool, &other.id, "https://api.github.com")
        .await
        .unwrap();

    assert!(
        grants::is_granted(&pool, &page.id, "https://api.open-meteo.com")
            .await
            .unwrap()
    );
    assert!(
        !grants::is_granted(&pool, &other.id, "https://api.open-meteo.com")
            .await
            .unwrap(),
        "a grant is per page, never global"
    );
    let listed = grants::list(&pool, None).await.unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed
        .iter()
        .any(|g| g.artifact_title.as_deref() == Some("Paris Weather")));

    grants::revoke(&pool, &other.id, "https://api.github.com")
        .await
        .unwrap();
    assert_eq!(grants::list(&pool, None).await.unwrap().len(), 1);

    conversations::delete(&pool, &conv.id).await.unwrap();
    assert!(
        grants::list(&pool, None).await.unwrap().is_empty(),
        "deleting the conversation deletes its pages' grants"
    );
}
