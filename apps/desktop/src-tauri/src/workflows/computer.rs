//! Agents that use the user's computer (Phase 15a): commands and file changes
//! in the workflow's folder, behind the same approvals as outside actions.
//!
//! A command is a program and a list of arguments, never a shell string, so a
//! rule matches exactly what runs: `git log *` covers `git log --oneline`, and
//! nothing can be chained after it. What decides whether a command runs
//! without asking ([`judge`]):
//! - a deny rule (the workflow's, the user's global ones, or a built-in one)
//!   always asks, and can't be remembered;
//! - programs that run other code (shells, interpreters, package runners)
//!   always ask, unless a rule names a script for them;
//! - anything odd (a newline in an argument, a network path, a very long
//!   command) asks;
//! - after the agent read outside content (web pages, connector results), every
//!   command asks, rules or not (the "taint" rule);
//! - otherwise an allow rule runs it, and no rule asks.
//!
//! The rules themselves live with the workflow's outside-action rules
//! (`ActionRules::commands`) and only the app's UI changes them.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The agent tool entry that gives an agent the computer tools.
pub const COMPUTER_TOOL: &str = "computer";

/// The tools an agent with [`COMPUTER_TOOL`] sees.
pub const RUN_TOOL: &str = "run_command";
pub const LIST_TOOL: &str = "list_files";
pub const READ_TOOL: &str = "read_file";
pub const SEARCH_TOOL: &str = "search_files";
pub const WRITE_TOOL: &str = "write_file";
pub const EDIT_TOOL: &str = "edit_file";

/// Longest command (program and arguments together) a rule may cover.
const MAX_COMMAND_CHARS: usize = 10_000;
/// Default and longest time a command may run.
pub const DEFAULT_TIMEOUT_SECS: u64 = 120;
pub const MAX_TIMEOUT_SECS: u64 = 1_800;
/// Output kept for the model: the start and the end of it.
const OUTPUT_HEAD_CHARS: usize = 15_000;
const OUTPUT_TAIL_CHARS: usize = 15_000;
/// Output read from a command before the rest is dropped.
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

/// How a workflow lets its agents use the computer (the definition's
/// `computer` setting).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerConfig {
    /// Whether file changes ask first (the default) or go ahead in the folder.
    #[serde(default)]
    pub edit_mode: EditMode,
    /// What a command that would ask does when the run is unattended.
    #[serde(default)]
    pub when_nobody_answers: WhenNobodyAnswers,
    /// Seconds a command may run; [`DEFAULT_TIMEOUT_SECS`] when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    /// Environment variables passed even though they look secret.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pass_env: Vec<String>,
    /// Let commands write outside the folder and use the network: for
    /// programs that break when kept in (on Windows they are kept in by
    /// default; see `workflows::confine`).
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_outside: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditMode {
    /// Every write or edit pauses with the change.
    #[default]
    Ask,
    /// Writes and edits inside the folder go ahead.
    Free,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WhenNobodyAnswers {
    /// Pause and ask, as an outside action does.
    #[default]
    Wait,
    /// Refuse at once and tell the agent.
    Skip,
}

impl ComputerConfig {
    pub fn timeout(&self) -> Duration {
        Duration::from_secs(
            self.timeout_secs
                .unwrap_or(DEFAULT_TIMEOUT_SECS)
                .clamp(1, MAX_TIMEOUT_SECS),
        )
    }
}

/// A workflow's command rules (kept with its outside-action rules).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRules {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    /// How often each allow rule let a command run, for the rules list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub uses: Vec<RuleUse>,
}

/// One allow rule's use: how many commands it let run, and when last.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleUse {
    pub rule: String,
    pub count: u32,
    pub last_used_at: String,
}

impl CommandRules {
    /// Count a command `rule` let run, at `now`.
    pub fn note_use(&mut self, rule: &str, now: &str) {
        match self.uses.iter_mut().find(|u| u.rule == rule) {
            Some(used) => {
                used.count = used.count.saturating_add(1);
                used.last_used_at = now.to_string();
            }
            None => self.uses.push(RuleUse {
                rule: rule.to_string(),
                count: 1,
                last_used_at: now.to_string(),
            }),
        }
    }

    /// Keep what `stored` counted for the allow rules still here (the UI
    /// sends the rules without their counts).
    pub fn keep_uses(&mut self, stored: &CommandRules) {
        self.uses = stored
            .uses
            .iter()
            .filter(|u| self.allow.contains(&u.rule))
            .cloned()
            .collect();
    }

    /// Allow `rule` from now on; `false` when it already was.
    pub fn allow(&mut self, rule: &str) -> bool {
        let rule = rule.trim().to_string();
        if self.allow.contains(&rule) {
            return false;
        }
        self.allow.push(rule);
        true
    }
}

/// A rule: a program and its leading arguments; `rest` when it ended in `*`
/// (any further arguments). Programs compare by name without extension and
/// case (`git`, `git.exe`, `GIT` are one program).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub program: String,
    pub args: Vec<String>,
    pub rest: bool,
}

