//! A loopback HTTP server that gives each page with full web access (ADR-007)
//! its own real origin.
//!
//! Every other page runs in `sandbox="allow-scripts"` with an opaque origin,
//! served from the `conduit-artifact` scheme (`artifact_frames`). An opaque
//! origin sends no `Referer` at all, so services that require one (OpenStreetMap
//! tiles) refuse the page, and it has no storage or cookies of its own (video
//! embeds). A page the reader gave full web access is served from here instead,
//! at `http://<page id>.page.localhost:<port>/<token>`, and its frame adds
//! `allow-same-origin`: it then behaves like a website on its own origin.
//!
//! * **One origin per page.** The page id is the first 32 hex characters of
//!   SHA-256(install secret ‖ principal) ([`page_id`]): stable across reloads
//!   and edits, so storage survives; different for every page, so no two
//!   pages share storage; not derivable without this install's secret.
//! * **A stable port.** The port is part of the origin, so it is kept in
//!   `page-origins.json` and bound again on every launch ([`PageServer::open`]);
//!   a new one is picked only when that port is taken. Storage kept under the
//!   old origins then stays behind, unreachable (ADR-007 residual risks).
//! * **Guards.** Bound to 127.0.0.1 only. The `Host` header must be
//!   exactly `<page id>.page.localhost:<port>`, and the path's token must have
//!   been stored for that page id (`ArtifactFrames::put_page`); the renderer
//!   drops it when the frame goes away. `GET`/`HEAD` only. A request that says
//!   it is not for a frame (`Sec-Fetch-Dest`) is refused. Everything else is
//!   404. Responses are `no-store`, `nosniff`, `Referrer-Policy: strict-origin`
//!   (a site sees `http://<id>.page.localhost:<port>/`, never the token), and
//!   carry a CSP whose `frame-ancestors` is the app's own origin, so another
//!   local site or browser can't frame a page.
//! * **No IPC.** Tauri answers IPC only for its own origin and for remote URLs
//!   a capability lists; `capabilities/*.json` lists none, so a call from
//!   `*.page.localhost` is refused. The page's CSP blocks http connections
//!   (`connect-src https: wss:`), which closes the `http://ipc.localhost` path
//!   as well, and the renderer's in-frame script still cuts `chrome.webview`.
//! * **Clearing.** `GET /<clear token>/__clear` on the page's origin answers
//!   with `Clear-Site-Data` and a script that also empties the origin's storage
//!   by hand (WebKit honours the header only in part), then tells the app. The
//!   app loads it in a hidden frame ("Clear site data", page deletion, revoked
//!   access).
//!
//! Loopback never goes through a proxy in Chromium, so the guard proxy is not
//! involved: `*.localhost` resolves to the loopback address in Chromium itself.
//! WebKit (macOS, Linux) resolves `*.localhost` through the system resolver;
//! not yet verified there (ADR-007).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

use crate::artifact_frames::{is_token, ArtifactFrames};

/// What follows the page id in every page host.
pub const PAGE_HOST_SUFFIX: &str = ".page.localhost";
/// The path segment of the "clear site data" route.
pub const CLEAR_SEGMENT: &str = "__clear";
/// What the clear page posts to the app once done.
pub const CLEARED_MESSAGE_TYPE: &str = "conduit:page-data-cleared";
/// The file, in the app data dir, holding the install secret and the pages
/// that were ever given an origin.
pub const RECORD_FILE: &str = "page-origins.json";

/// Where a first port is picked: the dynamic range, below its very top.
const PORT_RANGE: std::ops::RangeInclusive<u16> = 49152..=65000;
/// New ports tried when the stored one is taken.
const PORT_ATTEMPTS: usize = 16;
/// Ports used before, kept in the record (newest last).
const MAX_PREVIOUS_PORTS: usize = 8;

/// Longest a client may take to send its request head.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections handled at once.
const MAX_CONNECTIONS: usize = 64;

/// The first 32 hex characters of SHA-256(secret ‖ principal).
pub fn page_id(secret: &[u8; 32], principal: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret);
    hasher.update(principal.as_bytes());
    hasher.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The app's own origin(s), the only ones that may frame a page and that the
