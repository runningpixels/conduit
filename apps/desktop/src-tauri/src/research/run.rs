//! The research loop: search → read → extract → check gaps, round by round,
//! until every sub-question has verified claims, the rounds run out, or the
//! budget is spent; then the report.
//!
//! - Every round searches each open sub-question (its own text first, then the
//!   gap checker's follow-up queries, at most two per sub-question per round).
//! - Pages come only from search results: deduplicated by canonical address,
//!   public web addresses only, avoided domains dropped, preferred domains and
//!   new hosts first, at most [`MAX_PAGES_PER_HOST`] pages per host per run.
//! - The budget (searches, pages, tokens, minutes) and the user's Stop end the
//!   loop cleanly: what was verified is kept and the report is still written
//!   (by code alone when the model budget or time is gone, or the user
//!   stopped), saying why it ended early.
//! - A search that answers "429" or mentions a rate limit is tried twice more,
//!   after 2 s and then 6 s.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use provider_core::schema::{
    ResearchBrief, ResearchBudget, ResearchProgress, ResearchSourceStatus,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::claims::SourceRating;
use super::report::{self, Draft, Labelled, Rendered, ReportInput};
use super::{
    ask_json, claims, clip, one_line, today, urls, verify, FetchedPage, ResearchIo, SearchHit,
};
use crate::time::now_iso8601;
use crate::workflows::extract;

/// Most pages read from one host in a run.
pub const MAX_PAGES_PER_HOST: u32 = 3;
/// Pages read per search, at most.
pub const PAGES_PER_SEARCH: usize = 3;
/// Pages fetched and extracted at once (polite to sites, and to the model).
pub const CONCURRENT_PAGES: usize = 3;
/// Search rounds, the first included.
pub const MAX_ROUNDS: usize = 3;
/// Follow-up searches per sub-question per round.
pub const MAX_FOLLOW_UPS: usize = 2;
/// Waits before the two retries of a rate-limited search.
pub const RATE_LIMIT_WAITS: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(6)];
/// Claims per sub-question shown to the gap checker.
const GAP_CLAIMS_PER_QUESTION: usize = 8;

/// A page the run read, or tried to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRecord {
    pub id: String,
    /// The search result's address.
    pub url: String,
    /// Where it ended up after redirects, when that differs.
    pub final_url: Option<String>,
    pub title: Option<String>,
    pub host: String,
    pub fetched_at: String,
    pub status: ResearchSourceStatus,
    /// Readable text (empty unless read).
    pub text: String,
    pub content_hash: Option<String>,
    /// The extractor's rating of the page (medium unless it said otherwise).
    /// Kept in memory only: the report shows it, the database doesn't.
    pub rating: SourceRating,
    /// The sub-question (0-based) whose search chose the page, so an
    /// unanswered one can name the pages it lost. In memory only.
    pub sub_question: Option<usize>,
}

impl SourceRecord {
    /// The address to show and link.
    pub fn shown_url(&self) -> &str {
        self.final_url.as_deref().unwrap_or(&self.url)
    }
}

/// A claim the extractor made, with the quote check's verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimRecord {
    pub id: String,
    /// 0-based index into the brief's sub-questions.
    pub sub_question: usize,
    pub claim: String,
    pub quote: String,
    pub source_id: String,
    pub verified: bool,
}

/// Why a run ended before it was done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// The user pressed Stop.
    User,
    Searches,
    Pages,
    Tokens,
    Time,
}

/// What a run produced.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub sources: Vec<SourceRecord>,
    pub claims: Vec<ClaimRecord>,
    pub unverified_dropped: u32,
    /// Sub-questions (text) with no verified claim.
    pub unanswered: Vec<String>,
    /// `None` only when the run failed before verifying anything.
    pub report: Option<Rendered>,
    pub stop: Option<StopReason>,
    /// A failure that ended the run (a model call that failed).
    pub error: Option<String>,
    pub progress: ResearchProgress,
}

