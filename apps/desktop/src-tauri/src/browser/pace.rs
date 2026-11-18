//! How fast the agent's browser goes: Fast (machine speed) or Human (the
//! default): pauses a careful person would take, spacing between page loads,
//! a cap on pages a minute, and typing a few characters at a time.
//!
//! Pacing is only about *when* things happen. It never hides that the browser
//! is automated: no user-agent or fingerprint changes, no pointer paths, no
//! CAPTCHA handling. Every wait is a plain sleep inside the tool call, so Stop
//! ends it, and the time is reported so it doesn't count against the turn's
//! time limit.
//!
//! Whatever the pace, a site that says it is getting requests too fast (a 429,
//! or a short "too many requests" page) is backed off from and, in Fast mode,
//! paced like Human for the rest of the run.
//!
//! The schedule is pure: it takes the time since the run's first page and a
//! source of random numbers, so the tests need no clock.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How fast the agent's browser goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pace {
    /// Machine speed: no added waits (back-off from a site that objects still applies).
    Fast,
    /// Pauses, spacing and typing like a careful person.
    #[default]
    Human,
}

impl Pace {
    /// The setting's value (`"fast"` or `"human"`); anything else is Human.
    pub fn from_setting(value: Option<&str>) -> Pace {
        match value.map(str::trim) {
            Some("fast") => Pace::Fast,
            _ => Pace::Human,
        }
    }
}

/// A uniform random number in `[0, 1)`.
pub type Rng<'a> = dyn FnMut() -> f64 + 'a;

/// Least time between page loads on one site (start to start), plus up to
/// [`SAME_HOST_JITTER`].
pub const SAME_HOST_GAP: Duration = Duration::from_secs(4);
pub const SAME_HOST_JITTER: Duration = Duration::from_millis(1500);
/// Least time between any two page loads.
pub const ANY_HOST_GAP: Duration = Duration::from_millis(1500);
/// Pages a minute (sliding window), in all and on one site.
pub const PER_MINUTE: usize = 10;
pub const PER_HOST_PER_MINUTE: usize = 6;
const WINDOW: Duration = Duration::from_secs(60);
/// Back-off from a site that objects: 15 s, 30 s, 60 s; the next objection ends it.
pub const BACKOFF_FIRST: Duration = Duration::from_secs(15);
pub const BACKOFF_CAP: Duration = Duration::from_secs(120);
pub const MAX_BACKOFFS: u32 = 3;
/// Typing slower than this in all is finished in one go.
pub const TYPING_CAP: Duration = Duration::from_secs(10);

fn between(lo_ms: u64, hi_ms: u64, rng: &mut Rng<'_>) -> Duration {
    let r = rng().clamp(0.0, 1.0);
    Duration::from_millis(lo_ms + ((hi_ms - lo_ms) as f64 * r).round() as u64)
}

/// The pause before acting on an element ("finding the button").
pub fn before_action(pace: Pace, rng: &mut Rng<'_>) -> Duration {
    match pace {
        Pace::Fast => Duration::ZERO,
        Pace::Human => between(500, 1200, rng),
    }
}

/// The beat between moving to an element and pressing it.
pub fn hover(pace: Pace, rng: &mut Rng<'_>) -> Duration {
    match pace {
        Pace::Fast => Duration::ZERO,
        Pace::Human => between(120, 350, rng),
    }
}

/// The pause after an action, before the page is read back.
pub fn after_action(pace: Pace, rng: &mut Rng<'_>) -> Duration {
    match pace {
        Pace::Fast => Duration::ZERO,
        Pace::Human => between(600, 1400, rng),
    }
}

/// Time spent on a newly opened page before its text is returned: about the
/// time to skim it (1800 characters a second), 0.8 s to 6 s, ±25%.
pub fn dwell(pace: Pace, text_chars: usize, rng: &mut Rng<'_>) -> Duration {
    if pace == Pace::Fast {
        return Duration::ZERO;
    }
    let base = (0.6 + text_chars as f64 / 1800.0).clamp(0.8, 6.0);
    let spread = 0.75 + 0.5 * rng().clamp(0.0, 1.0);
    Duration::from_secs_f64(base * spread)
}