/// Parse `git log *`; plain words separated by spaces, `*` only at the end.
pub fn parse_rule(text: &str) -> Result<Rule, String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let Some((first, more)) = words.split_first() else {
        return Err("A rule needs a program, such as \u{201c}git status\u{201d}.".to_string());
    };
    if *first == "*" {
        return Err("A rule can't allow every program.".to_string());
    }
    let (args, rest) = match more.split_last() {
        Some((&"*", before)) => (before, true),
        _ => (more, false),
    };
    if args.iter().any(|a| a.contains('*')) || first.contains('*') {
        return Err("A rule can only end in *, which covers any further arguments.".to_string());
    }
    Ok(Rule {
        program: program_name(first),
        args: args.iter().map(|a| a.to_string()).collect(),
        rest,
    })
}

/// A program's name for matching: the file name without its extension,
/// lowercased (`C:\Git\cmd\git.exe` → `git`).
pub fn program_name(program: &str) -> String {
    let file = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    match file.rsplit_once('.') {
        Some((stem, "exe" | "cmd" | "bat" | "com" | "ps1")) => stem.to_string(),
        _ => file,
    }
}

impl Rule {
    pub fn matches(&self, program: &str, args: &[String]) -> bool {
        if program_name(program) != self.program || args.len() < self.args.len() {
            return false;
        }
        if !self.rest && args.len() != self.args.len() {
            return false;
        }
        self.args.iter().zip(args).all(|(want, got)| want == got)
    }
}

/// Programs that run whatever code they're given: they always ask, unless a
/// rule names a script for them (`python report.py *`), and never then with
/// an inline-code flag.
fn is_interpreter(name: &str) -> bool {
    matches!(
        name,
        "python" | "python3" | "py" | "node" | "deno" | "bun" | "ruby" | "perl" | "php" | "rscript"
    )
}

/// An interpreter's arguments start with a script to run (`test.js`), not a
/// flag (`-e`, `-c`) or nothing (a prompt).
fn names_script(args: &[String]) -> bool {
    args.first()
        .is_some_and(|a| !a.starts_with('-') && !a.contains(char::is_whitespace))
}

/// Programs that are shells or run another program they're given: always ask.
fn is_runner(name: &str) -> bool {
    matches!(
        name,
        "cmd"
            | "powershell"
            | "pwsh"
            | "bash"
            | "sh"
            | "zsh"
            | "wsl"
            | "npx"
            | "bunx"
            | "uvx"
            | "pipx"
            | "xargs"
            | "env"
            | "start"
            | "explorer"
            | "rundll32"
            | "mshta"
            | "cscript"
            | "wscript"
            | "regsvr32"
            | "schtasks"
            | "at"
            | "msiexec"
            | "winget"
            | "choco"
            | "scoop"
            | "conhost"
    )
}

/// Why a command always asks, whatever the rules say (built-in deny list).
fn built_in_reason(name: &str, args: &[String]) -> Option<&'static str> {
    let has = |flags: &[&str]| args.iter().any(|a| flags.contains(&a.as_str()));
    let first = args.first().map(String::as_str).unwrap_or_default();
    match name {
        "rm" | "rmdir" | "rd" | "del" | "erase" | "rimraf" | "trash" => Some("It deletes files."),
        "format" | "diskpart" | "reg" | "regedit" | "bcdedit" | "shutdown" | "takeown"
        | "icacls" | "cacls" | "net" | "sc" | "wmic" | "vssadmin" | "cipher" | "mklink"
        | "setx" | "attrib" | "fsutil" => Some("It changes the system or its security settings."),
        "sudo" | "runas" | "gsudo" | "doas" => Some("It runs something with raised permissions."),
        "git" => {
            if has(&["-c", "-C", "--git-dir", "--work-tree", "--exec-path"]) {
                Some("It points git at other settings or another folder.")
            } else if first == "push"
                && has(&[
                    "--force",
                    "-f",
                    "--force-with-lease",
                    "--mirror",
                    "--delete",
                    "-d",
                ])
            {
                Some("It rewrites or deletes what's on the server.")
            } else if first == "reset" && has(&["--hard"]) || first == "clean" {
                Some("It throws away work that isn't saved in git.")
            } else {
                None
            }
        }
        "find" if has(&["-exec", "-execdir", "-delete", "-ok"]) => {
            Some("It runs other commands or deletes files.")
        }
        "npm" | "pnpm" | "yarn" if first == "dlx" || first == "exec" || first == "x" => {
            Some("It downloads and runs a package.")
        }
        "npm" | "pnpm" | "yarn" if first == "publish" => Some("It publishes a package."),
        "curl" | "wget"
            if has(&[
                "-o",
                "-O",
                "--output",
                "--upload-file",
                "-T",
                "-d",
                "--data",
            ]) =>
        {
            Some("It writes downloaded files or sends data.")
        }
        _ => None,
    }
}

/// Why a command is too unusual to run without asking.
fn odd_reason(program: &str, args: &[String]) -> Option<&'static str> {
    let all = std::iter::once(program).chain(args.iter().map(String::as_str));
    let mut length = 0;
    for part in all {
        length += part.len() + 1;
        if part.contains(['\n', '\r', '\0']) {
            return Some("An argument has a line break in it.");
        }
        if part.starts_with("\\\\") || part.starts_with("//") {
            return Some("It names a network path, which can send your Windows sign-in there.");
        }
    }
    if length > MAX_COMMAND_CHARS {
        return Some("The command is very long.");
    }
    if program.trim().is_empty() {
        return Some("It doesn't name a program.");
    }
    None
}