/// clear page reports to: `http://tauri.localhost` on Windows (`https` with
/// `useHttpsScheme`), `tauri://localhost` elsewhere, and the dev server's
/// origin in a dev build.
pub fn app_origins(windows: bool, https_scheme: bool, dev_url: Option<&url::Url>) -> Vec<String> {
    let mut origins = vec![if windows {
        format!(
            "{}://tauri.localhost",
            if https_scheme { "https" } else { "http" }
        )
    } else {
        "tauri://localhost".to_string()
    }];
    if let Some(url) = dev_url {
        let origin = url.origin().ascii_serialization();
        if origin != "null" && !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    origins
}

/// The header CSP for a full-access page: the renderer's `full` policy
/// (`buildArtifactCsp(allowlist, 'full')`, which the document also carries as
/// its first `<meta>`) with `frame-ancestors` limited to the app. Both apply,
/// so the effective policy is never wider than the meta's. As in the renderer,
/// one invalid allowlist entry drops the whole allowlist.
pub fn full_access_csp(allowlist: &[String], app_origins: &[String]) -> String {
    let origins: Option<Vec<String>> = allowlist
        .iter()
        .map(|entry| {
            let origin = crate::validation::validate_artifact_origin(entry)?;
            // Only characters that can't end a directive or add a source.
            origin
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '/'))
                .then_some(origin)
        })
        .collect();
    let mut unique: Vec<String> = Vec::new();
    for origin in origins.unwrap_or_default() {
        if !unique.contains(&origin) {
            unique.push(origin);
        }
    }
    let passive = |base: &str| {
        if unique.is_empty() {
            base.to_string()
        } else {
            format!("{base} {}", unique.join(" "))
        }
    };
    [
        "default-src 'none'".to_string(),
        "script-src 'unsafe-inline' https:".to_string(),
        passive("style-src 'unsafe-inline' https: data: blob:"),
        passive("img-src https: data: blob:"),
        passive("font-src https: data: blob:"),
        "media-src https: data: blob:".to_string(),
        "connect-src https: wss:".to_string(),
        "frame-src https:".to_string(),
        "worker-src blob:".to_string(),
        format!("frame-ancestors {}", app_origins.join(" ")),
        "base-uri 'none'".to_string(),
        "form-action 'none'".to_string(),
    ]
    .join("; ")
}

/// What the server needs besides the frame store.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub port: u16,
    pub app_origins: Vec<String>,
}

/// The install secret, the port, and the pages given an origin, as stored on
/// disk.
#[derive(Debug, Default, Serialize, Deserialize)]
struct RecordFile {
    secret: String,
    #[serde(default)]
    principals: BTreeSet<String>,
    /// The port the server listens on; part of every page's origin.
    #[serde(default)]
    port: Option<u16>,
    /// Ports given up because they were taken at launch (newest last). Data
    /// pages kept under those origins is orphaned; kept for reference only.
    #[serde(default)]
    previous_ports: Vec<u16>,
}

/// The running page server, as managed state: where it listens, the secret
/// page ids come from, and every page that was given an origin (so "Clear data
/// for all pages" can reach pages whose grant is gone).
pub struct PageServer {
    pub config: Arc<ServerConfig>,
    secret: [u8; 32],
    principals: Mutex<BTreeSet<String>>,
    previous_ports: Vec<u16>,
    record_path: Option<PathBuf>,
}