/// Typing as pieces, each with the pause before it: one to three characters
/// at a time, 45-140 ms a character, a longer beat after a space or
/// punctuation. Once [`TYPING_CAP`] is used, the rest goes in one piece.
/// Fast mode types it all at once.
pub fn typing(pace: Pace, text: &str, rng: &mut Rng<'_>) -> Vec<(String, Duration)> {
    if pace == Pace::Fast || text.is_empty() {
        return vec![(text.to_string(), Duration::ZERO)];
    }
    let chars: Vec<char> = text.chars().collect();
    let mut pieces = Vec::new();
    let mut spent = Duration::ZERO;
    let mut i = 0;
    while i < chars.len() {
        if spent >= TYPING_CAP {
            pieces.push((chars[i..].iter().collect(), Duration::ZERO));
            break;
        }
        let take = (1 + (rng().clamp(0.0, 0.999) * 3.0) as usize).min(chars.len() - i);
        let piece: String = chars[i..i + take].iter().collect();
        let mut wait = Duration::ZERO;
        for _ in 0..take {
            wait += between(45, 140, rng);
        }
        if i > 0 && (chars[i - 1].is_whitespace() || chars[i - 1].is_ascii_punctuation()) {
            wait += between(150, 400, rng);
        }
        spent += wait;
        pieces.push((piece, wait));
        i += take;
    }
    pieces
}

/// Scrolling as steps (share of the window height each, pause before each)
/// that add up to 0.9 of the window. Fast mode is one jump.
pub fn scroll_steps(pace: Pace, rng: &mut Rng<'_>) -> Vec<(f64, Duration)> {
    match pace {
        Pace::Fast => vec![(0.9, Duration::ZERO)],
        Pace::Human => (0..5)
            .map(|i| {
                let wait = if i == 0 {
                    Duration::ZERO
                } else {
                    between(70, 160, rng)
                };
                (0.18, wait)
            })
            .collect(),
    }
}

/// Words a short page uses to say requests are coming too fast.
const TOO_FAST: [&str; 6] = [
    "not able to serve your requests this quickly",
    "too many requests",
    "rate limit",
    "rate-limit",
    "slow down",
    "requesting too fast",
];

/// Pages longer than this aren't judged by their words (an article about rate
/// limits isn't one).
pub const TOO_FAST_TEXT_LIMIT: i64 = 600;

/// Whether a page is a site saying it's getting requests too fast: a 429, or
/// a short page in those words.
pub fn is_too_fast(status: i64, text_chars: i64, head: &str) -> bool {
    if status == 429 {
        return true;
    }
    if text_chars >= TOO_FAST_TEXT_LIMIT {
        return false;
    }
    let head = head.to_lowercase();
    TOO_FAST.iter().any(|w| head.contains(w))
}

/// What to do after a site objected.
#[derive(Debug, PartialEq, Eq)]
pub enum Backoff {
    /// Wait this long, then try again.
    Wait(Duration),
    /// It objected too often in a row: stop opening it in this run.
    Stop,
}

/// A run's pacing record: page loads in the last minute, sites backed off
/// from, and the time spent waiting on purpose.
#[derive(Debug, Default)]
pub struct PaceState {
    started: Option<Instant>,
    loads: VecDeque<(Duration, String)>,
    strikes: HashMap<String, u32>,
    until: HashMap<String, Duration>,
    /// Sites that objected this run: paced like Human even in Fast mode.
    slowed: HashSet<String>,
    /// Time spent waiting on purpose, not yet reported.
    waited: Duration,
}

impl PaceState {
    /// Time since the run's first paced moment.
    fn now(&mut self) -> Duration {
        self.started.get_or_insert_with(Instant::now).elapsed()
    }

    /// How long to wait before loading a page on `host` at `now`.
    pub fn load_wait(&self, pace: Pace, host: &str, now: Duration, rng: &mut Rng<'_>) -> Duration {
        let mut ready = now;
        if let Some(&until) = self.until.get(host) {
            ready = ready.max(until);
        }
        let human = pace == Pace::Human;
        if human || self.slowed.contains(host) {
            if let Some((last, _)) = self.loads.iter().rev().find(|(_, h)| h == host) {
                let jitter = SAME_HOST_JITTER.mul_f64(rng().clamp(0.0, 1.0));
                ready = ready.max(*last + SAME_HOST_GAP + jitter);
            }
            let on_host: Vec<Duration> = self
                .loads
                .iter()
                .filter(|(_, h)| h == host)
                .map(|(t, _)| *t)
                .collect();
            if on_host.len() >= PER_HOST_PER_MINUTE {
                ready = ready.max(on_host[on_host.len() - PER_HOST_PER_MINUTE] + WINDOW);
            }
        }
        if human {
            if let Some((last, _)) = self.loads.back() {
                ready = ready.max(*last + ANY_HOST_GAP);
            }
            if self.loads.len() >= PER_MINUTE {
                ready = ready.max(self.loads[self.loads.len() - PER_MINUTE].0 + WINDOW);
            }
        }
        ready.saturating_sub(now)
    }

