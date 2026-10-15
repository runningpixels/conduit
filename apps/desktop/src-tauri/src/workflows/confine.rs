//! Keeping an agent's commands inside the workflow's folder, on Windows,
//! without admin rights or an install (spec §8; spike 2026-10-15).
//!
//! A command runs under a **write-restricted token**: a copy of the user's own
//! token that may still read what the user can, but may write only where an
//! ACL also grants Conduit's own SID ([`CONDUIT_SID`]) — the workflow's folder
//! and a per-run temp folder. It runs in a **job object** that kills every
//! process it started when the command ends or runs out of time, and whose
//! network rate is throttled to almost nothing (a soft "no network": real
//! blocking needs AppContainer, which also stops reading the user's profile).
//!
//! The SID is the same for every run, so an ACE left on a folder by a crash is
//! harmless: only processes Conduit starts this way carry it. Folders in use
//! are counted, so one run finishing doesn't revoke a folder another run is
//! still using.
//!
//! Known limits (from the spike): node's child processes with *piped* stdio
//! fail (EPERM), Windows' own TLS (curl over HTTPS, PowerShell web requests)
//! fails, and a folder anyone can write to stays writable. A workflow can turn
//! confinement off for programs that break (`ComputerConfig::allow_outside`).

use std::collections::HashMap;
use std::ffi::{c_void, OsString};
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
    HLOCAL, WAIT_TIMEOUT,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
    EXPLICIT_ACCESS_W, GRANT_ACCESS, REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
    TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows::Win32::Security::{
    CreateRestrictedToken, GetTokenInformation, SetTokenInformation, TokenDefaultDacl, TokenUser,
    ACE_FLAGS, ACL, DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE, NO_INHERITANCE,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY,
    TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE, TOKEN_QUERY, TOKEN_USER, WRITE_RESTRICTED,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    JobObjectNetRateControlInformation, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOBOBJECT_NET_RATE_CONTROL_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_NET_RATE_CONTROL_ENABLE,
    JOB_OBJECT_NET_RATE_CONTROL_MAX_BANDWIDTH,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, ResumeThread,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};

/// Conduit's own SID for confined commands. Not an account: only tokens made
/// here carry it, and the ACLs on work folders grant it.
const CONDUIT_SID: &str = "S-1-5-21-2635412-3129481-1734582-1001";
/// The write-restricted check also needs these in the restricting list, or
/// processes fail to start (RESTRICTED) and can't open NUL (Everyone).
const RESTRICTED_SID: &str = "S-1-5-12";
const EVERYONE_SID: &str = "S-1-1-0";
/// FILE_ALL_ACCESS for the folder ACE; GENERIC_ALL for the token's default DACL.
const FILE_ALL_ACCESS: u32 = 0x001F_01FF;
const GENERIC_ALL: u32 = 0x1000_0000;
const GENERIC_READ: u32 = 0x8000_0000;
/// The job's network cap, in bytes a second: low enough to count as off.
const NET_BYTES_PER_SEC: u64 = 8;

/// What a confined command produced.
pub struct Confined {
    pub exit_code: Option<i32>,
    pub output: Vec<u8>,
    pub timed_out: bool,
    pub stopped: bool,
}

/// Folders granted to [`CONDUIT_SID`], with how many runs are using each.
static GRANTED: Mutex<Option<HashMap<PathBuf, usize>>> = Mutex::new(None);

fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}

/// A SID from its string form; freed with `LocalFree` by [`Sid`]'s drop.
struct Sid(PSID);

impl Sid {
    fn parse(text: &str) -> Result<Self, String> {
        let w = wide(std::ffi::OsStr::new(text));
        let mut sid = PSID::default();
        unsafe { ConvertStringSidToSidW(PCWSTR(w.as_ptr()), &mut sid) }
            .map_err(|e| format!("SID {text}: {e}"))?;
        Ok(Self(sid))
    }
}

impl Drop for Sid {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0 .0)));
        }
    }
}

fn access(
    sid: PSID,
    rights: u32,
    mode: windows::Win32::Security::Authorization::ACCESS_MODE,
    inherit: bool,
) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: rights,
        grfAccessMode: mode,
        grfInheritance: if inherit {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            NO_INHERITANCE
        },
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: PWSTR(sid.0 as *mut u16),
            ..Default::default()
        },
    }
}

