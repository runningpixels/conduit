//! Serves HTML artifact documents to their iframes from a dedicated origin.
//!
//! Artifacts used to render through `srcdoc`, which inherits the embedding
//! page's CSP. In release builds Tauri serves the main page with the app CSP
//! (`script-src 'self'` plus hashes), so no artifact script ever ran: not the
//! model's code, and not Conduit's injected bridges. A frame that navigates to
//! a real URL gets a fresh policy instead, so the document's own CSP meta
//! (assembled by the renderer, first in `<head>`) is the one that applies.
//!
//! Flow: the renderer assembles the document, hands it to [`ArtifactFrames::put`]
//! over IPC and gets back an unguessable token, then points the iframe at
//! `conduit-artifact://localhost/<token>` (`http://conduit-artifact.localhost/<token>`
//! on Windows). The protocol handler looks the token up. The iframe keeps
//! `sandbox="allow-scripts"`, so the document still runs with an opaque origin.
//!
//! Documents are held in memory only, capped by count and bytes; the renderer
//! drops a token when its frame goes away.
//!
//! A page with full web access (ADR-007) is the exception: its document is
//! stored for one page origin ([`ArtifactFrames::put_page`]) and served only by
//! the loopback page server (`page_server`) under that origin's host, never
//! through the scheme. The same store mints the one-shot tokens of that
//! server's "clear site data" route.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::http::{header, Request, Response, StatusCode};

/// URI scheme the protocol is registered under.
pub const SCHEME: &str = "conduit-artifact";
/// Largest single document accepted (the renderer's own cap is lower).
pub const MAX_DOC_BYTES: usize = 32 * 1024 * 1024;
/// Documents kept at once; the oldest is evicted past this.
const MAX_DOCS: usize = 32;
/// Total bytes kept at once; the oldest are evicted past this.
const MAX_TOTAL_BYTES: usize = 96 * 1024 * 1024;
/// "Clear site data" tokens outstanding at once; the oldest goes past this.
const MAX_CLEARS: usize = 64;
/// How long a "clear site data" token stays usable if never loaded.
const CLEAR_TTL: Duration = Duration::from_secs(60);

/// The store is shared: Tauri's managed state and the page server each hold a
/// clone.
#[derive(Default, Clone)]
pub struct ArtifactFrames {
    inner: Arc<Mutex<Store>>,
}

/// A document served from its page's own origin by the page server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageDoc {
    /// The page id: the first label of the origin's host.
    pub page_id: String,
    /// The `Content-Security-Policy` header the page server sends with it.
    pub csp: String,
}

#[derive(Default)]
struct Store {
    docs: HashMap<String, Arc<String>>,
    order: VecDeque<String>,
    total: usize,
    /// Tokens of documents rendered with full web access (ADR-007). While
    /// any is stored, the guard proxy lets loads through.
    full: HashSet<String>,
    /// Tokens of documents served by the page server, with their origin.
    pages: HashMap<String, PageDoc>,
    /// One-shot "clear site data" tokens: page id, when minted, and a
    /// sequence number that orders them for eviction.
    clears: HashMap<String, (String, Instant, u64)>,
    clear_seq: u64,
}

impl ArtifactFrames {
    /// Store a document and return the token that serves it.
    pub fn put(&self, html: String) -> Result<String, String> {
        self.put_with(html, false)
    }

    /// Store a full-web-access document for the page server: served only at
    /// `page`'s origin (its id in the Host), never through the scheme.
    pub fn put_page(&self, html: String, page: PageDoc) -> Result<String, String> {
        self.insert(html, true, Some(page))
    }

    /// The document behind `token`, if it was stored for `page_id`'s origin.
    pub fn page_doc(&self, token: &str, page_id: &str) -> Option<(Arc<String>, PageDoc)> {
        let store = self.inner.lock().ok()?;
        let page = store.pages.get(token).filter(|p| p.page_id == page_id)?;
        Some((store.docs.get(token)?.clone(), page.clone()))
    }

    /// Mint a one-shot token for `page_id`'s "clear site data" route.
    pub fn mint_clear(&self, page_id: &str) -> Result<String, String> {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mut store = self.inner.lock().map_err(|_| "frame store poisoned")?;
        let now = Instant::now();
        store
            .clears
            .retain(|_, (_, minted, _)| now.duration_since(*minted) < CLEAR_TTL);
        while store.clears.len() >= MAX_CLEARS {
            let oldest = store
                .clears
                .iter()
                .min_by_key(|(_, (_, _, seq))| *seq)
                .map(|(t, _)| t.clone());
            match oldest {
                Some(t) => store.clears.remove(&t),
                None => break,
            };
        }
        store.clear_seq += 1;
        let seq = store.clear_seq;
        store
            .clears
            .insert(token.clone(), (page_id.to_string(), now, seq));
        Ok(token)
    }