/// What [`judge`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Run without asking: this allow rule covers it.
    Run { rule: String },
    /// Ask first, for this reason; `remember` when "allow from now on" may be
    /// offered (never for a deny-listed or runner command); `risky` when it
    /// matched an always-ask rule or the built-in list (deleting files,
    /// throwing work away), so the card can warn.
    Ask {
        reason: String,
        remember: bool,
        risky: bool,
    },
}

/// The rules that apply to a command, and whether the agent read outside
/// content first (`tainted`, a description such as "3 web pages").
pub struct Judging<'a> {
    pub allow: &'a [String],
    pub deny: &'a [String],
    pub global_deny: &'a [String],
    pub tainted: Option<&'a str>,
}

/// Decide whether `program args` runs without asking (see the module docs).
pub fn judge(program: &str, args: &[String], rules: &Judging<'_>) -> Verdict {
    let name = program_name(program);
    let ask = |reason: String, remember: bool| Verdict::Ask {
        reason,
        remember,
        risky: false,
    };
    let risky = |reason: String| Verdict::Ask {
        reason,
        remember: false,
        risky: true,
    };
    if let Some(reason) = odd_reason(program, args) {
        return ask(reason.to_string(), false);
    }
    for (list, whose) in [(rules.deny, "this workflow's"), (rules.global_deny, "your")] {
        if let Some(rule) = list
            .iter()
            .find(|r| parse_rule(r).is_ok_and(|r| r.matches(program, args)))
        {
            return risky(format!(
                "It matches {whose} always-ask rule \u{201c}{rule}\u{201d}."
            ));
        }
    }
    if let Some(reason) = built_in_reason(&name, args) {
        return risky(format!("{reason} Commands like this always ask."));
    }
    if is_runner(&name) {
        return ask(
            "It runs other programs or code, so it always asks.".to_string(),
            false,
        );
    }
    let allowed = rules.allow.iter().find(|text| {
        parse_rule(text).is_ok_and(|rule| {
            rule.matches(program, args)
                // An interpreter's rule must name a script, never a flag.
                && (!is_interpreter(&name)
                    || rule.args.first().is_some_and(|a| !a.starts_with('-')))
        })
    });
    if is_interpreter(&name) && allowed.is_none() {
        // A rule naming the script may be offered; one for the bare
        // interpreter or a flag (`node -e`) never is.
        return ask(
            "It runs code, so it asks unless a rule names the script.".to_string(),
            names_script(args),
        );
    }
    match (allowed, rules.tainted) {
        (Some(_), Some(_)) => ask(
            "This agent read outside content first, and that can't choose commands on its own."
                .to_string(),
            false,
        ),
        (Some(rule), None) => Verdict::Run { rule: rule.clone() },
        (None, _) => ask("No rule covers it.".to_string(), true),
    }
}

/// The narrowest rule that would cover `program args`: the program and its
/// first argument when that's a word (`git log *`), else the program alone.
pub fn suggested_rule(program: &str, args: &[String]) -> String {
    let name = program_name(program);
    if is_interpreter(&name) && names_script(args) {
        // The script itself, so the rule never covers other code.
        return match args {
            [script] => format!("{name} {script}"),
            [script, ..] => format!("{name} {script} *"),
            [] => name,
        };
    }
    match args {
        [first, ..] if !first.starts_with('-') && !first.contains(['/', '\\']) => {
            format!("{name} {first} *")
        }
        // Just a flag (`git --version`): that exact command.
        [only] if only.starts_with('-') && !only.contains(['/', '\\']) => format!("{name} {only}"),
        [_, ..] => format!("{name} *"),
        [] => name,
    }
}

/// Examples that show what a rule covers and doesn't, for the editor.
pub fn rule_examples(text: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let rule = parse_rule(text)?;
    let base = std::iter::once(rule.program.clone())
        .chain(rule.args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");
    let mut covered = vec![base.clone()];
    if rule.rest {
        covered.push(format!("{base} --help"));
        covered.push(format!("{base} some-file.txt"));
    }
    let mut not = Vec::new();
    if !rule.rest {
        not.push(format!("{base} --extra"));
    }
    match rule.args.first() {
        Some(_) => not.push(format!("{} something-else", rule.program)),
        None => not.push("another-program".to_string()),
    }
    not.push(format!("cmd /c {base}"));
    Ok((covered, not))
}

/// Find `program` the way a shell would: a path inside `folder` as given, or
/// on PATH, trying Windows' executable extensions.
pub fn resolve_program(program: &str, folder: &Path) -> Result<PathBuf, String> {
    let not_found =
        || format!("There's no program called \u{201c}{program}\u{201d} on this computer.");
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        Vec::new()
    };
    let candidates = |base: PathBuf| -> Vec<PathBuf> {
        let mut out = vec![base.clone()];
        for ext in &extensions {
            let mut with = base.clone().into_os_string();
            with.push(ext);
            out.push(PathBuf::from(with));
        }
        out
    };
    if program.contains(['/', '\\']) {
        let path = if Path::new(program).is_absolute() {
            PathBuf::from(program)
        } else {
            folder.join(program)
        };
        let real = candidates(path)
            .into_iter()
            .find(|p| p.is_file())
            .ok_or_else(not_found)?;
        let real = std::fs::canonicalize(&real).map_err(|_| not_found())?;
        let root = std::fs::canonicalize(folder).map_err(|e| e.to_string())?;
        if !real.starts_with(&root) {
            return Err(
                "A program given by its path must be inside the workflow's folder.".to_string(),
            );
        }
        return Ok(real);
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        if let Some(found) = candidates(dir.join(program))
            .into_iter()
            .find(|p| p.is_file())
        {
            return Ok(found);
        }
    }
    Err(not_found())
}