impl PageServer {
    /// Read the record in `dir` (`None` in tests) and bind the server's
    /// listener. The install secret is created once (32 random bytes). The
    /// stored port is bound again, so every page keeps its origin, and its
    /// storage, across launches; on a first run, or when that port is taken,
    /// a random port in [`PORT_RANGE`] is bound and saved instead. A changed
    /// port strands what pages stored under the old origins (logged; the old
    /// port is kept in `previous_ports`).
    pub fn open(
        app_origins: Vec<String>,
        dir: Option<&Path>,
    ) -> std::io::Result<(Self, std::net::TcpListener)> {
        let record_path = dir.map(|d| d.join(RECORD_FILE));
        let record = record_path
            .as_deref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|text| serde_json::from_str::<RecordFile>(&text).ok());
        let (secret, principals, stored_port, previous_ports, fresh) =
            match record.and_then(|r| Some((parse_secret(&r.secret)?, r))) {
                Some((secret, r)) => (secret, r.principals, r.port, r.previous_ports, false),
                None => {
                    let mut secret = [0u8; 32];
                    OsRng.fill_bytes(&mut secret);
                    (secret, BTreeSet::new(), None, Vec::new(), true)
                }
            };
        let (listener, port) = bind_port(stored_port)?;
        let mut server = Self {
            config: Arc::new(ServerConfig { port, app_origins }),
            secret,
            principals: Mutex::new(principals),
            previous_ports,
            record_path,
        };
        let moved = stored_port.is_some_and(|old| old != port);
        if let Some(old) = stored_port.filter(|_| moved) {
            tracing::warn!(
                old,
                new = port,
                "page server port was taken; pages' stored data stays behind on the old address"
            );
            server.previous_ports.retain(|p| *p != old && *p != port);
            server.previous_ports.push(old);
            let excess = server
                .previous_ports
                .len()
                .saturating_sub(MAX_PREVIOUS_PORTS);
            server.previous_ports.drain(..excess);
        }
        if fresh || moved || stored_port.is_none() {
            server.save();
        }
        Ok((server, listener))
    }

    pub fn page_id(&self, principal: &str) -> String {
        page_id(&self.secret, principal)
    }

    /// `http://<page id>.page.localhost:<port>`.
    pub fn origin(&self, page_id: &str) -> String {
        format!("http://{page_id}{PAGE_HOST_SUFFIX}:{}", self.config.port)
    }

    /// Note that `principal` was given an origin. Written through to disk.
    pub fn remember(&self, principal: &str) {
        let added = self
            .principals
            .lock()
            .is_ok_and(|mut set| set.insert(principal.to_string()));
        if added {
            self.save();
        }
    }

    /// Forget `principal` (its data was cleared).
    pub fn forget(&self, principal: &str) {
        let removed = self
            .principals
            .lock()
            .is_ok_and(|mut set| set.remove(principal));
        if removed {
            self.save();
        }
    }

    /// Every page that was given an origin and not cleared since.
    pub fn principals(&self) -> Vec<String> {
        self.principals
            .lock()
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn save(&self) {
        let Some(path) = &self.record_path else {
            return;
        };
        let record = RecordFile {
            port: Some(self.config.port),
            previous_ports: self.previous_ports.clone(),
            secret: self.secret.iter().map(|b| format!("{b:02x}")).collect(),
            principals: self
                .principals
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default(),
        };
        let Ok(text) = serde_json::to_string_pretty(&record) else {
            return;
        };
        let temp = path.with_extension("json.part");
        let written = std::fs::write(&temp, text).and_then(|_| std::fs::rename(&temp, path));
        if let Err(error) = written {
            tracing::warn!(%error, "could not save the page origin record");
        }
    }
}

fn parse_secret(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut secret = [0u8; 32];
    for (i, byte) in secret.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(secret)
}

/// Bind one loopback port, non-blocking for [`serve`].
fn bind_loopback(port: u16) -> std::io::Result<std::net::TcpListener> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// Bind `stored` if given and free, else a few random ports in
/// [`PORT_RANGE`]; the listener and the port it holds.
fn bind_port(stored: Option<u16>) -> std::io::Result<(std::net::TcpListener, u16)> {
    let mut last_error = None;
    if let Some(port) = stored.filter(|p| *p != 0) {
        match bind_loopback(port) {
            Ok(listener) => return Ok((listener, port)),
            Err(error) => last_error = Some(error),
        }
    }
    for _ in 0..PORT_ATTEMPTS {
        let span = u32::from(PORT_RANGE.end() - PORT_RANGE.start()) + 1;
        let port = PORT_RANGE.start() + (OsRng.next_u32() % span) as u16;
        if Some(port) == stored {
            continue;
        }
        match bind_loopback(port) {
            Ok(listener) => return Ok((listener, port)),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("no free port for the page server")))
}

/// Accept connections until the listener fails.
pub async fn serve(
    listener: std::net::TcpListener,
    frames: ArtifactFrames,
    config: Arc<ServerConfig>,
) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        return;
    };
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let frames = frames.clone();
        let config = config.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = handle(stream, &frames, &config).await;
        });
    }
}