    /// Use up a "clear site data" token: true once, for its own page, while
    /// it is fresh.
    pub fn take_clear(&self, token: &str, page_id: &str) -> bool {
        let Ok(mut store) = self.inner.lock() else {
            return false;
        };
        let matches = store
            .clears
            .get(token)
            .is_some_and(|(id, minted, _)| id == page_id && minted.elapsed() < CLEAR_TTL);
        if matches {
            store.clears.remove(token);
        }
        matches
    }

    /// Whether a page with full web access is on screen: its document is
    /// stored (the renderer drops a token when its frame goes away).
    pub fn has_full_access_frames(&self) -> bool {
        self.inner.lock().is_ok_and(|store| !store.full.is_empty())
    }

    /// [`Self::put`], marking the document as one with full web access.
    pub fn put_with(&self, html: String, full_access: bool) -> Result<String, String> {
        self.insert(html, full_access, None)
    }

    fn insert(
        &self,
        html: String,
        full_access: bool,
        page: Option<PageDoc>,
    ) -> Result<String, String> {
        if html.len() > MAX_DOC_BYTES {
            return Err("This page is too large to preview.".to_string());
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mut store = self.inner.lock().map_err(|_| "frame store poisoned")?;
        store.total += html.len();
        store.docs.insert(token.clone(), Arc::new(html));
        store.order.push_back(token.clone());
        if full_access {
            store.full.insert(token.clone());
        }
        if let Some(page) = page {
            store.pages.insert(token.clone(), page);
        }
        while store.order.len() > MAX_DOCS || store.total > MAX_TOTAL_BYTES {
            let Some(oldest) = store.order.pop_front() else {
                break;
            };
            if oldest == token {
                store.order.push_front(oldest);
                break;
            }
            if let Some(doc) = store.docs.remove(&oldest) {
                store.total -= doc.len();
            }
            store.full.remove(&oldest);
            store.pages.remove(&oldest);
        }
        Ok(token)
    }

    /// Forget a document. Unknown tokens are ignored.
    pub fn drop_token(&self, token: &str) {
        let Ok(mut store) = self.inner.lock() else {
            return;
        };
        if let Some(doc) = store.docs.remove(token) {
            store.total -= doc.len();
            store.order.retain(|t| t != token);
        }
        store.full.remove(token);
        store.pages.remove(token);
        store.clears.remove(token);
    }

    /// A document for the scheme: never one stored for a page origin.
    fn get(&self, token: &str) -> Option<Arc<String>> {
        let store = self.inner.lock().ok()?;
        if store.pages.contains_key(token) {
            return None;
        }
        store.docs.get(token).cloned()
    }

    /// Answer a protocol request: `GET /<token>` serves the stored document.
    pub fn respond(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        if request.method() != tauri::http::Method::GET {
            return status(StatusCode::METHOD_NOT_ALLOWED);
        }
        let token = request.uri().path().trim_start_matches('/');
        if !is_token(token) {
            return status(StatusCode::NOT_FOUND);
        }
        match self.get(token) {
            Some(doc) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-store")
                .header("X-Content-Type-Options", "nosniff")
                .header("Referrer-Policy", "no-referrer")
                .body(doc.as_bytes().to_vec())
                .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR)),
            None => status(StatusCode::NOT_FOUND),
        }
    }
}