/// Runs one approved brief.
pub struct Engine<'a> {
    pub io: &'a dyn ResearchIo,
    pub stop: CancellationToken,
    pub budget: ResearchBudget,
    /// Hears every progress change (the caller throttles).
    pub on_progress: Option<&'a (dyn Fn(&ResearchProgress) + Send + Sync)>,
    /// Waits before retrying a rate-limited search; tests shorten them.
    pub rate_limit_waits: [Duration; 2],
    /// The run's date (`YYYY-MM-DD`): the report's, and the "today" the gap
    /// checker, writer and reviewer are told. Today when `None`.
    pub date: Option<String>,
}

impl<'a> Engine<'a> {
    pub fn new(io: &'a dyn ResearchIo, stop: CancellationToken, budget: ResearchBudget) -> Self {
        Self {
            io,
            stop,
            budget,
            on_progress: None,
            rate_limit_waits: RATE_LIMIT_WAITS,
            date: None,
        }
    }
}

/// Why a guarded call didn't finish.
type Halted = StopReason;

/// Counts model tokens: what the backend reports, or an estimate (a token
/// per four characters in and out) when it reports nothing.
struct Metered<'a> {
    inner: &'a dyn ResearchIo,
    estimate: AtomicU64,
}

impl Metered<'_> {
    fn tokens(&self) -> u64 {
        self.inner
            .tokens_used()
            .unwrap_or_else(|| self.estimate.load(Ordering::Relaxed))
    }
}

#[async_trait]
impl ResearchIo for Metered<'_> {
    async fn search(&self, query: &str) -> Result<Vec<SearchHit>, String> {
        self.inner.search(query).await
    }
    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        self.inner.fetch(url).await
    }
    async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
        let reply = self.inner.complete(system, user).await;
        let chars = system.chars().count()
            + user.chars().count()
            + reply.as_ref().map(|r| r.chars().count()).unwrap_or(0);
        self.estimate
            .fetch_add(chars.div_ceil(4) as u64, Ordering::Relaxed);
        reply
    }
    fn tokens_used(&self) -> Option<u64> {
        Some(self.tokens())
    }
}

/// The run's working state.
struct Work<'b> {
    brief: &'b ResearchBrief,
    started: Instant,
    /// The run's date, `YYYY-MM-DD`.
    today: String,
    progress: ResearchProgress,
    sources: Vec<SourceRecord>,
    claims: Vec<ClaimRecord>,
    dropped: u32,
    /// Canonical addresses already read or tried.
    seen: HashSet<String>,
    per_host: HashMap<String, u32>,
    /// Lowercased queries already searched.
    searched: HashSet<String>,
    /// Normalised quote + source, to skip a claim made twice.
    claim_keys: HashSet<String>,
    search_errors: Vec<String>,
}

impl Work<'_> {
    fn verified_for(&self, sub_question: usize) -> usize {
        self.claims
            .iter()
            .filter(|c| c.verified && c.sub_question == sub_question)
            .count()
    }
}

