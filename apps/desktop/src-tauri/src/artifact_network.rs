//! Network access for HTML artifacts, made on their behalf (ADR-010).
//!
//! An artifact's frame never gets a socket: its CSP keeps `connect-src 'none'`
//! (ADR-007). A Conduit-owned shim in the frame turns `fetch()` into a message
//! to the host window, which asks the user and then calls `artifact_fetch`
//! here. Everything this module does is the enforcement behind that consent:
//!
//! * the request is to a host the user granted for this artifact;
//! * `https` only, to a **public** address — the name is resolved here and the
//!   connection pinned to the checked address, so neither a private target nor
//!   DNS rebinding can turn a page into a route into the user's network;
//! * redirects are followed by hand and must stay on the granted host;
//! * no cookies, no stored credentials, filtered headers;
//! * size, time, rate and concurrency caps.
//!
//! A refused request is an `Err(String)`; the shim turns it into the network
//! error `fetch()` would have thrown, so the page's own error handling runs.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Longest a request may take, redirects included.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Largest response body handed back to the page.
pub const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
/// Largest response a whole-document reader ([`crate::web_page`]) takes:
/// reports and budgets are often PDFs well past a web page's size.
pub const MAX_DOCUMENT_RESPONSE_BYTES: usize = 20 * 1024 * 1024;
/// Largest request body a page may send.
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// Requests per artifact per rolling minute.
pub const MAX_REQUESTS_PER_MINUTE: usize = 120;
/// Requests per artifact in flight at once; more wait their turn (a page that
/// loads five stories with `Promise.all` must not lose the fifth).
pub const MAX_IN_FLIGHT: usize = 4;
/// Redirect hops followed before giving up.
const MAX_REDIRECTS: usize = 5;

const ALLOWED_METHODS: [&str; 6] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/// Request headers a page may not set: ambient credentials, hop-by-hop and
/// transport headers, and the ones that would misstate who is asking.
const BLOCKED_REQUEST_HEADERS: [&str; 16] = [
    "authorization",
    "cookie",
    "cookie2",
    "proxy-authorization",
    "proxy-connection",
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "content-length",
    "origin",
    "referer",
    "user-agent",
];