/// Whether an environment variable looks like it holds a secret.
fn looks_secret(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "API_KEY",
        "APIKEY",
        "PRIVATE_KEY",
    ]
    .iter()
    .any(|word| upper.contains(word))
        || upper.ends_with("_KEY")
}

/// What running a command produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ran {
    pub exit_code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
    pub duration: Duration,
}

impl Ran {
    /// What the model gets back.
    pub fn for_model(&self) -> Value {
        json!({
            "exitCode": self.exit_code,
            "output": self.output,
            "timedOut": self.timed_out,
        })
    }
}

/// This process's environment minus what looks secret, bar `pass_env`.
fn command_env(pass_env: &[String]) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    std::env::vars_os()
        .filter(|(name, _)| {
            let text = name.to_string_lossy();
            !looks_secret(&text) || pass_env.iter().any(|p| p.eq_ignore_ascii_case(&text))
        })
        .collect()
}

/// Whether commands are kept inside the folder here (Windows only, for now).
pub const CAN_CONFINE: bool = cfg!(windows);

/// Run `program args` in `cwd` with no input, the environment minus secrets
/// (bar `pass_env`), and `timeout`; the whole process tree is killed when it
/// runs out or `stop` is cancelled. With `confine_to` (on Windows), it can
/// write only in that folder and has almost no network.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    program: &Path,
    args: &[String],
    cwd: &Path,
    pass_env: &[String],
    timeout: Duration,
    stop: &tokio_util::sync::CancellationToken,
    confine_to: Option<&Path>,
) -> Result<Ran, String> {
    #[cfg(windows)]
    if let Some(folder) = confine_to {
        let (program, args, cwd, folder) = (
            program.to_path_buf(),
            args.to_vec(),
            cwd.to_path_buf(),
            folder.to_path_buf(),
        );
        let env = command_env(pass_env);
        let stop = stop.clone();
        let started = Instant::now();
        let ran = tokio::task::spawn_blocking(move || {
            super::confine::run(
                &program,
                &args,
                &cwd,
                &folder,
                env,
                timeout,
                MAX_OUTPUT_BYTES,
                &stop,
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        if ran.stopped {
            return Err("The run was stopped.".to_string());
        }
        return Ok(Ran {
            exit_code: ran.exit_code,
            output: head_and_tail(&String::from_utf8_lossy(&ran.output)),
            timed_out: ran.timed_out,
            duration: started.elapsed(),
        });
    }
    #[cfg(not(windows))]
    let _ = confine_to;
    run_open(program, args, cwd, pass_env, timeout, stop).await
}

/// [`run`] without confinement.
async fn run_open(
    program: &Path,
    args: &[String],
    cwd: &Path,
    pass_env: &[String],
    timeout: Duration,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Ran, String> {
    use tokio::io::AsyncReadExt;

    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .env_clear()
        .envs(command_env(pass_env));
    #[cfg(windows)]
    {
        // No console window flashing up for each command.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|e| format!("The command couldn't start: {e}"))?;
    let pid = child.id();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let read_all = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let a = async {
            if let Some(p) = stdout.as_mut() {
                let _ = p.take(MAX_OUTPUT_BYTES as u64).read_to_end(&mut out).await;
            }
        };
        let b = async {
            if let Some(p) = stderr.as_mut() {
                let _ = p.take(MAX_OUTPUT_BYTES as u64).read_to_end(&mut err).await;
            }
        };
        tokio::join!(a, b);
        (out, err)
    };
    let waited = async {
        let (out, err) = read_all.await;
        let status = child.wait().await;
        (out, err, status)
    };
    let (out, err, status, timed_out) = tokio::select! {
        (out, err, status) = waited => (out, err, status.ok(), false),
        _ = tokio::time::sleep(timeout) => {
            kill_tree(pid);
            (Vec::new(), Vec::new(), None, true)
        }
        _ = stop.cancelled() => {
            kill_tree(pid);
            return Err("The run was stopped.".to_string());
        }
    };
    let mut text = String::from_utf8_lossy(&out).into_owned();
    let err = String::from_utf8_lossy(&err);
    if !err.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&err);
    }
    Ok(Ran {
        exit_code: status.and_then(|s| s.code()),
        output: head_and_tail(&text),
        timed_out,
        duration: started.elapsed(),
    })
}

/// Kill a process and everything it started.
fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

/// The start and end of a long output, with a note of what was left out.
fn head_and_tail(text: &str) -> String {
    let chars = text.chars().count();
    if chars <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(OUTPUT_HEAD_CHARS).collect();
    let tail: String = text.chars().skip(chars - OUTPUT_TAIL_CHARS).collect();
    format!(
        "{head}\n\n[{} characters left out]\n\n{tail}",
        chars - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS
    )
}

/// Paths in the work folder that are never written, whatever the edit mode:
/// git's own settings and hooks run code (a hostile `.git/config` runs
/// commands even on `git status`). Secrets are refused by the workspace path
/// policy already.
pub fn protected_for_writes(relative: &Path) -> bool {
    let parts: Vec<String> = relative
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(p) => Some(p.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    parts
        .windows(2)
        .any(|w| w[0] == ".git" && (w[1] == "config" || w[1] == "hooks"))
        || parts.first().is_some_and(|p| p == ".git") && parts.len() == 1
}

/// The tools an agent with [`COMPUTER_TOOL`] sees.
pub fn tool_definitions() -> Vec<provider_core::schema::ToolDefinition> {
    let tool =
        |name: &str, description: &str, schema: Value| provider_core::schema::ToolDefinition {
            tool_id: name.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            input_schema: schema,
            kind: None,
            host_config: None,
            permission_level: None,
            display_group: None,
            tenant_scope: None,
        };
    vec![
        tool(
            RUN_TOOL,
            "Run a program in the workflow's folder: the program's name and its arguments as a list (no shell: no pipes, &&, redirection or wildcards). Say why in \"why\". It may wait for the user to allow it. Returns the exit code and output.",
            json!({
                "type": "object",
                "properties": {
                    "program": { "type": "string", "description": "The program, such as git, npm or python." },
                    "args": { "type": "array", "items": { "type": "string" }, "description": "Its arguments, one per item." },
                    "cwd": { "type": "string", "description": "A subfolder of the workflow's folder to run in; the folder itself when left out." },
                    "why": { "type": "string", "description": "What this is for, in a short sentence the user will read." }
                },
                "required": ["program", "why"]
            }),
        ),
        tool(
            LIST_TOOL,
            "List files in the workflow's folder that match a glob pattern, such as **/*.md.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "max_results": { "type": "integer" }
                },
                "required": ["pattern"]
            }),
        ),
        tool(
            READ_TOOL,
            "Read a text file in the workflow's folder (a path relative to it).",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "offset": { "type": "integer" },
                    "limit": { "type": "integer" }
                },
                "required": ["path"]
            }),
        ),
        tool(
            SEARCH_TOOL,
            "Find lines matching a regular expression in the workflow's folder.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string", "description": "A subfolder or file to search in." },
                    "glob": { "type": "string", "description": "Only files matching this glob." },
                    "case_insensitive": { "type": "boolean" }
                },
                "required": ["pattern"]
            }),
        ),
        tool(
            WRITE_TOOL,
            "Create or replace a text file in the workflow's folder with the whole content given. It may wait for the user to allow it.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                    "why": { "type": "string" }
                },
                "required": ["path", "content"]
            }),
        ),
        tool(
            EDIT_TOOL,
            "Change a text file in the workflow's folder: replace old_text, which must appear exactly once, with new_text. It may wait for the user to allow it.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_text": { "type": "string" },
                    "new_text": { "type": "string" },
                    "why": { "type": "string" }
                },
                "required": ["path", "old_text", "new_text"]
            }),
        ),
    ]
}