impl Engine<'_> {
    /// Run `brief` to the end and return everything it found. Never fails:
    /// a failure is recorded in [`Outcome::error`] with what was kept.
    pub async fn run(&self, brief: &ResearchBrief) -> Outcome {
        let metered = Metered {
            inner: self.io,
            estimate: AtomicU64::new(0),
        };
        let mut work = Work {
            brief,
            started: Instant::now(),
            today: self.date.clone().unwrap_or_else(today),
            progress: ResearchProgress {
                phase: "searching".to_string(),
                searches_limit: self.budget.searches,
                pages_limit: self.budget.pages,
                ..Default::default()
            },
            sources: Vec::new(),
            claims: Vec::new(),
            dropped: 0,
            seen: HashSet::new(),
            per_host: HashMap::new(),
            searched: HashSet::new(),
            claim_keys: HashSet::new(),
            search_errors: Vec::new(),
        };
        let (stop, mut error) = self.gather(&metered, &mut work).await;
        let mut stop = stop;

        let unanswered_idx: Vec<usize> = (0..brief.sub_questions.len())
            .filter(|i| work.verified_for(*i) == 0)
            .collect();
        let any_verified = work.claims.iter().any(|c| c.verified);
        if error.is_none()
            && !any_verified
            && !work.search_errors.is_empty()
            && work.sources.is_empty()
        {
            // Nothing was found because search itself kept failing.
            error = work.search_errors.last().cloned();
        }

        let report = if error.is_some() && !any_verified {
            None
        } else {
            let labelled =
                report::label_claims(&work.claims, &work.sources, brief.sub_questions.len());
            let model_spent = matches!(
                stop,
                Some(StopReason::User | StopReason::Tokens | StopReason::Time)
            );
            let today = work.today.as_str();
            let written = if model_spent || error.is_some() || labelled.is_empty() {
                None
            } else {
                self.set_phase(&mut work.progress, &metered, "writing", None);
                match self
                    .guarded(
                        work.started,
                        report::write(&metered, brief, &labelled, today),
                    )
                    .await
                {
                    Ok(Ok(draft)) => draft,
                    Ok(Err(e)) => {
                        tracing::warn!(error = %e, "research: the writer failed; writing the report from the claims");
                        None
                    }
                    Err(reason) => {
                        stop.get_or_insert(reason);
                        None
                    }
                }
            };
            self.set_phase(&mut work.progress, &metered, "verifying", None);
            let draft = match written {
                Some(draft) => {
                    self.review(&metered, work.started, brief, draft, &labelled, today)
                        .await
                }
                None => report::fallback_draft(brief.sub_questions.len(), &labelled),
            };
            let note = note_for(stop, error.as_deref(), &self.budget);
            Some(render_report(
                brief,
                today,
                &draft,
                &labelled,
                &work.sources,
                &unanswered_idx,
                note.as_deref(),
            ))
        };

        work.progress.tokens_used = clamp_u32(metered.tokens());
        Outcome {
            unanswered: unanswered_idx
                .iter()
                .filter_map(|i| brief.sub_questions.get(*i).cloned())
                .collect(),
            sources: work.sources,
            claims: work.claims,
            unverified_dropped: work.dropped,
            report,
            stop,
            error,
            progress: work.progress,
        }
    }

    /// The search/read/extract rounds. Returns why they ended early, if they
    /// did, and a failure that ended them.
    ///
    /// Each round searches every open sub-question first, then reads the
    /// pages it chose [`CONCURRENT_PAGES`] at a time (fetch, then extract),
    /// handling the results in page order so claims keep a stable order.
    async fn gather(
        &self,
        io: &Metered<'_>,
        work: &mut Work<'_>,
    ) -> (Option<StopReason>, Option<String>) {
        let brief = work.brief;
        let scope = brief.scope.as_deref().unwrap_or_default();
        let mut queue: Vec<(usize, String)> = brief
            .sub_questions
            .iter()
            .enumerate()
            .map(|(i, q)| (i, one_line(&format!("{q} {scope}"))))
            .collect();

        for round in 0..MAX_ROUNDS {
            // Each page with the sub-question whose search chose it.
            let mut pending: Vec<(usize, String)> = Vec::new();
            let mut halt: Option<StopReason> = None;
            for (sub_question, query) in std::mem::take(&mut queue) {
                if let Some(reason) = self.halted(work, io) {
                    return (Some(reason), None);
                }
                if work.progress.searches_used >= self.budget.searches {
                    // Read what was already chosen, then stop.
                    halt = Some(StopReason::Searches);
                    break;
                }
                if !work.searched.insert(query.to_lowercase()) {
                    continue;
                }
                work.progress.searches_used += 1;
                self.set_phase(&mut work.progress, io, "searching", None);
                let hits = match self.search(work.started, io, &query).await {
                    Ok(Ok(hits)) => hits,
                    Ok(Err(e)) => {
                        tracing::info!(error = %e, "research: a search failed");
                        work.search_errors.push(e);
                        continue;
                    }
                    Err(reason) => return (Some(reason), None),
                };
                for url in choose(&hits, brief, &work.seen, &work.per_host) {
                    if let Some(canonical) = urls::canonical(&url) {
                        work.seen.insert(canonical);
                    }
                    *work
                        .per_host
                        .entry(urls::host(&url).unwrap_or_default())
                        .or_default() += 1;
                    pending.push((sub_question, url));
                }
            }
            match self.read_all(io, work, pending).await {
                Ok(()) => {}
                Err(Fail::Halt(reason)) => return (Some(reason), None),
                Err(Fail::Error(e)) => return (None, Some(e)),
            }
            if let Some(reason) = halt {
                return (Some(reason), None);
            }
            if round + 1 == MAX_ROUNDS {
                break;
            }
            if let Some(reason) = self.halted(work, io) {
                return (Some(reason), None);
            }
            if work.progress.searches_used >= self.budget.searches {
                let open = (0..brief.sub_questions.len()).any(|i| work.verified_for(i) == 0);
                return (open.then_some(StopReason::Searches), None);
            }
            self.set_phase(&mut work.progress, io, "checking gaps", None);
            match self.guarded(work.started, gap_check(io, work)).await {
                Ok(Ok(Some(follow_ups))) => {
                    queue = follow_ups
                        .into_iter()
                        .filter(|(_, q)| !work.searched.contains(&q.to_lowercase()))
                        .collect();
                }
                Ok(Ok(None)) => break,
                Ok(Err(e)) => return (None, Some(e)),
                Err(reason) => return (Some(reason), None),
            }
            if queue.is_empty() {
                break;
            }
        }
        (None, None)
    }

    /// Read `urls`, [`CONCURRENT_PAGES`] at a time, within the page budget;
    /// keep each page and its checked claims, in page order. Pages finished
    /// before a stop or failure are kept.
    async fn read_all(
        &self,
        io: &Metered<'_>,
        work: &mut Work<'_>,
        urls: Vec<(usize, String)>,
    ) -> Result<(), Fail> {
        let mut rest = urls.as_slice();
        while !rest.is_empty() {
            if let Some(reason) = self.halted(work, io) {
                return Err(Fail::Halt(reason));
            }
            let left = self.budget.pages.saturating_sub(work.progress.pages_read) as usize;
            if left == 0 {
                return Err(Fail::Halt(StopReason::Pages));
            }
            let take = rest.len().min(CONCURRENT_PAGES).min(left);
            let (batch, after) = rest.split_at(take);
            rest = after;
            work.progress.pages_read += take as u32;

            let shared = Mutex::new(work.progress.clone());
            let started = work.started;
            let subs = &work.brief.sub_questions;
            let pages = futures::future::join_all(
                batch
                    .iter()
                    .map(|(sub, url)| self.read_page(io, started, subs, *sub, url, &shared)),
            )
            .await;
            work.progress = shared.into_inner().unwrap_or_else(|e| e.into_inner());

            let mut ended: Option<Fail> = None;
            for page in pages {
                if let Err(fail) = self.keep_page(work, page) {
                    ended.get_or_insert(fail);
                }
            }
            work.progress.claims = work.claims.iter().filter(|c| c.verified).count() as u32;
            self.set_phase(&mut work.progress, io, "extracting", None);
            if let Some(fail) = ended {
                return Err(fail);
            }
        }
        Ok(())
    }

    /// Fetch one page and, if it has text, extract its claims. Touches only
    /// the shared progress, so several run at once.
    async fn read_page(
        &self,
        io: &Metered<'_>,
        started: Instant,
        sub_questions: &[String],
        chosen_for: usize,
        url: &str,
        progress: &Mutex<ResearchProgress>,
    ) -> PageRead {
        let note = |phase: &str| {
            if let Ok(mut p) = progress.lock() {
                self.set_phase(&mut p, io, phase, Some(url));
            }
        };
        note("reading");
        let mut source = SourceRecord {
            id: Uuid::new_v4().to_string(),
            url: url.to_string(),
            final_url: None,
            title: None,
            host: urls::host(url).unwrap_or_default(),
            fetched_at: now_iso8601(),
            status: ResearchSourceStatus::Failed,
            text: String::new(),
            content_hash: None,
            rating: SourceRating::default(),
            sub_question: Some(chosen_for),
        };
        let fetched = match self.guarded(started, io.fetch(url)).await {
            Ok(fetched) => fetched,
            Err(reason) => {
                return PageRead {
                    source: None,
                    claims: Err(Fail::Halt(reason)),
                }
            }
        };
        let page = match fetched {
            Ok(page) => page,
            Err(e) => {
                tracing::info!(%url, error = %e, "research: a page could not be read");
                return PageRead {
                    source: Some(source),
                    claims: Ok(Vec::new()),
                };
            }
        };
        if page.url != url {
            source.final_url = Some(page.url.clone());
            if let Some(host) = urls::host(&page.url) {
                source.host = host;
            }
        }
        // Titles are decoded once by the extractor; some sites double-encode
        // theirs (`&amp;mdash;`), which would still show as `&mdash;`.
        source.title = page
            .title
            .as_deref()
            .map(extract::decode_entities)
            .filter(|t| !t.trim().is_empty());
        if extract::looked_empty(&page.text) {
            source.status = ResearchSourceStatus::Empty;
            return PageRead {
                source: Some(source),
                claims: Ok(Vec::new()),
            };
        }
        source.status = ResearchSourceStatus::Read;
        source.content_hash = Some(sha256_hex(&page.text));
        source.text = page.text;
        let title = source.title.clone().unwrap_or_else(|| source.host.clone());

        note("extracting");
        let claims = match self
            .guarded(
                started,
                claims::extract(io, sub_questions, &title, &source.text),
            )
            .await
        {
            Ok(Ok(found)) => {
                source.rating = claims::floor_rating(found.rating, &source.host);
                Ok(found.claims)
            }
            Ok(Err(e)) => Err(Fail::Error(e)),
            Err(reason) => Err(Fail::Halt(reason)),
        };
        PageRead {
            source: Some(source),
            claims,
        }
    }

    /// Store a page [`read_page`](Self::read_page) returned and check its
    /// claims' quotes; the page's failure, if it ended the run.
    fn keep_page(&self, work: &mut Work<'_>, page: PageRead) -> Result<(), Fail> {
        let Some(mut source) = page.source else {
            return page.claims.map(|_| ());
        };
        // A redirect to a page already read adds nothing.
        if let Some(final_url) = &source.final_url {
            let canonical = urls::canonical(&source.url);
            if let Some(final_canonical) = urls::canonical(final_url) {
                if Some(&final_canonical) != canonical.as_ref()
                    && !work.seen.insert(final_canonical)
                {
                    source.status = ResearchSourceStatus::Skipped;
                    source.text.clear();
                    source.content_hash = None;
                    work.sources.push(source);
                    return page.claims.map(|_| ());
                }
            }
        }
        let source_id = source.id.clone();
        let normalized = verify::normalize(&source.text);
        work.sources.push(source);
        let raw = page.claims?;
        for claim in raw {
            let verified = verify::quote_in_normalized(&claim.quote, &normalized);
            let key = format!("{source_id}\u{1}{}", verify::normalize(&claim.quote));
            if !work.claim_keys.insert(key) {
                continue;
            }
            if !verified {
                work.dropped += 1;
            }
            work.claims.push(ClaimRecord {
                id: Uuid::new_v4().to_string(),
                sub_question: claim.sub_question,
                claim: claim.claim,
                quote: claim.quote,
                source_id: source_id.clone(),
                verified,
            });
        }
        Ok(())
    }

    /// Search, retrying twice when the backend says to slow down.
    async fn search(
        &self,
        started: Instant,
        io: &Metered<'_>,
        query: &str,
    ) -> Result<Result<Vec<SearchHit>, String>, Halted> {
        let mut attempt = 0;
        loop {
            let result = self.guarded(started, io.search(query)).await?;
            match result {
                Err(e) if is_rate_limit(&e) && attempt < self.rate_limit_waits.len() => {
                    let wait = self.rate_limit_waits[attempt];
                    attempt += 1;
                    tracing::info!(attempt, error = %e, "research: search rate-limited; waiting");
                    self.guarded(started, async {
                        tokio::time::sleep(wait).await;
                        Ok::<(), String>(())
                    })
                    .await?
                    .ok();
                }
                other => return Ok(other),
            }
        }
    }

    /// `work`, abandoned when the user stops the run or its time runs out.
    async fn guarded<T>(
        &self,
        started: Instant,
        call: impl Future<Output = Result<T, String>>,
    ) -> Result<Result<T, String>, Halted> {
        if self.stop.is_cancelled() {
            return Err(StopReason::User);
        }
        let left = self.time_left(started);
        if left.is_zero() {
            return Err(StopReason::Time);
        }
        tokio::select! {
            result = call => Ok(result),
            _ = self.stop.cancelled() => Err(StopReason::User),
            _ = tokio::time::sleep(left) => Err(StopReason::Time),
        }
    }

    fn time_left(&self, started: Instant) -> Duration {
        Duration::from_secs(u64::from(self.budget.minutes) * 60).saturating_sub(started.elapsed())
    }

    /// Why the run must stop now (user, time or tokens), if it must.
    fn halted(&self, work: &mut Work<'_>, io: &Metered<'_>) -> Option<StopReason> {
        work.progress.tokens_used = clamp_u32(io.tokens());
        self.halt_reason(work.started, io)
    }

    /// [`halted`](Self::halted) without recording the tokens used.
    fn halt_reason(&self, started: Instant, io: &Metered<'_>) -> Option<StopReason> {
        if self.stop.is_cancelled() {
            return Some(StopReason::User);
        }
        if self.time_left(started).is_zero() {
            return Some(StopReason::Time);
        }
        (io.tokens() >= u64::from(self.budget.tokens)).then_some(StopReason::Tokens)
    }

    /// The citation review: one call checks the writer's sentences against
    /// the claims they cite and the rest of the draft; code applies its fixes
    /// ([`report::apply_fixes`]). Skipped when the user stopped or the time
    /// or tokens are spent; a failed or unreadable review keeps the draft as
    /// written — the review must never cost the run its report.
    async fn review(
        &self,
        io: &Metered<'_>,
        started: Instant,
        brief: &ResearchBrief,
        mut draft: Draft,
        labelled: &[Labelled<'_>],
        today: &str,
    ) -> Draft {
        if let Some(reason) = self.halt_reason(started, io) {
            tracing::info!(
                ?reason,
                "research: no budget left to review the draft; it stands"
            );
            return draft;
        }
        let call = report::review(io, brief, &draft, labelled, today);
        match self.guarded(started, call).await {
            Ok(Ok(Some(fixes))) => {
                let applied = report::apply_fixes(&mut draft, &fixes, labelled);
                tracing::info!(
                    offered = fixes.len(),
                    applied,
                    "research: reviewed the draft"
                );
            }
            Ok(Ok(None)) => {
                tracing::info!("research: the review reply could not be read; the draft stands");
            }
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "research: the review failed; the draft stands");
            }
            Err(reason) => {
                tracing::info!(
                    ?reason,
                    "research: the review was cut off; the draft stands"
                );
            }
        }
        draft
    }

    fn set_phase(
        &self,
        progress: &mut ResearchProgress,
        io: &Metered<'_>,
        phase: &str,
        url: Option<&str>,
    ) {
        progress.phase = phase.to_string();
        progress.current_url = url.map(str::to_string);
        progress.tokens_used = clamp_u32(io.tokens());
        if let Some(listener) = self.on_progress {
            listener(progress);
        }
    }
}