/// Response headers never handed to the page.
const BLOCKED_RESPONSE_HEADERS: [&str; 3] = ["set-cookie", "set-cookie2", "www-authenticate"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFetchRequest {
    /// Whose request this is: `artifact:<id>` or `app:<id>` from the renderer
    /// (parsed by the command), or a workflow run's own key.
    pub principal: String,
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// Base64 request body, if any.
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFetchResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    /// Base64 response body.
    pub body: String,
    /// The URL finally answered, after redirects.
    pub url: String,
}

/// The grant that lets a page reach any public https site (the reader's
/// blanket approval). Every other rule still holds for each request.
pub const ANY_SITE: &str = "*";

/// Prefix of the error `perform` returns when a server redirects to a site
/// the page may not reach yet: `redirect:<origin> <message>`. The renderer
/// asks the reader about `<origin>` and retries, instead of dead-ending.
pub const REDIRECT_ERROR_PREFIX: &str = "redirect:";

/// The origin a grant is keyed on: `https://host[:port]`, lowercased, default
/// port elided — or [`ANY_SITE`]. `Err` for anything a page may not reach.
pub fn grant_host(raw_url: &str) -> Result<String, String> {
    if raw_url == ANY_SITE {
        return Ok(ANY_SITE.to_string());
    }
    origin_for(raw_url, AddressPolicy::APP)
}

/// A redirect that stays with the same owner: the same host give or take a
/// leading `www.`, or a subdomain of the host the reader allowed. Anything
/// else is a different site and needs the reader's say-so.
fn same_site(allowed_origin: &str, target_origin: &str) -> bool {
    let host = |origin: &str| {
        url::Url::parse(origin)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
            .unwrap_or_default()
    };
    let (a, b) = (host(allowed_origin), host(target_origin));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let strip = |h: &str| h.strip_prefix("www.").unwrap_or(h).to_string();
    strip(&a) == strip(&b) || b.ends_with(&format!(".{a}"))
}

fn origin_for(raw_url: &str, policy: AddressPolicy) -> Result<String, String> {
    let url = url::Url::parse(raw_url).map_err(|_| format!("Not a valid address: {raw_url}"))?;
    let scheme_ok = url.scheme() == "https" || (!policy.public_only && url.scheme() == "http");
    if !scheme_ok {
        return Err(format!(
            "Only https addresses can be contacted (got {}://).",
            url.scheme()
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Addresses with a user name or password are not allowed.".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "The address has no host.".to_string())?
        .to_ascii_lowercase();
    if policy.public_only
        && (host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local"))
    {
        return Err(format!(
            "{host} is on this machine or network and cannot be contacted."
        ));
    }
    let scheme = url.scheme();
    Ok(match url.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

/// Whether `ip` is an address on the public internet. Everything else —
/// loopback, private, link-local, CGNAT, multicast, reserved, documentation,
/// and IPv6 forms that embed one of those — is refused.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            // NAT64 (64:ff9b::/96) carries an IPv4 address in its low bits.
            if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
                let v4 =
                    Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
                return is_public_v4(v4);
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link local fe80::/10
                || (s[0] & 0xffc0) == 0xfec0 // site local (deprecated) fec0::/10
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || v6 == Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 1))
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || o[0] == 0 // 0.0.0.0/8
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // CGNAT 100.64/10
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF 192.0.0/24
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // benchmarking 198.18/15
        || o[0] >= 240) // reserved + broadcast
}

// ── Session state: once-grants, request rate, in-flight count ───────────────

#[derive(Default)]
struct Session {
    /// Hosts allowed for this run of the app only, per page.
    once: HashMap<String, HashSet<String>>,
    /// Recent request instants per page, for the rate cap.
    recent: HashMap<String, Vec<Instant>>,
    /// `MAX_IN_FLIGHT` permits per page.
    in_flight: HashMap<String, Arc<Semaphore>>,
}

fn session() -> &'static Mutex<Session> {
    static SESSION: OnceLock<Mutex<Session>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(Session::default()))
}

/// Allow `host` for the page `key` (a principal key) until the app quits.
pub fn grant_for_session(key: &str, host: &str) {
    if let Ok(mut s) = session().lock() {
        s.once
            .entry(key.to_string())
            .or_default()
            .insert(host.to_string());
    }
}

/// Drop every session grant (e.g. "Clear all" in Settings).
pub fn clear_session_grants(key: Option<&str>) {
    if let Ok(mut s) = session().lock() {
        match key {
            Some(id) => {
                s.once.remove(id);
            }
            None => s.once.clear(),
        }
    }
}

/// Hosts allowed for the page `key` (a principal key) for this run of the app.
pub fn session_hosts(key: &str) -> Vec<String> {
    session()
        .lock()
        .map(|s| {
            let mut hosts: Vec<String> = s
                .once
                .get(key)
                .map(|h| h.iter().cloned().collect())
                .unwrap_or_default();
            hosts.sort();
            hosts
        })
        .unwrap_or_default()
}

pub fn revoke_session_grant(key: &str, host: &str) {
    if let Ok(mut s) = session().lock() {
        if let Some(hosts) = s.once.get_mut(key) {
            hosts.remove(host);
        }
    }
}

pub fn has_session_grant(key: &str, host: &str) -> bool {
    session()
        .lock()
        .map(|s| s.once.get(key).is_some_and(|hosts| hosts.contains(host)))
        .unwrap_or(false)
}

/// Take a request slot for the page `key` (a principal key): refused over the rate cap, otherwise
/// waits until fewer than [`MAX_IN_FLIGHT`] of its requests are running. The
/// returned guard frees the slot when dropped.
pub async fn reserve_slot(key: &str) -> Result<SlotGuard, String> {
    let permits = {
        let mut s = session()
            .lock()
            .map_err(|_| "Network state unavailable.".to_string())?;
        let now = Instant::now();
        let recent = s.recent.entry(key.to_string()).or_default();
        recent.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        if recent.len() >= MAX_REQUESTS_PER_MINUTE {
            return Err(format!(
                "This page made more than {MAX_REQUESTS_PER_MINUTE} requests in a minute; wait and try again."
            ));
        }
        recent.push(now);
        s.in_flight
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_IN_FLIGHT)))
            .clone()
    };
    let permit = permits
        .acquire_owned()
        .await
        .map_err(|_| "Network state unavailable.".to_string())?;
    Ok(SlotGuard { _permit: permit })
}

#[derive(Debug)]
pub struct SlotGuard {
    _permit: OwnedSemaphorePermit,
}

// ── The request ──────────────────────────────────────────────────────────────

/// Which addresses a request may connect to. Always [`AddressPolicy::APP`] in
/// the app — https to public addresses only. Tests turn `public_only` off to
/// talk to a plain-http server on loopback.
#[derive(Clone, Copy)]
pub struct AddressPolicy {
    pub public_only: bool,
}

impl AddressPolicy {
    pub const APP: AddressPolicy = AddressPolicy { public_only: true };
}