    /// A page load on `host` starts at `now`.
    pub fn record_load(&mut self, host: &str, now: Duration) {
        self.loads.push_back((now, host.to_string()));
        while self
            .loads
            .front()
            .is_some_and(|(t, _)| now.saturating_sub(*t) > WINDOW)
        {
            self.loads.pop_front();
        }
    }

    /// `host` objected at `now`: how long to back off, or stop.
    pub fn too_fast(&mut self, host: &str, now: Duration) -> Backoff {
        self.slowed.insert(host.to_string());
        let strikes = self.strikes.entry(host.to_string()).or_insert(0);
        *strikes += 1;
        if *strikes > MAX_BACKOFFS {
            return Backoff::Stop;
        }
        let wait = BACKOFF_FIRST
            .saturating_mul(1 << (*strikes - 1))
            .min(BACKOFF_CAP);
        self.until.insert(host.to_string(), now + wait);
        Backoff::Wait(wait)
    }

    /// `host` served a page: its run of objections is over (it stays slowed).
    pub fn served(&mut self, host: &str) {
        self.strikes.remove(host);
    }
}

/// A wait before a page load long enough to show the person, so the call
/// doesn't look stuck.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pause {
    pub host: String,
    /// Whole seconds, rounded up.
    pub seconds: u64,
    /// The site said it was getting requests too fast.
    pub slow_down: bool,
}

/// Told `Some` when a shown wait starts and `None` when it ends.
pub type OnPause<'a> = dyn Fn(Option<Pause>) + Send + Sync + 'a;

/// The waits workflow runs are in now, by (run id, step id), for the run
/// page, which reads a run again every few seconds rather than following its
/// events. In memory: a wait lasts seconds and ends with the call.
#[derive(Default)]
pub struct ShownPauses(Mutex<HashMap<(String, String), Pause>>);

impl ShownPauses {
    /// Note that a step's browser call started (`Some`) or ended a wait.
    pub fn set(&self, run_id: &str, step_id: &str, pause: Option<Pause>) {
        if let Ok(mut pauses) = self.0.lock() {
            let key = (run_id.to_string(), step_id.to_string());
            match pause {
                Some(p) => {
                    pauses.insert(key, p);
                }
                None => {
                    pauses.remove(&key);
                }
            }
        }
    }

    /// The wait a run's step is in, if any.
    pub fn get(&self, run_id: &str, step_id: &str) -> Option<Pause> {
        let pauses = self.0.lock().ok()?;
        pauses
            .get(&(run_id.to_string(), step_id.to_string()))
            .cloned()
    }
}

/// Load waits shorter than this aren't shown.
pub const SHOWN_PAUSE: Duration = Duration::from_secs(2);

/// What to show for a wait of `wait` before loading a page on `host`;
/// nothing when it is short.
pub fn shown_pause(wait: Duration, host: &str, slow_down: bool) -> Option<Pause> {
    (wait >= SHOWN_PAUSE).then(|| Pause {
        host: host.to_string(),
        seconds: wait.as_millis().div_ceil(1000) as u64,
        slow_down,
    })
}

/// A run's pace and its record, for one tool call.
#[derive(Clone, Copy)]
pub struct Pacer<'a> {
    pub pace: Pace,
    pub state: &'a Mutex<PaceState>,
    pub on_pause: Option<&'a OnPause<'a>>,
}

fn random() -> f64 {
    rand::random::<f64>()
}