enum Fail {
    Halt(StopReason),
    Error(String),
}

/// What reading one page gave: the page (`None` when stopped before the
/// fetch finished) and its unchecked claims, or why the run must end.
struct PageRead {
    source: Option<SourceRecord>,
    claims: Result<Vec<claims::RawClaim>, Fail>,
}

fn clamp_u32(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A search error that means "slow down".
pub fn is_rate_limit(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("429") || lower.contains("rate")
}

/// The search results worth reading, best first: public web addresses not
/// read yet, avoided domains dropped, hosts under their cap; preferred
/// domains, then hosts not read yet, first; one page per host before a second.
pub fn choose(
    hits: &[SearchHit],
    brief: &ResearchBrief,
    seen: &HashSet<String>,
    per_host: &HashMap<String, u32>,
) -> Vec<String> {
    let mut fresh: Vec<(String, String)> = Vec::new();
    let mut batch: HashSet<String> = HashSet::new();
    for hit in hits {
        let url = hit.url.trim();
        if !urls::is_public_web_url(url) {
            continue;
        }
        let (Some(canonical), Some(host)) = (urls::canonical(url), urls::host(url)) else {
            continue;
        };
        if seen.contains(&canonical) || !batch.insert(canonical) {
            continue;
        }
        if brief
            .avoid_domains
            .iter()
            .any(|d| urls::host_matches(&host, d))
        {
            continue;
        }
        fresh.push((url.to_string(), host));
    }
    let preferred = |host: &str| {
        brief
            .prefer_domains
            .iter()
            .any(|d| urls::host_matches(host, d))
    };
    let read_before = |host: &str| per_host.get(host).copied().unwrap_or(0) > 0;
    // Stable: search order breaks ties.
    fresh.sort_by_key(|(_, host)| (!preferred(host), read_before(host)));

    let mut picked: Vec<String> = Vec::new();
    let mut taken: HashMap<String, u32> = HashMap::new();
    for pass in 0..2 {
        for (url, host) in &fresh {
            if picked.len() == PAGES_PER_SEARCH {
                return picked;
            }
            if picked.contains(url) {
                continue;
            }
            let in_batch = taken.get(host).copied().unwrap_or(0);
            let total = per_host.get(host).copied().unwrap_or(0) + in_batch;
            if total >= MAX_PAGES_PER_HOST || (pass == 0 && in_batch > 0) {
                continue;
            }
            *taken.entry(host.clone()).or_default() += 1;
            picked.push(url.clone());
        }
    }
    picked
}

const GAP_SYSTEM: &str = "You check the progress of web research. You only judge what has been \
found and suggest web searches. Reply with JSON only.";

fn gap_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "answered": { "type": "array", "items": { "type": "integer", "minimum": 1 } },
            "followUps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "subQuestion": { "type": "integer", "minimum": 1 },
                        "queries": { "type": "array", "maxItems": MAX_FOLLOW_UPS, "items": { "type": "string" } }
                    },
                    "required": ["subQuestion", "queries"]
                }
            }
        },
        "required": ["answered", "followUps"]
    })
}