/// Resolve `host:port` and return one address the policy allows, refusing
/// the name if **any** address it resolves to is not allowed — a name that
/// answers both public and private addresses is not a public name.
async fn resolve_checked(
    host: &str,
    port: u16,
    policy: AddressPolicy,
) -> Result<SocketAddr, String> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("Could not look up {host}: {e}"))?
        .collect();
    let first = *addrs
        .first()
        .ok_or_else(|| format!("{host} did not resolve to any address."))?;
    if policy.public_only {
        if let Some(bad) = addrs.iter().find(|a| !is_public_ip(a.ip())) {
            return Err(format!(
                "{host} points to {} — a private or local address — so it cannot be contacted.",
                bad.ip()
            ));
        }
    }
    Ok(first)
}

/// `<App>-Artifact/<version>`: the product name (white-label builds send their
/// own) and nothing that identifies the reader.
fn user_agent() -> String {
    format!(
        "{}-Artifact/{}",
        crate::brand::app_name().replace(char::is_whitespace, "-"),
        env!("CARGO_PKG_VERSION")
    )
}

/// Make `req` after the caller has checked the grant. A redirect is followed
/// when it stays on the same site (see [`same_site`]) or `allowed` says the
/// reader allowed its origin; otherwise it ends with a
/// [`REDIRECT_ERROR_PREFIX`] error naming the origin. Every hop is resolved
/// and pinned afresh.
pub async fn perform(
    req: &ArtifactFetchRequest,
    policy: AddressPolicy,
    allowed: &(dyn Fn(&str) -> bool + Send + Sync),
) -> Result<ArtifactFetchResponse, String> {
    perform_capped(req, policy, allowed, MAX_RESPONSE_BYTES).await
}

/// [`perform`] with a different response size limit, for readers that take
/// whole documents ([`MAX_DOCUMENT_RESPONSE_BYTES`]).
pub async fn perform_capped(
    req: &ArtifactFetchRequest,
    policy: AddressPolicy,
    allowed: &(dyn Fn(&str) -> bool + Send + Sync),
    max_response_bytes: usize,
) -> Result<ArtifactFetchResponse, String> {
    let method = req.method.to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!("The {method} method is not allowed."));
    }
    let body = match &req.body {
        Some(b64) => {
            let bytes = B64
                .decode(b64)
                .map_err(|_| "The request body could not be read.".to_string())?;
            if bytes.len() > MAX_REQUEST_BYTES {
                return Err(format!(
                    "The request body is {} bytes; the limit is {MAX_REQUEST_BYTES}.",
                    bytes.len()
                ));
            }
            Some(bytes)
        }
        None => None,
    };
    let granted = origin_for(&req.url, policy)?;

    let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
    let mut url = url::Url::parse(&req.url).map_err(|e| e.to_string())?;
    let mut method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut body = body;

    for hop in 0..=MAX_REDIRECTS {
        let origin = origin_for(url.as_str(), policy)?;
        if origin != granted && !same_site(&granted, &origin) && !allowed(&origin) {
            return Err(format!(
                "{REDIRECT_ERROR_PREFIX}{origin} The server redirected to {}, which this page has not been allowed to contact.",
                url.host_str().unwrap_or("another site")
            ));
        }
        let host = url.host_str().unwrap_or_default().to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        let addr = resolve_checked(&host, port, policy).await?;

        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, addr)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(user_agent())
            .build()
            .map_err(|e| e.to_string())?;

        let mut builder = client.request(method.clone(), url.clone());
        for (name, value) in &req.headers {
            let lower = name.to_ascii_lowercase();
            if BLOCKED_REQUEST_HEADERS.contains(&lower.as_str())
                || lower.starts_with("sec-")
                || lower.starts_with("proxy-")
            {
                continue;
            }
            builder = builder.header(name.as_str(), value.as_str());
        }
        if let Some(bytes) = &body {
            builder = builder.body(bytes.clone());
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let mut response = tokio::time::timeout(remaining, builder.send())
            .await
            .map_err(|_| "The request took longer than 20 seconds.".to_string())?
            .map_err(|e| format!("The request failed: {}", without_url(&e)))?;

        if response.status().is_redirection() {
            if let Some(location) = response.headers().get(reqwest::header::LOCATION) {
                if hop == MAX_REDIRECTS {
                    return Err("The server redirected too many times.".to_string());
                }
                let location = location
                    .to_str()
                    .map_err(|_| "The server sent an unreadable redirect.".to_string())?;
                url = url
                    .join(location)
                    .map_err(|_| "The server sent an invalid redirect.".to_string())?;
                // 303, and 301/302 after a POST, continue as a GET without a body.
                let status = response.status().as_u16();
                if status == 303
                    || ((status == 301 || status == 302) && method == reqwest::Method::POST)
                {
                    method = reqwest::Method::GET;
                    body = None;
                }
                continue;
            }
        }

        let status = response.status();
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| !BLOCKED_RESPONSE_HEADERS.contains(&name.as_str()))
            .filter_map(|(name, value)| {
                Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
            })
            .collect();
        let mut bytes: Vec<u8> = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let chunk = tokio::time::timeout(remaining, response.chunk())
                .await
                .map_err(|_| "The response took longer than 20 seconds.".to_string())?
                .map_err(|e| format!("The response failed: {}", without_url(&e)))?;
            let Some(chunk) = chunk else { break };
            if bytes.len() + chunk.len() > max_response_bytes {
                return Err(format!(
                    "The response is larger than {} MB, the limit for a page.",
                    max_response_bytes / (1024 * 1024)
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(ArtifactFetchResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            headers,
            body: B64.encode(bytes),
            url: url.to_string(),
        });
    }
    Err("The server redirected too many times.".to_string())
}