async fn handle(
    mut stream: TcpStream,
    frames: &ArtifactFrames,
    config: &ServerConfig,
) -> std::io::Result<()> {
    let head = match tokio::time::timeout(HEAD_TIMEOUT, crate::guard_proxy::read_head(&mut stream))
        .await
    {
        Ok(Ok(Some(head))) => Some(head),
        _ => None,
    };
    let reply = match head.as_deref().map(parse_request) {
        Some(Some(request)) => route(&request, frames, config),
        _ => Reply::status(400, "Bad Request"),
    };
    stream.write_all(&reply.to_bytes()).await?;
    stream.shutdown().await
}

/// The parts of a request the server looks at.
#[derive(Debug, PartialEq, Eq)]
pub struct PageRequest {
    pub method: String,
    pub path: String,
    pub host: Option<String>,
    pub fetch_dest: Option<String>,
}

/// Parse a request head; `None` if it isn't HTTP/1.x or has two `Host`s.
pub fn parse_request(head: &str) -> Option<PageRequest> {
    let mut lines = head.split("\r\n");
    let mut parts = lines.next()?.split(' ');
    let (method, target, version) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(t), Some(v), None) => (m, t, v),
        _ => return None,
    };
    if !version.starts_with("HTTP/1.") {
        return None;
    }
    let mut host = None;
    let mut fetch_dest = None;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        let value = value.trim().to_ascii_lowercase();
        if name.eq_ignore_ascii_case("host") {
            if host.is_some() {
                return None;
            }
            host = Some(value);
        } else if name.eq_ignore_ascii_case("sec-fetch-dest") {
            fetch_dest = Some(value);
        }
    }
    Some(PageRequest {
        method: method.to_string(),
        path: target.to_string(),
        host,
        fetch_dest,
    })
}

/// The page id a `Host` names, if it is exactly `<id>.page.localhost:<port>`.
fn host_page_id(host: &str, port: u16) -> Option<&str> {
    let name = host.strip_suffix(&format!(":{port}"))?;
    let id = name.strip_suffix(PAGE_HOST_SUFFIX)?;
    is_token(id).then_some(id)
}

/// Answer a request. Pure, apart from using up a clear token.
pub fn route(request: &PageRequest, frames: &ArtifactFrames, config: &ServerConfig) -> Reply {
    let Some(page_id) = request
        .host
        .as_deref()
        .and_then(|host| host_page_id(host, config.port))
    else {
        return Reply::status(404, "Not Found");
    };
    if request.method != "GET" && request.method != "HEAD" {
        return Reply::status(405, "Method Not Allowed").with("Allow", "GET, HEAD");
    }
    // Only ever loaded into a frame (a browser that doesn't say is let on).
    if request
        .fetch_dest
        .as_deref()
        .is_some_and(|dest| dest != "iframe")
    {
        return Reply::status(404, "Not Found");
    }
    let path = request.path.split(['?', '#']).next().unwrap_or("");
    let mut segments = path.strip_prefix('/').unwrap_or("\u{0}").split('/');
    let reply = match (segments.next(), segments.next(), segments.next()) {
        (Some(token), None, None) if is_token(token) => match frames.page_doc(token, page_id) {
            Some((doc, page)) => Reply::html(200, "OK", doc.as_bytes().to_vec())
                .with("Content-Security-Policy", &page.csp),
            None => Reply::status(404, "Not Found"),
        },
        (Some(token), Some(CLEAR_SEGMENT), None)
            if is_token(token) && frames.take_clear(token, page_id) =>
        {
            clear_page(&config.app_origins)
        }
        _ => Reply::status(404, "Not Found"),
    };
    if request.method == "HEAD" {
        reply.without_body()
    } else {
        reply
    }
}