/// Ask which sub-questions are answered and what to search for the rest.
/// Shown the verified claims and their hosts only. `Ok(None)` when nothing
/// more is worth searching (or the reply can't be read).
async fn gap_check(
    io: &Metered<'_>,
    work: &Work<'_>,
) -> Result<Option<Vec<(usize, String)>>, String> {
    let brief = work.brief;
    let hosts: HashMap<&str, &str> = work
        .sources
        .iter()
        .map(|s| (s.id.as_str(), s.host.as_str()))
        .collect();
    let mut found = String::new();
    for (i, q) in brief.sub_questions.iter().enumerate() {
        found.push_str(&format!("{}. {q}\n", i + 1));
        let mine: Vec<&ClaimRecord> = work
            .claims
            .iter()
            .filter(|c| c.verified && c.sub_question == i)
            .take(GAP_CLAIMS_PER_QUESTION)
            .collect();
        if mine.is_empty() {
            found.push_str("   (nothing found yet)\n");
        }
        for c in mine {
            let host = hosts.get(c.source_id.as_str()).copied().unwrap_or_default();
            found.push_str(&format!("   - {} ({host})\n", c.claim));
        }
    }
    let searched = work.searched.iter().cloned().collect::<Vec<_>>().join("; ");
    let prompt = format!(
        "Today is {today}.\nQuestion: {question}\n\nWhat has been found so far, by sub-question:\n\
{found}\n\
For each sub-question, decide whether the facts found answer it as of today. List the numbers \
of the answered ones in \"answered\". For each one not answered, suggest up to {MAX_FOLLOW_UPS} \
new web search queries likely to find the answer, different from these searches already made: \
{searched}",
        today = work.today,
        question = brief.question
    );
    let Some(data) = ask_json(io, GAP_SYSTEM, &prompt, &gap_schema()).await? else {
        return Ok(None);
    };
    let answered: HashSet<usize> = data["answered"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .map(|n| n as usize)
        .collect();
    let mut follow_ups = Vec::new();
    for item in data["followUps"].as_array().into_iter().flatten() {
        let Some(number) = item["subQuestion"]
            .as_u64()
            .map(|n| n as usize)
            .filter(|n| *n >= 1 && *n <= brief.sub_questions.len())
        else {
            continue;
        };
        if answered.contains(&number) {
            continue;
        }
        for query in item["queries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|q| clip(&one_line(q), 200))
            .filter(|q| !q.is_empty() && !q.contains("://"))
            .take(MAX_FOLLOW_UPS)
        {
            follow_ups.push((number - 1, query));
        }
    }
    Ok((!follow_ups.is_empty()).then_some(follow_ups))
}

/// The line at the top of a report that ended early.
fn note_for(
    stop: Option<StopReason>,
    error: Option<&str>,
    budget: &ResearchBudget,
) -> Option<String> {
    let covers = "this report covers what was verified by then.";
    if let Some(error) = error {
        return Some(format!(
            "The research ended with an error ({}); {covers}",
            one_line(error)
        ));
    }
    Some(match stop? {
        StopReason::User => format!("The research was stopped before it finished; {covers}"),
        StopReason::Searches => format!(
            "The research used its {} searches before every question was answered; {covers}",
            budget.searches
        ),
        StopReason::Pages => format!(
            "The research read its {} pages before every question was answered; {covers}",
            budget.pages
        ),
        StopReason::Tokens => format!(
            "The research used its budget of {} model tokens; {covers}",
            budget.tokens
        ),
        StopReason::Time => format!(
            "The research reached its time limit of {} minutes; {covers}",
            budget.minutes
        ),
    })
}

fn render_report(
    brief: &ResearchBrief,
    date: &str,
    draft: &Draft,
    labelled: &[Labelled<'_>],
    sources: &[SourceRecord],
    unanswered: &[usize],
    note: Option<&str>,
) -> Rendered {
    report::render(&ReportInput {
        brief,
        date,
        draft,
        claims: labelled,
        sources,
        unanswered,
        note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use provider_core::schema::ResearchDepth;

    fn hit(url: &str) -> SearchHit {
        SearchHit {
            title: String::new(),
            url: url.into(),
            snippet: String::new(),
        }
    }

    fn brief() -> ResearchBrief {
        ResearchBrief {
            question: "Q".into(),
            sub_questions: vec!["A".into()],
            scope: None,
            prefer_domains: vec!["pref.org".into()],
            avoid_domains: vec!["bad.com".into()],
            depth: ResearchDepth::Quick,
        }
    }

    #[test]
    fn choose_dedupes_filters_and_spreads_hosts() {
        let hits = [
            hit("https://a.com/1"),
            hit("https://a.com/1/#top"),
            hit("https://a.com/2?utm_source=x"),
            hit("https://news.bad.com/x"),
            hit("http://192.168.1.1/admin"),
            hit("https://b.net/1"),
            hit("https://www.pref.org/1"),
        ];
        let picked = choose(&hits, &brief(), &HashSet::new(), &HashMap::new());
        assert_eq!(
            picked,
            vec![
                "https://www.pref.org/1",
                "https://a.com/1",
                "https://b.net/1"
            ]
        );
        // A host at its cap gives no more pages; a page already read isn't read again.
        let seen = HashSet::from([urls::canonical("https://b.net/1").unwrap()]);
        let per_host = HashMap::from([("a.com".to_string(), MAX_PAGES_PER_HOST)]);
        assert_eq!(
            choose(&hits, &brief(), &seen, &per_host),
            vec!["https://www.pref.org/1"]
        );
    }

    #[test]
    fn rate_limit_errors_are_recognised() {
        assert!(is_rate_limit("Exa answered 429 Too Many Requests"));
        assert!(is_rate_limit("Rate limit exceeded"));
        assert!(!is_rate_limit("Not found"));
    }
}