/// reqwest's error text includes the URL, which the page already has; keep the
/// cause readable.
fn without_url(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    if let Some(url) = error.url() {
        text = text.replace(&format!(" for url ({url})"), "");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_host_keeps_https_origins_and_refuses_the_rest() {
        assert_eq!(
            grant_host("https://API.Open-Meteo.com/v1/forecast?x=1").unwrap(),
            "https://api.open-meteo.com"
        );
        assert_eq!(
            grant_host("https://example.com:8443/a").unwrap(),
            "https://example.com:8443"
        );
        assert_eq!(
            grant_host("https://example.com:443/a").unwrap(),
            "https://example.com"
        );
        assert!(grant_host("http://example.com/").is_err());
        assert!(grant_host("ftp://example.com/").is_err());
        assert!(grant_host("https://user:pw@example.com/").is_err());
        assert!(grant_host("https://localhost/").is_err());
        assert!(grant_host("https://printer.local/").is_err());
        assert!(grant_host("not a url").is_err());
    }

    #[test]
    fn only_public_addresses_are_public() {
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "198.18.0.1",
            "192.0.0.8",
            "240.0.0.1",
            "::1",
            "::",
            "fc00::1",
            "fd12::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.0.1",
            "64:ff9b::a00:1",
            "2001:db8::1",
        ] {
            assert!(
                !is_public_ip(private.parse().unwrap()),
                "{private} must be refused"
            );
        }
        for public in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(is_public_ip(public.parse().unwrap()), "{public} is public");
        }
    }

    #[tokio::test]
    async fn requests_over_the_in_flight_cap_wait_and_the_rate_cap_refuses() {
        let id = "rate-test-artifact";
        let mut guards = Vec::new();
        for _ in 0..MAX_IN_FLIGHT {
            guards.push(reserve_slot(id).await.expect("under the in-flight cap"));
        }
        let waiting = tokio::spawn(async move { reserve_slot(id).await.map(|_| ()) });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(), "the fifth request waits");
        guards.pop();
        tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .expect("runs once a slot frees")
            .unwrap()
            .expect("not refused");
        guards.clear();
        for _ in 0..(MAX_REQUESTS_PER_MINUTE - MAX_IN_FLIGHT - 1) {
            drop(reserve_slot(id).await.expect("under the rate cap"));
        }
        assert!(reserve_slot(id).await.unwrap_err().contains("in a minute"));
    }

    #[test]
    fn session_grants_are_per_artifact() {
        grant_for_session("a1", "https://example.com");
        assert!(has_session_grant("a1", "https://example.com"));
        assert!(!has_session_grant("a2", "https://example.com"));
        clear_session_grants(Some("a1"));
        assert!(!has_session_grant("a1", "https://example.com"));
    }

    #[test]
    fn a_redirect_is_the_same_site_only_under_the_same_owner() {
        assert!(same_site("https://example.com", "https://www.example.com"));
        assert!(same_site("https://www.example.com", "https://example.com"));
        assert!(same_site("https://example.com", "https://api.example.com"));
        assert!(!same_site(
            "https://api.frankfurter.app",
            "https://api.frankfurter.dev"
        ));
        assert!(!same_site("https://foo.co.uk", "https://evil.co.uk"));
        assert!(!same_site("https://api.example.com", "https://example.com"));
    }

    #[test]
    fn any_site_is_a_valid_grant() {
        assert_eq!(grant_host(ANY_SITE).unwrap(), ANY_SITE);
    }
}