/// Whether `name` is one of the computer tools.
pub fn is_computer_tool(name: &str) -> bool {
    matches!(
        name,
        RUN_TOOL | LIST_TOOL | READ_TOOL | SEARCH_TOOL | WRITE_TOOL | EDIT_TOOL
    )
}

/// What outside content an agent read before its next command, by kind, in
/// the order first seen (e.g. "web page" twice). Commands it asks for after
/// any of it always ask (the spec's taint rule).
#[derive(Debug, Default)]
pub struct Taint {
    seen: std::sync::Mutex<Vec<String>>,
}

impl Taint {
    pub fn starting_with(sources: Vec<String>) -> Self {
        Self {
            seen: std::sync::Mutex::new(sources),
        }
    }

    pub fn add(&self, source: &str) {
        if let Ok(mut seen) = self.seen.lock() {
            seen.push(source.to_string());
        }
    }

    /// Note a tool the agent called: web search and pages are outside content.
    pub fn saw_tool(&self, tool: &str) {
        match tool {
            "web_search" => self.add("web search"),
            "web_fetch" => self.add("web page"),
            _ => {}
        }
    }

    /// "2 web pages and a web search", or `None` when it read nothing outside.
    pub fn describe(&self) -> Option<String> {
        let seen = self.seen.lock().ok()?;
        if seen.is_empty() {
            return None;
        }
        let mut kinds: Vec<(&str, usize)> = Vec::new();
        for source in seen.iter() {
            match kinds.iter_mut().find(|(k, _)| k == source) {
                Some((_, n)) => *n += 1,
                None => kinds.push((source, 1)),
            }
        }
        let parts: Vec<String> = kinds
            .iter()
            .map(|(kind, n)| match (kind, n) {
                (kind, 1) if kind.starts_with("the ") => kind.to_string(),
                (kind, 1) => format!("a {kind}"),
                (kind, n) if kind.ends_with("search") => format!("{n} {kind}es"),
                (kind, n) => format!("{n} {kind}s"),
            })
            .collect();
        Some(match parts.as_slice() {
            [one] => one.clone(),
            [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
            [] => unreachable!(),
        })
    }
}

/// Step types whose output comes from outside: the web, a connector.
fn reads_outside(step: &super::definition::Step) -> bool {
    use super::definition::StepAction;
    match &step.action {
        StepAction::FetchPage { .. }
        | StepAction::WebSearch { .. }
        | StepAction::Research { .. }
        | StepAction::ConnectorTool { .. } => true,
        StepAction::Agent { tools, agents, .. } => {
            !agents.is_empty()
                || tools
                    .iter()
                    .any(|t| t == "web_search" || t == "web_fetch" || t.contains('/'))
        }
        _ => false,
    }
}

/// The steps whose output may carry outside content: they read it
/// themselves, or their settings read the trigger's item or such a step.
pub fn outside_steps(
    def: &super::definition::WorkflowDefinition,
) -> std::collections::HashSet<String> {
    use super::definition::{Step, StepAction};
    fn flat<'s>(steps: &'s [Step], out: &mut Vec<&'s Step>) {
        for step in steps {
            out.push(step);
            if let StepAction::ForEach { steps, .. } = &step.action {
                flat(steps, out);
            }
        }
    }
    let mut all = Vec::new();
    flat(&def.steps, &mut all);
    let mut outside: std::collections::HashSet<String> = all
        .iter()
        .filter(|s| reads_outside(s))
        .map(|s| s.id.clone())
        .collect();
    loop {
        let before = outside.len();
        for step in &all {
            if outside.contains(&step.id) {
                continue;
            }
            let text = serde_json::to_string(&step.action).unwrap_or_default();
            if mentions_outside(&text, &outside) {
                outside.insert(step.id.clone());
            }
        }
        if outside.len() == before {
            return outside;
        }
    }
}