impl Pacer<'_> {
    /// Sleep `wait`, counted as time spent waiting on purpose.
    pub async fn wait(&self, wait: Duration) {
        if wait.is_zero() {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            state.waited += wait;
        }
        tokio::time::sleep(wait).await;
    }

    pub async fn before_action(&self) {
        self.wait(before_action(self.pace, &mut random)).await;
    }

    pub async fn hover(&self) {
        self.wait(hover(self.pace, &mut random)).await;
    }

    pub async fn after_action(&self) {
        self.wait(after_action(self.pace, &mut random)).await;
    }

    pub fn typing(&self, text: &str) -> Vec<(String, Duration)> {
        typing(self.pace, text, &mut random)
    }

    pub fn scroll_steps(&self) -> Vec<(f64, Duration)> {
        scroll_steps(self.pace, &mut random)
    }

    pub async fn dwell(&self, text_chars: usize) {
        self.wait(dwell(self.pace, text_chars, &mut random)).await;
    }

    /// Wait until a page on `host` may load, then record that it does. A
    /// long wait is shown while it lasts.
    pub async fn before_load(&self, host: &str) {
        let (wait, slow_down) = match self.state.lock() {
            Ok(mut state) => {
                let now = state.now();
                let objecting = state.strikes.contains_key(host);
                (
                    state.load_wait(self.pace, host, now, &mut random),
                    objecting,
                )
            }
            Err(_) => (Duration::ZERO, false),
        };
        let shown = self
            .on_pause
            .and_then(|on_pause| shown_pause(wait, host, slow_down).map(|p| (on_pause, p)));
        if let Some((on_pause, pause)) = &shown {
            on_pause(Some(pause.clone()));
        }
        self.wait(wait).await;
        if let Some((on_pause, _)) = shown {
            on_pause(None);
        }
        if let Ok(mut state) = self.state.lock() {
            let now = state.now();
            state.record_load(host, now);
        }
    }

    /// `host` said it's getting requests too fast.
    pub fn too_fast(&self, host: &str) -> Backoff {
        match self.state.lock() {
            Ok(mut state) => {
                let now = state.now();
                state.too_fast(host, now)
            }
            Err(_) => Backoff::Stop,
        }
    }

    pub fn served(&self, host: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.served(host);
        }
    }
}