/// The "clear site data" page: the header, then the same by hand, then a
/// message to the app.
fn clear_page(app_origins: &[String]) -> Reply {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let targets = serde_json::to_string(app_origins).unwrap_or_else(|_| "[]".to_string());
    let script = format!(
        "(async function(){{\
try{{localStorage.clear();}}catch(e){{}}\
try{{sessionStorage.clear();}}catch(e){{}}\
try{{if(indexedDB.databases){{var d=await indexedDB.databases();\
await Promise.all(d.map(function(x){{return new Promise(function(r){{\
var q=indexedDB.deleteDatabase(x.name);q.onsuccess=q.onerror=q.onblocked=function(){{r();}};}});}}));}}}}catch(e){{}}\
try{{if(self.caches){{var k=await caches.keys();await Promise.all(k.map(function(n){{return caches.delete(n);}}));}}}}catch(e){{}}\
try{{var h=location.hostname,p=h.split('.');var ds=['',h,'.'+h];\
for(var i=1;i<p.length-1;i++)ds.push(p.slice(i).join('.'));\
document.cookie.split(';').forEach(function(c){{var n=c.split('=')[0].trim();if(!n)return;\
ds.forEach(function(d){{document.cookie=n+'=; Max-Age=0; path=/'+(d?'; domain='+d:'');}});}});}}catch(e){{}}\
{targets}.forEach(function(o){{try{{parent.postMessage({{type:'{CLEARED_MESSAGE_TYPE}'}},o);}}catch(e){{}}}});\
}})();"
    );
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><script nonce=\"{nonce}\">{script}</script>"
    );
    let csp = format!(
        "default-src 'none'; script-src 'nonce-{nonce}'; frame-ancestors {}; base-uri 'none'; form-action 'none'",
        app_origins.join(" ")
    );
    Reply::html(200, "OK", body.into_bytes())
        .with("Content-Security-Policy", &csp)
        .with("Clear-Site-Data", "\"cache\", \"cookies\", \"storage\"")
}

/// A response: status, headers and body.
#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    reason: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// Content-Length to send (a HEAD reply keeps the GET's length).
    length: usize,
}

impl Reply {
    fn base(status: u16, reason: &'static str, content_type: &str, body: Vec<u8>) -> Self {
        let length = body.len();
        Self {
            status,
            reason,
            headers: vec![
                ("Content-Type".into(), content_type.into()),
                ("Cache-Control".into(), "no-store".into()),
                ("X-Content-Type-Options".into(), "nosniff".into()),
                ("Referrer-Policy".into(), "strict-origin".into()),
                // Pages share the `page.localhost` site; keep `document.domain`
                // from joining two of them.
                ("Origin-Agent-Cluster".into(), "?1".into()),
            ],
            body,
            length,
        }
    }

    fn html(status: u16, reason: &'static str, body: Vec<u8>) -> Self {
        Self::base(status, reason, "text/html; charset=utf-8", body)
    }

    fn status(status: u16, reason: &'static str) -> Self {
        Self::base(
            status,
            reason,
            "text/plain; charset=utf-8",
            reason.as_bytes().to_vec(),
        )
        .with(
            "Content-Security-Policy",
            "default-src 'none'; frame-ancestors 'none'",
        )
    }

    fn with(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    fn without_body(mut self) -> Self {
        self.body.clear();
        self
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn to_bytes(&self) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {} {}\r\n", self.status, self.reason);
        for (name, value) in &self.headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            self.length
        ));
        let mut bytes = out.into_bytes();
        bytes.extend_from_slice(&self.body);
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_frames::PageDoc;
    use tokio::io::AsyncReadExt;

    const PORT: u16 = 40123;

    fn config() -> ServerConfig {
        ServerConfig {
            port: PORT,
            app_origins: vec!["http://tauri.localhost".into()],
        }
    }

    fn id(n: u8) -> String {
        format!("{:032x}", n)
    }

    fn req(method: &str, path: &str, host: &str) -> PageRequest {
        PageRequest {
            method: method.into(),
            path: path.into(),
            host: Some(host.into()),
            fetch_dest: Some("iframe".into()),
        }
    }

    fn host(page: &str) -> String {
        format!("{page}.page.localhost:{PORT}")
    }

    fn stored(frames: &ArtifactFrames, page: &str) -> String {
        frames
            .put_page(
                "<p>page</p>".into(),
                PageDoc {
                    page_id: page.into(),
                    csp: full_access_csp(&[], &config().app_origins),
                },
            )
            .unwrap()
    }

