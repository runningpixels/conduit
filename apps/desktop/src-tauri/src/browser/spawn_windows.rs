// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Starting the browser on Windows with the DevTools pipe on its fds 3 and 4.
//!
//! `--remote-debugging-pipe` makes Chromium read CDP from fd 3 and write it to
//! fd 4. On Windows those are C runtime descriptors, which a child takes from
//! the CRT's inherited-handle block in `STARTUPINFOW.lpReserved2`. Rust's
//! `Command` can't set that block, so the browser is started here with
//! `CreateProcessW` and a block built by hand, the way libuv does it for Node
//! (and so for Puppeteer and Playwright).
//!
//! Only the two pipe ends are inherited (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`).
//! The browser starts suspended, goes into a job object that kills it (and
//! everything it started) when the job's last handle closes, and only then
//! runs. All the unsafe of the browser module is in this file.

use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    STARTUPINFOEXW, STARTUPINFOW,
};

/// The CRT's flags for an inherited descriptor: open, and a pipe.
const FOPEN: u8 = 0x01;
const FPIPE: u8 = 0x08;

/// The CRT inherited-handle block (`lpReserved2`) for descriptors
/// `0..handles.len()`: a little-endian u32 count, one flag byte per
/// descriptor, then one pointer-sized handle per descriptor, unaligned. A
/// descriptor that is `None` is not open (flag 0, `INVALID_HANDLE_VALUE`).
pub fn crt_handle_block(handles: &[Option<usize>]) -> Vec<u8> {
    let width = std::mem::size_of::<usize>();
    let mut block = Vec::with_capacity(4 + handles.len() * (1 + width));
    block.extend_from_slice(&(handles.len() as u32).to_le_bytes());
    for handle in handles {
        block.push(if handle.is_some() { FOPEN | FPIPE } else { 0 });
    }
    for handle in handles {
        // INVALID_HANDLE_VALUE is -1.
        block.extend_from_slice(&handle.unwrap_or(usize::MAX).to_le_bytes());
    }
    block
}

/// The started browser: its process and job, and our ends of its pipe.
pub struct Spawned {
    pub process: Process,
    /// What we write goes to the browser's fd 3.
    pub to_browser: File,
    /// What the browser writes to its fd 4.
    pub from_browser: File,
}

/// The browser process, by handle. Dropping it closes the job, which ends the
/// browser and everything it started.
pub struct Process {
    handle: OwnedHandle,
    /// `None` when the process could not be put in a job (it is then ended by
    /// its handle alone).
    job: Option<OwnedHandle>,
    pid: u32,
}

impl Process {
    pub fn id(&self) -> u32 {
        self.pid
    }

    /// The exit code once it has exited.
    pub fn exit_code(&self) -> Option<u32> {
        let handle = HANDLE(self.handle.as_raw_handle());
        // SAFETY: `handle` is our open process handle for as long as `self`
        // lives; a zero timeout only polls.
        unsafe {
            if WaitForSingleObject(handle, 0) != WAIT_OBJECT_0 {
                return None;
            }
            let mut code = 0u32;
            GetExitCodeProcess(handle, &mut code).ok()?;
            Some(code)
        }
    }

    /// End it now, with everything it started.
    pub fn kill(&self) {
        // SAFETY: both handles are open for as long as `self` lives; ending
        // a process that already exited is a harmless error.
        unsafe {
            match &self.job {
                Some(job) => {
                    let _ = TerminateJobObject(HANDLE(job.as_raw_handle()), 1);
                }
                None => {
                    let _ = TerminateProcess(HANDLE(self.handle.as_raw_handle()), 1);
                }
            }
        }
    }

    /// Wait up to `timeout` for it to exit (blocking).
    #[cfg(test)]
    pub fn wait_blocking(&self, timeout: std::time::Duration) -> bool {
        let ms = timeout.as_millis().min(u32::MAX as u128 - 1) as u32;
        // SAFETY: an open process handle; the wait is bounded by `ms`.
        unsafe { WaitForSingleObject(HANDLE(self.handle.as_raw_handle()), ms) == WAIT_OBJECT_0 }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // Closing the job's only handle kills it (KILL_ON_JOB_CLOSE); without
        // a job, end the process ourselves.
        if self.job.is_none() {
            self.kill();
        }
    }
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}

/// A pipe as two owned handles, neither inheritable yet: (read, write).
fn pipe() -> std::io::Result<(OwnedHandle, OwnedHandle)> {
    let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
    // SAFETY: CreatePipe writes two fresh handles we then own; no security
    // attributes, so neither is inheritable.
    unsafe {
        CreatePipe(&mut read, &mut write, None, 0).map_err(std::io::Error::other)?;
        Ok((
            OwnedHandle::from_raw_handle(read.0),
            OwnedHandle::from_raw_handle(write.0),
        ))
    }
}