/// Grant (or revoke) [`CONDUIT_SID`] full access to `dir`, inherited by
/// everything inside it.
fn folder_ace(dir: &Path, sid: &Sid, revoke: bool) -> Result<(), String> {
    let path = wide(dir.as_os_str());
    unsafe {
        let mut old: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        GetNamedSecurityInfoW(
            PCWSTR(path.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut old),
            None,
            &mut descriptor,
        )
        .ok()
        .map_err(|e| format!("reading the folder's permissions: {e}"))?;
        let entry = access(
            sid.0,
            FILE_ALL_ACCESS,
            if revoke { REVOKE_ACCESS } else { GRANT_ACCESS },
            true,
        );
        let mut updated: *mut ACL = std::ptr::null_mut();
        let set = SetEntriesInAclW(Some(&[entry]), Some(old), &mut updated)
            .ok()
            .map_err(|e| format!("changing the folder's permissions: {e}"))
            .and_then(|()| {
                SetNamedSecurityInfoW(
                    PCWSTR(path.as_ptr()),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    Some(updated),
                    None,
                )
                .ok()
                .map_err(|e| format!("saving the folder's permissions: {e}"))
            });
        if !updated.is_null() {
            let _ = LocalFree(Some(HLOCAL(updated as *mut c_void)));
        }
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        set
    }
}

/// Let confined commands write in `folder` while the returned guard lives.
struct FolderGrant {
    folder: PathBuf,
}

impl FolderGrant {
    fn take(folder: &Path) -> Result<Self, String> {
        let mut granted = GRANTED
            .lock()
            .map_err(|_| "folder grants are unavailable".to_string())?;
        let counts = granted.get_or_insert_with(HashMap::new);
        let count = counts.entry(folder.to_path_buf()).or_insert(0);
        if *count == 0 {
            folder_ace(folder, &Sid::parse(CONDUIT_SID)?, false)?;
        }
        *count += 1;
        Ok(Self {
            folder: folder.to_path_buf(),
        })
    }
}

impl Drop for FolderGrant {
    fn drop(&mut self) {
        let Ok(mut granted) = GRANTED.lock() else {
            return;
        };
        let Some(counts) = granted.as_mut() else {
            return;
        };
        if let Some(count) = counts.get_mut(&self.folder) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.folder);
                if let Ok(sid) = Sid::parse(CONDUIT_SID) {
                    if let Err(e) = folder_ace(&self.folder, &sid, true) {
                        tracing::warn!(error = %e, "could not take back a folder's write access");
                    }
                }
            }
        }
    }
}

/// An owned handle, closed on drop.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// The current user's SID, as a string (kept as text so it outlives the
/// token buffer).
fn user_sid() -> Result<Sid, String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| e.to_string())?;
        let token = Owned(token);
        let mut length = 0u32;
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut length);
        let mut buffer = vec![0u8; length as usize];
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(buffer.as_mut_ptr() as *mut c_void),
            length,
            &mut length,
        )
        .map_err(|e| e.to_string())?;
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        windows::Win32::Security::Authorization::ConvertSidToStringSidW(user.User.Sid, &mut text)
            .map_err(|e| e.to_string())?;
        let string = text.to_string().map_err(|e| e.to_string())?;
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut c_void)));
        Sid::parse(&string)
    }
}

/// A write-restricted copy of this process's token: it writes only where
/// [`CONDUIT_SID`] (or Everyone) is granted.
fn restricted_token(conduit: &Sid, restricted: &Sid, everyone: &Sid) -> Result<Owned, String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            &mut token,
        )
        .map_err(|e| e.to_string())?;
        let token = Owned(token);
        let restricting: Vec<SID_AND_ATTRIBUTES> = [conduit, restricted, everyone]
            .iter()
            .map(|sid| SID_AND_ATTRIBUTES {
                Sid: sid.0,
                Attributes: 0,
            })
            .collect();
        let mut confined = HANDLE::default();
        CreateRestrictedToken(
            token.0,
            DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED,
            None,
            None,
            Some(&restricting),
            &mut confined,
        )
        .map_err(|e| format!("making a restricted token: {e}"))?;
        let confined = Owned(confined);
        // What the command creates (its pipes, its files) must pass the
        // restricted check too.
        let user = user_sid()?;
        let entries: Vec<EXPLICIT_ACCESS_W> = [&user, conduit, restricted, everyone]
            .iter()
            .map(|sid| access(sid.0, GENERIC_ALL, GRANT_ACCESS, false))
            .collect();
        let mut acl: *mut ACL = std::ptr::null_mut();
        SetEntriesInAclW(Some(&entries), None, &mut acl)
            .ok()
            .map_err(|e| e.to_string())?;
        let dacl = TOKEN_DEFAULT_DACL { DefaultDacl: acl };
        let set = SetTokenInformation(
            confined.0,
            TokenDefaultDacl,
            &dacl as *const _ as *const c_void,
            std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
        );
        let _ = LocalFree(Some(HLOCAL(acl as *mut c_void)));
        let _ = ACE_FLAGS(0);
        set.map_err(|e| e.to_string())?;
        Ok(confined)
    }
}