    #[test]
    fn page_ids_are_stable_and_depend_on_the_install_secret() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let id = page_id(&a, "app:one");
        assert_eq!(id.len(), 32);
        assert!(is_token(&id));
        assert_eq!(id, page_id(&a, "app:one"));
        assert_ne!(id, page_id(&a, "app:two"));
        assert_ne!(id, page_id(&b, "app:one"));
    }

    #[test]
    fn serves_a_page_document_with_its_headers() {
        let frames = ArtifactFrames::default();
        let page = id(1);
        let token = stored(&frames, &page);
        let reply = route(
            &req("GET", &format!("/{token}"), &host(&page)),
            &frames,
            &config(),
        );
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, b"<p>page</p>");
        assert_eq!(
            reply.header("Content-Type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(reply.header("Cache-Control"), Some("no-store"));
        assert_eq!(reply.header("X-Content-Type-Options"), Some("nosniff"));
        assert_eq!(reply.header("Referrer-Policy"), Some("strict-origin"));
        let csp = reply.header("Content-Security-Policy").unwrap();
        assert!(
            csp.contains("frame-ancestors http://tauri.localhost;"),
            "{csp}"
        );
        assert!(csp.contains("connect-src https: wss:"), "{csp}");
        // A query string doesn't change what is served.
        let reply = route(
            &req("GET", &format!("/{token}?x=1"), &host(&page)),
            &frames,
            &config(),
        );
        assert_eq!(reply.status, 200);
        // HEAD: same headers, no body.
        let reply = route(
            &req("HEAD", &format!("/{token}"), &host(&page)),
            &frames,
            &config(),
        );
        assert_eq!(reply.status, 200);
        assert!(reply.body.is_empty());
    }

    #[test]
    fn refuses_another_host_a_bad_token_and_other_methods() {
        let frames = ArtifactFrames::default();
        let page = id(1);
        let token = stored(&frames, &page);
        let path = format!("/{token}");
        for bad_host in [
            host(&id(2)),
            format!("{page}.page.localhost:{}", PORT + 1),
            format!("{page}.page.localhost"),
            format!("127.0.0.1:{PORT}"),
            format!("localhost:{PORT}"),
            format!("x.{page}.page.localhost:{PORT}"),
            format!("{page}.page.localhost.evil.com:{PORT}"),
        ] {
            let reply = route(&req("GET", &path, &bad_host), &frames, &config());
            assert_eq!(reply.status, 404, "{bad_host}");
        }
        let mut no_host = req("GET", &path, "");
        no_host.host = None;
        assert_eq!(route(&no_host, &frames, &config()).status, 404);
        for bad_path in [
            "/".to_string(),
            format!("/{}", id(9)),
            format!("/{}", token.to_uppercase()),
            format!("/{token}/"),
            format!("/{token}/x"),
            format!("/../{token}"),
            "*".to_string(),
        ] {
            let reply = route(&req("GET", &bad_path, &host(&page)), &frames, &config());
            assert_eq!(reply.status, 404, "{bad_path}");
        }
        let reply = route(&req("POST", &path, &host(&page)), &frames, &config());
        assert_eq!(reply.status, 405);
        assert_eq!(reply.header("Allow"), Some("GET, HEAD"));
        // Not loaded as a frame (a top-level visit, a fetch).
        let mut top = req("GET", &path, &host(&page));
        top.fetch_dest = Some("document".into());
        assert_eq!(route(&top, &frames, &config()).status, 404);
        // Dropped with its frame.
        frames.drop_token(&token);
        assert_eq!(
            route(&req("GET", &path, &host(&page)), &frames, &config()).status,
            404
        );
    }

    #[test]
    fn a_plain_scheme_document_is_not_served_here() {
        let frames = ArtifactFrames::default();
        let token = frames.put_with("x".into(), true).unwrap();
        let reply = route(
            &req("GET", &format!("/{token}"), &host(&id(1))),
            &frames,
            &config(),
        );
        assert_eq!(reply.status, 404);
    }

    #[test]
    fn the_clear_route_sends_clear_site_data_once() {
        let frames = ArtifactFrames::default();
        let page = id(1);
        let token = frames.mint_clear(&page).unwrap();
        let path = format!("/{token}/{CLEAR_SEGMENT}");
        // Another page's host can't use it.
        assert_eq!(
            route(&req("GET", &path, &host(&id(2))), &frames, &config()).status,
            404
        );
        let reply = route(&req("GET", &path, &host(&page)), &frames, &config());
        assert_eq!(reply.status, 200);
        assert_eq!(
            reply.header("Clear-Site-Data"),
            Some("\"cache\", \"cookies\", \"storage\"")
        );
        let csp = reply.header("Content-Security-Policy").unwrap();
        assert!(
            csp.contains("frame-ancestors http://tauri.localhost"),
            "{csp}"
        );
        assert!(csp.contains("script-src 'nonce-"), "{csp}");
        let body = String::from_utf8(reply.body).unwrap();
        assert!(body.contains("localStorage.clear()"));
        assert!(body.contains("indexedDB.deleteDatabase"));
        assert!(body.contains(CLEARED_MESSAGE_TYPE));
        assert!(body.contains("[\"http://tauri.localhost\"]"));
        // One shot.
        assert_eq!(
            route(&req("GET", &path, &host(&page)), &frames, &config()).status,
            404
        );
        // A document token is not a clear token.
        let doc = stored(&frames, &page);
        let path = format!("/{doc}/{CLEAR_SEGMENT}");
        assert_eq!(
            route(&req("GET", &path, &host(&page)), &frames, &config()).status,
            404
        );
    }

    #[test]
    fn parses_request_heads() {
        let parsed =
            parse_request("GET /abc HTTP/1.1\r\nHost: X.page.localhost:1\r\nSec-Fetch-Dest: iframe\r\nAccept: */*").unwrap();
        assert_eq!(parsed.method, "GET");
        assert_eq!(parsed.path, "/abc");
        assert_eq!(parsed.host.as_deref(), Some("x.page.localhost:1"));
        assert_eq!(parsed.fetch_dest.as_deref(), Some("iframe"));
        assert!(parse_request("GET /abc SPDY/3\r\nHost: a").is_none());
        assert!(parse_request("GET /abc HTTP/1.1\r\nHost: a\r\nHost: b").is_none());
        assert!(parse_request("GET /abc HTTP/1.1\r\nno colon").is_none());
        assert!(parse_request("GET  /abc HTTP/1.1").is_none());
    }

    #[test]
    fn app_origins_per_platform_and_dev() {
        assert_eq!(
            app_origins(true, false, None),
            vec!["http://tauri.localhost"]
        );
        assert_eq!(
            app_origins(true, true, None),
            vec!["https://tauri.localhost"]
        );
        assert_eq!(app_origins(false, false, None), vec!["tauri://localhost"]);
        let dev = url::Url::parse("http://localhost:5173/").unwrap();
        assert_eq!(
            app_origins(true, false, Some(&dev)),
            vec!["http://tauri.localhost", "http://localhost:5173"]
        );
    }

    #[test]
    fn header_csp_mirrors_the_full_policy_and_drops_a_bad_allowlist() {
        let app = vec!["tauri://localhost".to_string()];
        let csp = full_access_csp(
            &[
                "https://img.example.com".into(),
                "http://cdn.example.org:8080".into(),
            ],
            &app,
        );
        assert!(csp.contains(
            "img-src https: data: blob: https://img.example.com http://cdn.example.org:8080"
        ));
        assert!(csp.contains("frame-ancestors tauri://localhost;"));
        assert!(csp.starts_with("default-src 'none'; script-src 'unsafe-inline' https:;"));
        let bad = full_access_csp(
            &[
                "https://ok.example.com".into(),
                "javascript:alert(1)".into(),
            ],
            &app,
        );
        assert!(!bad.contains("ok.example.com"));
        assert!(bad.contains("img-src https: data: blob:;"));
    }

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "conduit-page-server-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn open(dir: Option<&Path>) -> (PageServer, std::net::TcpListener) {
        PageServer::open(config().app_origins, dir).unwrap()
    }

    fn record(dir: &Path) -> RecordFile {
        serde_json::from_str(&std::fs::read_to_string(dir.join(RECORD_FILE)).unwrap()).unwrap()
    }

    #[test]
    fn the_port_is_saved_and_bound_again_on_the_next_launch() {
        let dir = temp_dir();
        let (first, listener) = open(Some(&dir));
        let port = first.config.port;
        assert!(PORT_RANGE.contains(&port));
        assert_eq!(listener.local_addr().unwrap().port(), port);
        assert_eq!(record(&dir).port, Some(port));
        drop(listener);
        let (again, _listener) = open(Some(&dir));
        assert_eq!(again.config.port, port);
        assert_eq!(again.origin(&id(1)), first.origin(&id(1)));
        assert!(record(&dir).previous_ports.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_taken_port_is_replaced_saved_and_remembered() {
        let dir = temp_dir();
        let (first, held) = open(Some(&dir));
        let old = first.config.port;
        // Still bound: the next launch finds its port taken.
        let (moved, _listener) = open(Some(&dir));
        assert_ne!(moved.config.port, old);
        let saved = record(&dir);
        assert_eq!(saved.port, Some(moved.config.port));
        assert_eq!(saved.previous_ports, vec![old]);
        // The secret is unchanged, so only the port part of an origin moved.
        assert_eq!(first.page_id("app:one"), moved.page_id("app:one"));
        drop(held);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn previous_ports_are_bounded() {
        let dir = temp_dir();
        let (_server, _listener) = open(Some(&dir));
        let mut saved = record(&dir);
        saved.previous_ports = (1..=MAX_PREVIOUS_PORTS as u16).collect();
        std::fs::write(
            dir.join(RECORD_FILE),
            serde_json::to_string(&saved).unwrap(),
        )
        .unwrap();
        // The stored port is still held by `_listener`, so this one moves.
        let (moved, _second) = open(Some(&dir));
        let after = record(&dir);
        assert_eq!(after.previous_ports.len(), MAX_PREVIOUS_PORTS);
        assert_eq!(after.previous_ports.last(), saved.port.as_ref());
        assert_eq!(after.port, Some(moved.config.port));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_install_secret_is_created_once_and_kept() {
        let dir = temp_dir();
        let (first, listener) = open(Some(&dir));
        first.remember("app:one");
        drop(listener);
        let (again, listener) = open(Some(&dir));
        drop(listener);
        assert_eq!(first.page_id("app:one"), again.page_id("app:one"));
        assert_eq!(again.principals(), vec!["app:one".to_string()]);
        again.forget("app:one");
        assert!(open(Some(&dir)).0.principals().is_empty());
        let (elsewhere, _listener) = open(None);
        assert_ne!(first.page_id("app:one"), elsewhere.page_id("app:one"));
        assert_eq!(
            first.origin(&id(1)),
            format!("http://{}.page.localhost:{}", id(1), first.config.port)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn answers_over_a_socket() {
        let frames = ArtifactFrames::default();
        let listener = bind_loopback(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = Arc::new(ServerConfig {
            port,
            app_origins: vec!["http://tauri.localhost".into()],
        });
        let page = id(3);
        let token = frames
            .put_page(
                "<p>sock</p>".into(),
                PageDoc {
                    page_id: page.clone(),
                    csp: full_access_csp(&[], &config.app_origins),
                },
            )
            .unwrap();
        tokio::spawn(serve(listener, frames.clone(), config));
        let exchange = |request: String| async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut out = Vec::new();
            tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out))
                .await
                .unwrap()
                .unwrap();
            String::from_utf8_lossy(&out).to_string()
        };
        let ok = exchange(format!(
            "GET /{token} HTTP/1.1\r\nHost: {page}.page.localhost:{port}\r\n\r\n"
        ))
        .await;
        assert!(ok.starts_with("HTTP/1.1 200 OK\r\n"), "{ok}");
        assert!(ok.contains("\r\nContent-Length: 11\r\n"), "{ok}");
        assert!(ok.ends_with("<p>sock</p>"), "{ok}");
        let wrong = exchange(format!(
            "GET /{token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
        ))
        .await;
        assert!(wrong.starts_with("HTTP/1.1 404"), "{wrong}");
        let post = exchange(format!(
            "POST /{token} HTTP/1.1\r\nHost: {page}.page.localhost:{port}\r\n\r\n"
        ))
        .await;
        assert!(post.starts_with("HTTP/1.1 405"), "{post}");
        let junk = exchange("hello\r\n\r\n".to_string()).await;
        assert!(junk.starts_with("HTTP/1.1 400"), "{junk}");
    }
}