/// Start `exe args` with the DevTools pipe on fds 3 and 4.
pub fn spawn(exe: &Path, args: &[String]) -> std::io::Result<Spawned> {
    // Pipe A: we write, the browser reads (fd 3). Pipe B: the browser writes
    // (fd 4), we read.
    let (child_in, our_out) = pipe()?;
    let (our_in, child_out) = pipe()?;

    let mut line = crate::workflows::confine::quote(&exe.to_string_lossy());
    for arg in args {
        line.push(' ');
        line.push_str(&crate::workflows::confine::quote(arg));
    }
    let mut line = wide(OsStr::new(&line));
    let application = wide(exe.as_os_str());

    let child_handles = [
        HANDLE(child_in.as_raw_handle()),
        HANDLE(child_out.as_raw_handle()),
    ];
    let mut block = crt_handle_block(&[
        None,
        None,
        None,
        Some(child_handles[0].0 as usize),
        Some(child_handles[1].0 as usize),
    ]);

    // SAFETY: every pointer handed to the calls below (the attribute list
    // buffer, the handle array, the CRT block, the command line and program
    // name) lives on this stack frame until CreateProcessW has returned, and
    // the attribute list is deleted before its buffer is dropped. Handles
    // come from `pipe()` and are owned; the child's two ends are made
    // inheritable only here and closed in this process right after the
    // spawn (by dropping `child_in`/`child_out`).
    unsafe {
        for handle in child_handles {
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)
                .map_err(std::io::Error::other)?;
        }

        // One attribute: the list of handles the child may inherit.
        let mut size = 0usize;
        // The first call only reports the size (and fails by design).
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut size);
        let mut buffer = vec![0u8; size];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr() as *mut c_void);
        InitializeProcThreadAttributeList(Some(list), 1, None, &mut size)
            .map_err(std::io::Error::other)?;
        struct DeleteList(LPPROC_THREAD_ATTRIBUTE_LIST);
        impl Drop for DeleteList {
            fn drop(&mut self) {
                // SAFETY: initialised above, and its buffer outlives this guard.
                unsafe { DeleteProcThreadAttributeList(self.0) }
            }
        }
        let _delete = DeleteList(list);
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            Some(child_handles.as_ptr() as *const c_void),
            std::mem::size_of_val(&child_handles),
            None,
            None,
        )
        .map_err(std::io::Error::other)?;

        let startup = STARTUPINFOEXW {
            StartupInfo: STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                cbReserved2: block.len() as u16,
                lpReserved2: block.as_mut_ptr(),
                ..Default::default()
            },
            lpAttributeList: list,
        };
        let mut info = PROCESS_INFORMATION::default();
        // No CREATE_NO_WINDOW: the browser's window must show. It is a GUI
        // program, so no console is made for it either.
        CreateProcessW(
            PCWSTR(application.as_ptr()),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            true,
            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
            None,
            PCWSTR::null(),
            &startup.StartupInfo,
            &mut info,
        )
        .map_err(std::io::Error::other)?;
        let process = OwnedHandle::from_raw_handle(info.hProcess.0);
        let thread = OwnedHandle::from_raw_handle(info.hThread.0);

        let job = into_job(HANDLE(process.as_raw_handle()));
        if job.is_none() {
            tracing::warn!("the browser could not be put in a job; it is ended by its handle");
        }
        ResumeThread(HANDLE(thread.as_raw_handle()));
        drop(thread);
        // The child has its own copies now; ours must go, or reading would
        // never see the browser's end of the pipe close.
        drop(child_in);
        drop(child_out);

        Ok(Spawned {
            process: Process {
                handle: process,
                job,
                pid: info.dwProcessId,
            },
            to_browser: File::from(our_out),
            from_browser: File::from(our_in),
        })
    }
}

/// A job that kills `process` and its children when its handle closes, with
/// `process` in it.
///
/// SAFETY: `process` must be an open process handle.
unsafe fn into_job(process: HANDLE) -> Option<OwnedHandle> {
    // SAFETY: the job handle is owned from creation; the limits struct is a
    // plain value passed by pointer with its exact size.
    unsafe {
        let job = OwnedHandle::from_raw_handle(CreateJobObjectW(None, PCWSTR::null()).ok()?.0);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            HANDLE(job.as_raw_handle()),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            std::mem::size_of_val(&limits) as u32,
        )
        .ok()?;
        AssignProcessToJobObject(HANDLE(job.as_raw_handle()), process).ok()?;
        Some(job)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_block_layout() {
        let block = crt_handle_block(&[None, None, None, Some(0x1234), Some(0xABCD)]);
        let width = std::mem::size_of::<usize>();
        assert_eq!(block.len(), 4 + 5 + 5 * width);
        assert_eq!(&block[..4], &5u32.to_le_bytes());
        assert_eq!(&block[4..9], &[0, 0, 0, 0x09, 0x09]);
        let handle = |i: usize| {
            let at = 9 + i * width;
            let mut bytes = [0u8; 8];
            bytes[..width].copy_from_slice(&block[at..at + width]);
            u64::from_le_bytes(bytes)
        };
        let invalid = usize::MAX as u64;
        assert_eq!(
            (handle(0), handle(1), handle(2)),
            (invalid, invalid, invalid)
        );
        assert_eq!(handle(3), 0x1234);
        assert_eq!(handle(4), 0xABCD);
    }

    #[test]
    fn an_empty_block_is_just_the_count() {
        assert_eq!(crt_handle_block(&[]), 0u32.to_le_bytes().to_vec());
    }

    /// The pipe and the handle block really reach a child: `cmd` is given fd
    /// 3 as its input and writes back what it read.
    #[test]
    fn a_child_gets_the_pipe() {
        use std::io::{Read, Write};
        let cmd =
            std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
        // `set /p` reads one line from fd 3 (redirected to stdin); `>&4` writes to fd 4.
        let spawned = spawn(
            Path::new(&cmd),
            &[
                "/d".into(),
                "/c".into(),
                "set /p LINE=<&3 & call echo got %LINE%>&4".into(),
            ],
        )
        .unwrap();
        let Spawned {
            process,
            mut to_browser,
            mut from_browser,
        } = spawned;
        to_browser.write_all(b"hello\r\n").unwrap();
        drop(to_browser);
        let mut out = String::new();
        from_browser.read_to_string(&mut out).unwrap();
        assert!(out.contains("got hello"), "{out:?}");
        assert!(process.wait_blocking(std::time::Duration::from_secs(5)));
        assert_eq!(process.exit_code(), Some(0));
    }
}