/// Quote one argument the way Windows programs split their command line.
fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(slashes * 2 + 1));
                quoted.push('"');
                slashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(slashes));
                slashes = 0;
                quoted.push(c);
            }
        }
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}

/// The command line for `program args`. A batch file (`npm.cmd`) runs through
/// `cmd /c`, which reads `&`, `|`, `%` and the like as commands, so an
/// argument with any of them is refused rather than escaped.
fn command_line(program: &Path, args: &[String]) -> Result<String, String> {
    let is_batch = program
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let shown = program.to_string_lossy();
    let mut line = quote(&shown);
    for arg in args {
        if is_batch && arg.contains(['&', '|', '<', '>', '^', '%', '!', '"', '\n', '\r']) {
            return Err(format!(
                "\u{201c}{}\u{201d} is a batch file, and an argument has characters it would treat as commands.",
                program.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()
            ));
        }
        line.push(' ');
        line.push_str(&quote(arg));
    }
    if is_batch {
        let cmd =
            std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string());
        Ok(format!("{} /d /s /c \"{line}\"", quote(&cmd)))
    } else {
        Ok(line)
    }
}

/// A Windows environment block: `NAME=value\0…\0\0`, sorted by name.
fn environment_block(env: &[(OsString, OsString)]) -> Vec<u16> {
    let mut sorted: Vec<&(OsString, OsString)> = env.iter().collect();
    sorted.sort_by_key(|(name, _)| name.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (name, value) in sorted {
        block.extend(name.encode_wide());
        block.push('=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

/// Run `program args` in `cwd` (inside `folder`), able to write only in
/// `folder` and a temp folder of its own, with `env`, no input, and almost no
/// network; the whole process tree ends when it does, runs out of `timeout`,
/// or `stop` is cancelled. Blocking: call it from a blocking thread.
#[allow(clippy::too_many_arguments)]
pub fn run(
    program: &Path,
    args: &[String],
    cwd: &Path,
    folder: &Path,
    mut env: Vec<(OsString, OsString)>,
    timeout: Duration,
    max_output: usize,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Confined, String> {
    let plain = |p: &Path| {
        let text = p.to_string_lossy();
        PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string())
    };
    let folder = plain(folder);
    let cwd = plain(cwd);
    let line = command_line(&plain(program), args)?;
    let _grant = FolderGrant::take(&folder)?;

    // A temp folder of its own, the only other place it may write; caches
    // that would go under the user's profile go there too.
    let temp = std::env::temp_dir().join(format!("conduit-run-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).map_err(|e| format!("making a temp folder: {e}"))?;
    struct Remove(PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _remove = Remove(temp.clone());
    let conduit = Sid::parse(CONDUIT_SID)?;
    folder_ace(&temp, &conduit, false)?;
    let redirect = [
        ("TEMP", temp.clone()),
        ("TMP", temp.clone()),
        ("npm_config_cache", temp.join("npm-cache")),
        ("PIP_CACHE_DIR", temp.join("pip-cache")),
    ];
    env.retain(|(name, _)| {
        !redirect
            .iter()
            .any(|(r, _)| name.to_string_lossy().eq_ignore_ascii_case(r))
    });
    env.extend(
        redirect
            .iter()
            .map(|(name, path)| (OsString::from(name), path.clone().into_os_string())),
    );

    let restricted = Sid::parse(RESTRICTED_SID)?;
    let everyone = Sid::parse(EVERYONE_SID)?;
    let token = restricted_token(&conduit, &restricted, &everyone)?;

    unsafe {
        let job = Owned(CreateJobObjectW(None, PCWSTR::null()).map_err(|e| e.to_string())?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            std::mem::size_of_val(&limits) as u32,
        )
        .map_err(|e| e.to_string())?;
        let net = JOBOBJECT_NET_RATE_CONTROL_INFORMATION {
            MaxBandwidth: NET_BYTES_PER_SEC,
            ControlFlags: JOB_OBJECT_NET_RATE_CONTROL_ENABLE
                | JOB_OBJECT_NET_RATE_CONTROL_MAX_BANDWIDTH,
            ..Default::default()
        };
        if let Err(e) = SetInformationJobObject(
            job.0,
            JobObjectNetRateControlInformation,
            &net as *const _ as *const c_void,
            std::mem::size_of_val(&net) as u32,
        ) {
            tracing::warn!(error = %e, "could not cap a confined command's network");
        }

        // Its output (stdout and stderr together) comes through one pipe;
        // its input is NUL.
        let inherit = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: true.into(),
        };
        let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
        CreatePipe(&mut read, &mut write, Some(&inherit), 0).map_err(|e| e.to_string())?;
        let write = Owned(write);
        SetHandleInformation(read, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0))
            .map_err(|e| e.to_string())?;
        let reader_handle = read.0 as usize;
        let null = Owned(
            CreateFileW(
                PCWSTR(wide(std::ffi::OsStr::new("NUL")).as_ptr()),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                Some(&inherit),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
            .map_err(|e| e.to_string())?,
        );

        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            dwFlags: STARTF_USESTDHANDLES,
            hStdInput: null.0,
            hStdOutput: write.0,
            hStdError: write.0,
            ..Default::default()
        };
        let mut line = wide(std::ffi::OsStr::new(&line));
        let cwd = wide(cwd.as_os_str());
        let block = environment_block(&env);
        let mut process = PROCESS_INFORMATION::default();
        let created = CreateProcessAsUserW(
            Some(token.0),
            PCWSTR::null(),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            true,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            Some(block.as_ptr() as *const c_void),
            PCWSTR(cwd.as_ptr()),
            &startup,
            &mut process,
        );
        drop(write);
        drop(null);
        // From here the reader owns the read end.
        let reader = std::thread::spawn(move || {
            let file = std::fs::File::from_raw_handle(reader_handle as *mut c_void);
            let mut output = Vec::new();
            let _ = file.take(max_output as u64).read_to_end(&mut output);
            output
        });
        if let Err(e) = created {
            let _ = reader.join();
            return Err(format!("The command couldn't start: {e}"));
        }
        let process_handle = Owned(process.hProcess);
        let _thread = Owned(process.hThread);
        if let Err(e) = AssignProcessToJobObject(job.0, process_handle.0) {
            let _ = TerminateJobObject(job.0, 1);
            return Err(format!("The command couldn't be contained: {e}"));
        }
        ResumeThread(process.hThread);

        let started = Instant::now();
        let mut timed_out = false;
        let mut stopped = false;
        loop {
            if WaitForSingleObject(process_handle.0, 200) != WAIT_TIMEOUT {
                break;
            }
            if stop.is_cancelled() {
                stopped = true;
                break;
            }
            if started.elapsed() >= timeout {
                timed_out = true;
                break;
            }
        }
        let mut code = 0u32;
        let exited =
            !timed_out && !stopped && GetExitCodeProcess(process_handle.0, &mut code).is_ok();
        // Whatever it left running goes too.
        let _ = TerminateJobObject(job.0, 1);
        drop(job);
        let output = reader.join().unwrap_or_default();
        Ok(Confined {
            exit_code: exited.then_some(code as i32),
            output,
            timed_out,
            stopped,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Vec<(OsString, OsString)> {
        std::env::vars_os().collect()
    }

    fn cmd() -> PathBuf {
        PathBuf::from(
            std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()),
        )
    }

    #[test]
    fn writes_go_only_inside_the_folder() {
        let folder = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let stop = tokio_util::sync::CancellationToken::new();
        let inside_file = folder.path().join("ok.txt");
        let outside_file = outside.path().join("nope.txt");
        // (Temp paths have no spaces; cmd reads quotes its own way.)
        let script = format!(
            "echo in> {} & echo out> {}",
            inside_file.display(),
            outside_file.display()
        );
        let ran = run(
            &cmd(),
            &["/c".to_string(), script],
            folder.path(),
            folder.path(),
            env(),
            Duration::from_secs(20),
            1 << 20,
            &stop,
        )
        .unwrap();
        assert!(!ran.timed_out);
        assert!(
            inside_file.exists(),
            "{}",
            String::from_utf8_lossy(&ran.output)
        );
        assert!(
            !outside_file.exists(),
            "a write outside the folder got through"
        );
        // The folder's access was taken back afterwards (other tests may be
        // using folders of their own meanwhile).
        let folder = PathBuf::from(
            folder
                .path()
                .to_string_lossy()
                .trim_start_matches(r"\\?\")
                .to_string(),
        );
        assert!(GRANTED
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|g| !g.contains_key(&folder)));
    }

    #[test]
    fn a_timeout_ends_the_whole_tree() {
        let folder = tempfile::tempdir().unwrap();
        let stop = tokio_util::sync::CancellationToken::new();
        let started = Instant::now();
        let ran = run(
            &cmd(),
            &["/c".to_string(), "ping -n 30 127.0.0.1 > nul".to_string()],
            folder.path(),
            folder.path(),
            env(),
            Duration::from_millis(800),
            1 << 20,
            &stop,
        )
        .unwrap();
        assert!(ran.timed_out);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn batch_files_refuse_arguments_cmd_would_run() {
        let line = command_line(Path::new(r"C:\x\npm.cmd"), &["test".to_string()]).unwrap();
        assert!(line.contains("/d /s /c"), "{line}");
        assert!(command_line(Path::new(r"C:\x\npm.cmd"), &["a&calc".to_string()]).is_err());
        assert!(command_line(Path::new(r"C:\x\git.exe"), &["a&b".to_string()]).is_ok());
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
    }
}