impl PaceState {
    /// The time spent waiting on purpose since this was last asked.
    pub fn take_waited(&mut self) -> Duration {
        std::mem::take(&mut self.waited)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed(r: f64) -> impl FnMut() -> f64 {
        move || r
    }

    #[test]
    fn only_long_load_waits_are_shown_in_whole_seconds() {
        assert_eq!(
            shown_pause(Duration::from_millis(1999), "a.com", false),
            None
        );
        assert_eq!(
            shown_pause(Duration::from_millis(4200), "a.com", false),
            Some(Pause {
                host: "a.com".into(),
                seconds: 5,
                slow_down: false
            })
        );
        assert_eq!(
            shown_pause(BACKOFF_FIRST, "a.com", true),
            Some(Pause {
                host: "a.com".into(),
                seconds: 15,
                slow_down: true
            })
        );
    }

    #[test]
    fn a_workflow_steps_wait_is_kept_until_it_ends() {
        let pauses = ShownPauses::default();
        let wait = Pause {
            host: "a.com".into(),
            seconds: 7,
            slow_down: false,
        };
        pauses.set("run", "fetch", Some(wait.clone()));
        assert_eq!(pauses.get("run", "fetch"), Some(wait));
        assert_eq!(pauses.get("run", "other"), None);
        assert_eq!(pauses.get("other", "fetch"), None);
        pauses.set("run", "fetch", None);
        assert_eq!(pauses.get("run", "fetch"), None);
    }

    #[test]
    fn a_wait_reaches_the_run_page_in_camel_case() {
        let wait = Pause {
            host: "a.com".into(),
            seconds: 7,
            slow_down: true,
        };
        assert_eq!(
            serde_json::to_value(&wait).unwrap(),
            serde_json::json!({ "host": "a.com", "seconds": 7, "slowDown": true })
        );
    }

    #[test]
    fn the_pace_is_stored_as_a_lowercase_word() {
        assert_eq!(serde_json::to_value(Pace::Fast).unwrap(), "fast");
        assert_eq!(
            serde_json::from_value::<Pace>("human".into()).unwrap(),
            Pace::Human
        );
    }

    #[test]
    fn reads_the_setting_with_human_as_default() {
        assert_eq!(Pace::from_setting(Some("fast")), Pace::Fast);
        assert_eq!(Pace::from_setting(Some("human")), Pace::Human);
        assert_eq!(Pace::from_setting(None), Pace::Human);
        assert_eq!(Pace::from_setting(Some("warp")), Pace::Human);
    }

    #[test]
    fn fast_adds_no_waits() {
        let mut r = fixed(0.9);
        assert_eq!(before_action(Pace::Fast, &mut r), Duration::ZERO);
        assert_eq!(hover(Pace::Fast, &mut r), Duration::ZERO);
        assert_eq!(after_action(Pace::Fast, &mut r), Duration::ZERO);
        assert_eq!(dwell(Pace::Fast, 50_000, &mut r), Duration::ZERO);
        assert_eq!(
            typing(Pace::Fast, "hello world", &mut r),
            vec![("hello world".to_string(), Duration::ZERO)]
        );
        assert_eq!(
            scroll_steps(Pace::Fast, &mut r),
            vec![(0.9, Duration::ZERO)]
        );
        let mut state = PaceState::default();
        for i in 0..30 {
            assert_eq!(
                state.load_wait(Pace::Fast, "a.com", Duration::from_millis(i * 10), &mut r),
                Duration::ZERO
            );
            state.record_load("a.com", Duration::from_millis(i * 10));
        }
    }

    #[test]
    fn human_waits_stay_in_their_ranges() {
        assert_eq!(
            before_action(Pace::Human, &mut fixed(0.0)),
            Duration::from_millis(500)
        );
        assert_eq!(
            before_action(Pace::Human, &mut fixed(1.0)),
            Duration::from_millis(1200)
        );
        assert_eq!(
            hover(Pace::Human, &mut fixed(0.0)),
            Duration::from_millis(120)
        );
        assert_eq!(
            after_action(Pace::Human, &mut fixed(1.0)),
            Duration::from_millis(1400)
        );
    }

    #[test]
    fn dwell_grows_with_the_page_within_its_caps() {
        let mid = |chars| dwell(Pace::Human, chars, &mut fixed(0.5));
        assert_eq!(mid(0), Duration::from_millis(800));
        assert_eq!(mid(1800), Duration::from_millis(1600));
        assert_eq!(mid(1_000_000), Duration::from_secs(6));
        assert_eq!(
            dwell(Pace::Human, 1_000_000, &mut fixed(1.0)),
            Duration::from_millis(7500)
        );
        assert_eq!(
            dwell(Pace::Human, 0, &mut fixed(0.0)),
            Duration::from_millis(600)
        );
    }

    #[test]
    fn typing_comes_in_small_pieces_and_keeps_every_character() {
        let text = "Tauri, über alles";
        let pieces = typing(Pace::Human, text, &mut fixed(0.5));
        assert_eq!(
            pieces.iter().map(|(p, _)| p.as_str()).collect::<String>(),
            text
        );
        assert!(pieces
            .iter()
            .all(|(p, _)| (1..=3).contains(&p.chars().count())));
        // 0.5 → two characters a piece at 93 ms each.
        assert_eq!(pieces[0], ("Ta".to_string(), Duration::from_millis(186)));
        // After the comma the beat is longer: 186 ms + 275 ms.
        assert_eq!(pieces[3], (" ü".to_string(), Duration::from_millis(461)));
    }

    #[test]
    fn long_typing_finishes_in_one_piece_after_the_cap() {
        let text = "x".repeat(2000);
        let pieces = typing(Pace::Human, &text, &mut fixed(0.5));
        assert_eq!(
            pieces.iter().map(|(p, _)| p.chars().count()).sum::<usize>(),
            2000
        );
        let total: Duration = pieces.iter().map(|(_, w)| *w).sum();
        assert!(
            total <= TYPING_CAP + Duration::from_millis(500),
            "{total:?}"
        );
        assert_eq!(pieces.last().unwrap().1, Duration::ZERO);
        assert!(pieces.last().unwrap().0.len() > 1000);
    }

    #[test]
    fn human_scroll_is_five_steps_adding_up_to_the_same_distance() {
        let steps = scroll_steps(Pace::Human, &mut fixed(0.0));
        assert_eq!(steps.len(), 5);
        assert!((steps.iter().map(|(s, _)| s).sum::<f64>() - 0.9).abs() < 1e-9);
        assert_eq!(steps[0].1, Duration::ZERO);
        assert_eq!(steps[1].1, Duration::from_millis(70));
    }

    #[test]
    fn spaces_page_loads_on_one_site_and_across_sites() {
        let mut state = PaceState::default();
        let mut r = fixed(0.0);
        let s = Duration::from_secs;
        assert_eq!(
            state.load_wait(Pace::Human, "a.com", s(0), &mut r),
            Duration::ZERO
        );
        state.record_load("a.com", s(0));
        // Same site: 4 s start to start (no jitter at 0.0; up to 1.5 s more at 1.0).
        assert_eq!(state.load_wait(Pace::Human, "a.com", s(1), &mut r), s(3));
        assert_eq!(
            state.load_wait(Pace::Human, "a.com", s(1), &mut fixed(1.0)),
            Duration::from_millis(4500)
        );
        // Another site: 1.5 s after any load.
        assert_eq!(
            state.load_wait(Pace::Human, "b.com", s(1), &mut r),
            Duration::from_millis(500)
        );
        assert_eq!(
            state.load_wait(Pace::Human, "b.com", s(2), &mut r),
            Duration::ZERO
        );
    }

    #[test]
    fn caps_pages_a_minute() {
        let s = Duration::from_secs;
        let mut r = fixed(0.0);
        // Six loads on one site, 5 s apart: the seventh waits for the minute.
        let mut state = PaceState::default();
        for i in 0..6 {
            state.record_load("a.com", s(i * 5));
        }
        assert_eq!(state.load_wait(Pace::Human, "a.com", s(30), &mut r), s(30));
        // Ten loads across sites, 2 s apart: the eleventh waits too.
        let mut state = PaceState::default();
        for i in 0..10 {
            state.record_load(&format!("s{i}.com"), s(i * 2));
        }
        assert_eq!(
            state.load_wait(Pace::Human, "new.com", s(20), &mut r),
            s(40)
        );
        // Loads older than a minute are forgotten.
        state.record_load("late.com", s(200));
        assert_eq!(state.loads.len(), 1);
    }

    #[test]
    fn backs_off_from_a_site_that_objects_then_stops() {
        let s = Duration::from_secs;
        let mut state = PaceState::default();
        let mut r = fixed(0.0);
        assert_eq!(state.too_fast("hn.com", s(0)), Backoff::Wait(s(15)));
        assert_eq!(state.load_wait(Pace::Fast, "hn.com", s(5), &mut r), s(10));
        assert_eq!(state.too_fast("hn.com", s(20)), Backoff::Wait(s(30)));
        assert_eq!(state.too_fast("hn.com", s(60)), Backoff::Wait(s(60)));
        assert_eq!(state.too_fast("hn.com", s(130)), Backoff::Stop);
        // A page served ends the run of objections.
        state.served("hn.com");
        assert_eq!(state.too_fast("hn.com", s(200)), Backoff::Wait(s(15)));
        // Other sites are untouched.
        assert_eq!(
            state.load_wait(Pace::Fast, "other.com", s(201), &mut r),
            Duration::ZERO
        );
    }

    #[test]
    fn a_site_that_objected_is_paced_in_fast_mode_too() {
        let s = Duration::from_secs;
        let mut state = PaceState::default();
        let mut r = fixed(0.0);
        state.record_load("hn.com", s(0));
        assert_eq!(
            state.load_wait(Pace::Fast, "hn.com", s(1), &mut r),
            Duration::ZERO
        );
        state.too_fast("hn.com", s(1));
        state.served("hn.com");
        state.record_load("hn.com", s(16));
        assert_eq!(state.load_wait(Pace::Fast, "hn.com", s(17), &mut r), s(3));
    }

    #[test]
    fn knows_a_too_fast_page() {
        assert!(is_too_fast(429, 5000, "anything"));
        assert!(is_too_fast(
            200,
            70,
            "Sorry, we're not able to serve your requests this quickly."
        ));
        assert!(is_too_fast(503, 40, "Too Many Requests"));
        assert!(!is_too_fast(200, 40, "Welcome"));
        // A long article about rate limits isn't one.
        assert!(!is_too_fast(
            200,
            9000,
            "How rate limits work, and how to slow down"
        ));
    }

    #[test]
    fn reports_the_time_waited_once() {
        let mut state = PaceState {
            waited: Duration::from_secs(3),
            ..Default::default()
        };
        assert_eq!(state.take_waited(), Duration::from_secs(3));
        assert_eq!(state.take_waited(), Duration::ZERO);
    }
}