/// Tokens are 32 lowercase hex characters (a simple-format v4 UUID).
pub(crate) fn is_token(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .body(Vec::new())
        .expect("static response")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(uri: &str) -> Request<Vec<u8>> {
        Request::builder().uri(uri).body(Vec::new()).unwrap()
    }

    #[test]
    fn serves_a_stored_document_as_html() {
        let frames = ArtifactFrames::default();
        let token = frames.put("<p>hi</p>".into()).unwrap();
        let res = frames.respond(&get(&format!("http://conduit-artifact.localhost/{token}")));
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"<p>hi</p>");
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
        // Same token through the non-Windows URL form.
        let res = frames.respond(&get(&format!("conduit-artifact://localhost/{token}")));
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[test]
    fn unknown_malformed_and_dropped_tokens_are_not_found() {
        let frames = ArtifactFrames::default();
        let token = frames.put("x".into()).unwrap();
        for path in [
            "/",
            "/nope",
            "/../etc/passwd",
            &format!("/{}", token.to_uppercase()),
        ] {
            let res = frames.respond(&get(&format!("conduit-artifact://localhost{path}")));
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path}");
        }
        frames.drop_token(&token);
        let res = frames.respond(&get(&format!("conduit-artifact://localhost/{token}")));
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn only_get_is_served() {
        let frames = ArtifactFrames::default();
        let token = frames.put("x".into()).unwrap();
        let req = Request::builder()
            .method("POST")
            .uri(format!("conduit-artifact://localhost/{token}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            frames.respond(&req).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[test]
    fn evicts_the_oldest_past_the_count_cap_but_keeps_the_newest() {
        let frames = ArtifactFrames::default();
        let first = frames.put("first".into()).unwrap();
        let mut last = String::new();
        for i in 0..MAX_DOCS {
            last = frames.put(format!("doc {i}")).unwrap();
        }
        assert!(frames.get(&first).is_none());
        assert!(frames.get(&last).is_some());
        let store = frames.inner.lock().unwrap();
        assert_eq!(store.docs.len(), MAX_DOCS);
        assert_eq!(
            store.total,
            store.docs.values().map(|d| d.len()).sum::<usize>()
        );
    }

    #[test]
    fn full_access_frames_are_tracked_until_dropped_or_evicted() {
        let frames = ArtifactFrames::default();
        let plain = frames.put("plain".into()).unwrap();
        assert!(!frames.has_full_access_frames());
        let full = frames.put_with("full".into(), true).unwrap();
        assert!(frames.has_full_access_frames());
        frames.drop_token(&plain);
        assert!(frames.has_full_access_frames());
        frames.drop_token(&full);
        assert!(!frames.has_full_access_frames());

        frames.put_with("full again".into(), true).unwrap();
        for i in 0..MAX_DOCS {
            frames.put(format!("doc {i}")).unwrap();
        }
        assert!(
            !frames.has_full_access_frames(),
            "an evicted document no longer holds the proxy open"
        );
    }

    fn page(id: &str) -> PageDoc {
        PageDoc {
            page_id: id.to_string(),
            csp: "default-src 'none'".to_string(),
        }
    }

    #[test]
    fn page_documents_are_served_only_for_their_own_page_and_never_by_the_scheme() {
        let frames = ArtifactFrames::default();
        let token = frames.put_page("<p>p</p>".into(), page("aa")).unwrap();
        assert!(frames.has_full_access_frames());
        let (doc, served) = frames.page_doc(&token, "aa").unwrap();
        assert_eq!(doc.as_str(), "<p>p</p>");
        assert_eq!(served, page("aa"));
        assert!(frames.page_doc(&token, "bb").is_none());
        let res = frames.respond(&get(&format!("conduit-artifact://localhost/{token}")));
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        // A plain document is not a page document.
        let plain = frames.put("x".into()).unwrap();
        assert!(frames.page_doc(&plain, "aa").is_none());
        frames.drop_token(&token);
        assert!(frames.page_doc(&token, "aa").is_none());
        assert!(!frames.has_full_access_frames());
    }

    #[test]
    fn clear_tokens_work_once_for_their_own_page() {
        let frames = ArtifactFrames::default();
        let token = frames.mint_clear("aa").unwrap();
        assert!(!frames.take_clear(&token, "bb"));
        assert!(frames.take_clear(&token, "aa"));
        assert!(!frames.take_clear(&token, "aa"), "one shot");
        let dropped = frames.mint_clear("aa").unwrap();
        frames.drop_token(&dropped);
        assert!(!frames.take_clear(&dropped, "aa"));
        // Capped: the oldest goes first.
        let first = frames.mint_clear("aa").unwrap();
        for _ in 0..MAX_CLEARS {
            frames.mint_clear("aa").unwrap();
        }
        assert!(!frames.take_clear(&first, "aa"));
        assert!(frames.inner.lock().unwrap().clears.len() <= MAX_CLEARS);
    }

    #[test]
    fn rejects_oversized_documents() {
        let frames = ArtifactFrames::default();
        assert!(frames.put("x".repeat(MAX_DOC_BYTES + 1)).is_err());
    }
}