/// Whether template text reads the trigger's item or one of `outside`.
pub fn mentions_outside(text: &str, outside: &std::collections::HashSet<String>) -> bool {
    text.contains("trigger.")
        || text.match_indices("steps.").any(|(at, _)| {
            let id: String = text[at + 6..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            outside.contains(&id)
        })
}

/// A rule worth offering on the workflow page: commands the user approved
/// one by one, which this rule would have covered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSuggestion {
    pub rule: String,
    /// How many approved commands it would have covered.
    pub times: u32,
    /// One of them, as the user saw it (`git log --oneline`).
    pub example: String,
}

/// The rules to suggest from the computer records of recent runs (newest
/// first): commands the user approved by hand, whose card offered a rule the
/// workflow doesn't have yet. A rule already allowed or matching an
/// always-ask rule is left out.
pub fn suggestions<'v>(
    records: impl IntoIterator<Item = &'v Value>,
    rules: &CommandRules,
) -> Vec<RuleSuggestion> {
    let mut found: Vec<RuleSuggestion> = Vec::new();
    for record in records {
        let text = |key: &str| record.get(key).and_then(Value::as_str).unwrap_or_default();
        if text("kind") != "command" || text("approvedBy") != "you" || text("outcome") != "ran" {
            continue;
        }
        let rule = text("suggestedRule").trim();
        if rule.is_empty() || parse_rule(rule).is_err() || rules.allow.iter().any(|r| r == rule) {
            continue;
        }
        let args: Vec<String> = record
            .get("args")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let program = text("program");
        if rules
            .deny
            .iter()
            .any(|d| parse_rule(d).is_ok_and(|d| d.matches(program, &args)))
        {
            continue;
        }
        match found.iter_mut().find(|s| s.rule == rule) {
            Some(seen) => seen.times += 1,
            None => found.push(RuleSuggestion {
                rule: rule.to_string(),
                times: 1,
                example: std::iter::once(program_name(program))
                    .chain(args)
                    .collect::<Vec<_>>()
                    .join(" "),
            }),
        }
    }
    found.sort_by_key(|s| std::cmp::Reverse(s.times));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn judged(program: &str, list: &[&str], allow: &[&str]) -> Verdict {
        let allow: Vec<String> = allow.iter().map(|s| s.to_string()).collect();
        judge(
            program,
            &args(list),
            &Judging {
                allow: &allow,
                deny: &[],
                global_deny: &[],
                tainted: None,
            },
        )
    }

    fn runs(v: &Verdict) -> bool {
        matches!(v, Verdict::Run { .. })
    }

    #[test]
    fn rules_match_the_program_and_leading_arguments() {
        let rule = parse_rule("git log *").unwrap();
        assert!(rule.matches("git", &args(&["log"])));
        assert!(rule.matches(
            "C:\\Program Files\\Git\\cmd\\GIT.EXE",
            &args(&["log", "-5"])
        ));
        assert!(!rule.matches("git", &args(&["status"])));
        let exact = parse_rule("npm test").unwrap();
        assert!(exact.matches("npm.cmd", &args(&["test"])));
        assert!(!exact.matches("npm", &args(&["test", "--", "--watch"])));
        assert!(parse_rule("*").is_err());
        assert!(parse_rule("git l*g").is_err());
        assert!(parse_rule("  ").is_err());
    }

    #[test]
    fn an_allow_rule_runs_and_no_rule_asks() {
        assert!(runs(&judged("git", &["status"], &["git status"])));
        assert_eq!(
            judged("git", &["status"], &[]),
            Verdict::Ask {
                reason: "No rule covers it.".to_string(),
                remember: true,
                risky: false,
            }
        );
    }

    #[test]
    fn deny_lists_and_runners_always_ask() {
        for (program, list) in [
            ("rm", &["-rf", "build"][..]),
            ("git", &["push", "--force"][..]),
            ("git", &["-C", "..", "status"][..]),
            ("git", &["reset", "--hard"][..]),
            ("cmd", &["/c", "dir"][..]),
            ("powershell", &["-Command", "ls"][..]),
            ("npx", &["prettier"][..]),
            ("npm", &["exec", "x"][..]),
            ("reg", &["add", "HKCU\\x"][..]),
            ("find", &[".", "-delete"][..]),
        ] {
            let v = judged(
                program,
                list,
                &[
                    "rm *",
                    "git *",
                    "cmd *",
                    "powershell *",
                    "npx *",
                    "npm *",
                    "reg *",
                    "find *",
                ],
            );
            assert!(
                matches!(
                    v,
                    Verdict::Ask {
                        remember: false,
                        ..
                    }
                ),
                "{program} {list:?}: {v:?}"
            );
        }
    }

    #[test]
    fn interpreters_need_a_rule_that_names_a_script() {
        assert!(runs(&judged(
            "python",
            &["report.py", "--week"],
            &["python report.py *"]
        )));
        assert!(!runs(&judged("python", &["-c", "print(1)"], &["python *"])));
        assert!(!runs(&judged(
            "python",
            &["other.py"],
            &["python report.py *"]
        )));
        assert!(!runs(&judged("node", &["-e", "1"], &["node -e *"])));
        // A rule for the script is offered, never one for code in a flag.
        assert!(matches!(
            judged("node", &["test.js"], &[]),
            Verdict::Ask { remember: true, .. }
        ));
        assert!(matches!(
            judged("node", &["-e", "1"], &[]),
            Verdict::Ask {
                remember: false,
                ..
            }
        ));
        assert_eq!(suggested_rule("node", &args(&["test.js"])), "node test.js");
        assert_eq!(
            suggested_rule(
                "C:\\Python\\python.exe",
                &args(&["tools/report.py", "--week"])
            ),
            "python tools/report.py *"
        );
        let offered = suggested_rule("node", &args(&["test.js"]));
        assert!(runs(&judged("node", &["test.js"], &[offered.as_str()])));
        assert!(!runs(&judged("node", &["other.js"], &[offered.as_str()])));
    }

    #[test]
    fn odd_commands_ask() {
        assert!(!runs(&judged("git", &["log", "a\nb"], &["git log *"])));
        assert!(!runs(&judged(
            "git",
            &["log", "\\\\host\\share"],
            &["git log *"]
        )));
        let long = "x".repeat(MAX_COMMAND_CHARS + 1);
        assert!(!runs(&judged("git", &["log", &long], &["git log *"])));
    }

    #[test]
    fn deny_rules_beat_allow_rules_and_taint_turns_allows_off() {
        let allow = vec!["git *".to_string()];
        let deny = vec!["git push *".to_string()];
        let rules = Judging {
            allow: &allow,
            deny: &deny,
            global_deny: &[],
            tainted: None,
        };
        assert!(matches!(
            judge("git", &args(&["push", "origin"]), &rules),
            Verdict::Ask {
                remember: false,
                ..
            }
        ));
        assert!(runs(&judge("git", &args(&["status"]), &rules)));
        let tainted = Judging {
            tainted: Some("2 web pages"),
            ..rules
        };
        match judge("git", &args(&["status"]), &tainted) {
            Verdict::Ask {
                reason, remember, ..
            } => {
                assert!(reason.contains("outside content"));
                assert!(!remember);
            }
            v => panic!("{v:?}"),
        }
    }

    #[test]
    fn suggestions_come_from_commands_approved_by_hand() {
        let ran = |args: &[&str], by: &str, rule: Option<&str>| {
            let mut r = serde_json::json!({
                "kind": "command", "program": "C:\\Git\\git.exe", "args": args,
                "approvedBy": by, "outcome": "ran",
            });
            if let Some(rule) = rule {
                r["suggestedRule"] = Value::String(rule.into());
            }
            r
        };
        let records = [
            ran(&["diff"], "you", Some("git diff *")),
            ran(&["diff", "--stat"], "you", Some("git diff *")),
            ran(&["log"], "you", Some("git log *")),
            ran(&["status"], "rule: git status *", None),
            ran(&["push"], "you", Some("git push *")),
        ];
        let rules = CommandRules {
            allow: vec!["git log *".into()],
            deny: vec!["git push *".into()],
            uses: Vec::new(),
        };
        let found = suggestions(&records, &rules);
        assert_eq!(
            found,
            vec![RuleSuggestion {
                rule: "git diff *".into(),
                times: 2,
                example: "git diff".into(),
            }]
        );
    }

    #[test]
    fn rule_uses_are_counted_and_kept_for_rules_still_there() {
        let mut stored = CommandRules {
            allow: vec!["git log *".into(), "npm test *".into()],
            ..Default::default()
        };
        stored.note_use("git log *", "2026-10-15T10:00:00Z");
        stored.note_use("git log *", "2026-10-15T11:00:00Z");
        stored.note_use("npm test *", "2026-10-15T09:00:00Z");
        assert_eq!(stored.uses[0].count, 2);
        assert_eq!(stored.uses[0].last_used_at, "2026-10-15T11:00:00Z");
        let mut sent = CommandRules {
            allow: vec!["git log *".into()],
            ..Default::default()
        };
        sent.keep_uses(&stored);
        assert_eq!(sent.uses.len(), 1);
        assert_eq!(sent.uses[0].rule, "git log *");
    }

    #[test]
    fn always_ask_rules_and_built_ins_are_risky() {
        let deny = vec!["git push *".to_string()];
        let rules = Judging {
            allow: &[],
            deny: &deny,
            global_deny: &[],
            tainted: None,
        };
        for (program, list) in [("git", &["push"][..]), ("git", &["reset", "--hard"][..])] {
            match judge(program, &args(list), &rules) {
                Verdict::Ask { risky, .. } => assert!(risky, "{list:?}"),
                v => panic!("{v:?}"),
            }
        }
        match judge("git", &args(&["log"]), &rules) {
            Verdict::Ask { risky, .. } => assert!(!risky),
            v => panic!("{v:?}"),
        }
    }

    #[test]
    fn suggested_rules_are_narrow() {
        assert_eq!(suggested_rule("git", &args(&["log", "-5"])), "git log *");
        assert_eq!(
            suggested_rule("C:\\x\\npm.cmd", &args(&["test"])),
            "npm test *"
        );
        assert_eq!(suggested_rule("ls", &args(&["-la"])), "ls -la");
        assert_eq!(suggested_rule("ls", &args(&["-la", "src"])), "ls *");
        assert_eq!(suggested_rule("whoami", &[]), "whoami");
    }

    #[test]
    fn rule_examples_show_both_sides() {
        let (yes, no) = rule_examples("git log *").unwrap();
        assert!(yes.contains(&"git log --help".to_string()));
        assert!(no.contains(&"git something-else".to_string()));
        let (yes, no) = rule_examples("npm test").unwrap();
        assert_eq!(yes, vec!["npm test".to_string()]);
        assert!(no.contains(&"npm test --extra".to_string()));
    }

    #[test]
    fn git_settings_and_hooks_are_protected() {
        assert!(protected_for_writes(Path::new(".git/config")));
        assert!(protected_for_writes(Path::new(".git/hooks/pre-commit")));
        assert!(protected_for_writes(Path::new(".git")));
        assert!(!protected_for_writes(Path::new("src/.gitignore")));
        assert!(!protected_for_writes(Path::new("notes/config")));
    }

    #[test]
    fn secret_looking_variables_are_left_out() {
        assert!(looks_secret("GITHUB_TOKEN"));
        assert!(looks_secret("OPENAI_API_KEY"));
        assert!(looks_secret("AWS_SECRET_ACCESS_KEY"));
        assert!(!looks_secret("PATH"));
        assert!(!looks_secret("USERPROFILE"));
    }

    #[tokio::test]
    async fn a_command_runs_in_the_folder_and_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let stop = tokio_util::sync::CancellationToken::new();
        let (program, list) = if cfg!(windows) {
            ("cmd", args(&["/c", "cd"]))
        } else {
            ("pwd", Vec::new())
        };
        let program = resolve_program(program, dir.path()).unwrap();
        let ran = run(
            &program,
            &list,
            dir.path(),
            &[],
            Duration::from_secs(20),
            &stop,
            None,
        )
        .await
        .unwrap();
        assert_eq!(ran.exit_code, Some(0));
        let shown = std::fs::canonicalize(dir.path()).unwrap();
        let shown = shown.to_string_lossy();
        let shown = shown.trim_start_matches(r"\\?\");
        assert!(
            ran.output.trim().eq_ignore_ascii_case(shown),
            "{} vs {}",
            ran.output,
            shown
        );

        let (program, list) = if cfg!(windows) {
            ("ping", args(&["-n", "30", "127.0.0.1"]))
        } else {
            ("sleep", args(&["30"]))
        };
        let program = resolve_program(program, dir.path()).unwrap();
        let ran = run(
            &program,
            &list,
            dir.path(),
            &[],
            Duration::from_millis(500),
            &stop,
            Some(dir.path()),
        )
        .await
        .unwrap();
        assert!(ran.timed_out);
    }

    #[test]
    fn taint_describes_what_was_read() {
        let taint = Taint::default();
        assert_eq!(taint.describe(), None);
        taint.saw_tool("calculator");
        assert_eq!(taint.describe(), None);
        taint.saw_tool("web_fetch");
        taint.saw_tool("web_fetch");
        taint.saw_tool("web_search");
        assert_eq!(taint.describe().unwrap(), "2 web pages and a web search");
        let handed = Taint::starting_with(vec!["the item that started this run".into()]);
        assert_eq!(handed.describe().unwrap(), "the item that started this run");
    }

    #[test]
    fn outside_content_flows_through_the_steps_that_read_it() {
        let def: crate::workflows::definition::WorkflowDefinition =
            serde_json::from_value(json!({ "steps": [
                { "id": "page", "type": "fetch_page", "urls": ["https://example.com"] },
                { "id": "sum", "type": "summarize", "prompt": "Sum", "input": "{{steps.page.text}}" },
                { "id": "mine", "type": "template", "template": "{{inputs.x}}" },
                { "id": "both", "type": "template", "template": "{{steps.mine.text}} {{steps.sum.text}}" },
                { "id": "item", "type": "template", "template": "{{trigger.title}}" },
            ], "inputs": [{ "id": "x", "label": "X" }] }))
            .unwrap();
        let outside = outside_steps(&def);
        for id in ["page", "sum", "both", "item"] {
            assert!(outside.contains(id), "{id}");
        }
        assert!(!outside.contains("mine"));
        assert!(mentions_outside("Use {{steps.sum.text}}", &outside));
        assert!(!mentions_outside(
            "Use {{steps.mine.text}} and {{inputs.x}}",
            &outside
        ));
    }

    #[test]
    fn long_output_keeps_its_start_and_end() {
        let text = format!("{}{}", "a".repeat(20_000), "b".repeat(20_000));
        let kept = head_and_tail(&text);
        assert!(kept.starts_with('a') && kept.ends_with('b'));
        assert!(kept.contains("characters left out"));
    }
}
