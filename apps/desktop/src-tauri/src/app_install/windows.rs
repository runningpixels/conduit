//! Windows: `.lnk` shortcuts in Start menu › "<brand> Apps" and on the
//! desktop, each carrying the app's taskbar id (AppUserModelID) so the
//! running window, the Start entry and a pinned taskbar button are the same
//! app — not one more Conduit window (see `app_windows::taskbar`).

use std::path::{Path, PathBuf};

use windows::{
    core::{Interface, HSTRING, PCWSTR},
    Win32::{
        Storage::EnhancedStorage::PKEY_AppUserModel_ID,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            FOLDERID_Programs, IShellLinkW, PropertiesSystem::IPropertyStore, SHChangeNotify,
            SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT, SHCNE_UPDATEDIR, SHCNF_PATHW,
        },
    },
};

use super::{free_path, EntrySpec};
use crate::app_windows::taskbar;

/// The Start menu's `Programs` folder for this user.
pub fn programs_folder() -> Option<PathBuf> {
    unsafe {
        let raw = SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_DEFAULT, None).ok()?;
        let path = raw.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(raw.0 as *const _));
        path
    }
}

/// COM on this thread for the duration of `f` (an apartment of its own, so
/// it doesn't matter what the caller's thread was set up as).
fn with_com<T: Send>(
    f: impl FnOnce() -> windows::core::Result<T> + Send,
) -> windows::core::Result<T> {
    std::thread::scope(|scope| {
        scope
            .spawn(|| unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
                let result = f();
                CoUninitialize();
                result
            })
            .join()
            .unwrap_or_else(|_| {
                Err(windows::core::Error::from_hresult(
                    windows::Win32::Foundation::E_FAIL,
                ))
            })
    })
}

/// Write `<dir>/<name>.lnk` launching `<exe> --open-app <id>`.
pub(super) fn write_shortcut(dir: &Path, spec: &EntrySpec) -> Result<PathBuf, String> {
    let path = free_path(dir, &spec.file_name, ".lnk", &[]);
    let exe = spec.installer.exe.clone();
    let args = format!("{} {}", crate::app_windows::OPEN_APP_ARG, spec.app_id);
    let icon = spec.icon_dir.join(super::ICON_ICO);
    let aumid = taskbar::app_user_model_id(&spec.installer.identifier, spec.app_id);
    let description = format!("{} — {}", spec.name, spec.installer.brand);
    let target = path.clone();
    with_com(move || unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(exe.as_os_str()))?;
        link.SetArguments(&HSTRING::from(args.as_str()))?;
        if let Some(dir) = exe.parent() {
            link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
        }
        link.SetIconLocation(&HSTRING::from(icon.as_os_str()), 0)?;
        link.SetDescription(&HSTRING::from(description.as_str()))?;
        let store: IPropertyStore = link.cast()?;
        let value = taskbar::string_propvariant(&aumid)?;
        let set = store.SetValue(&PKEY_AppUserModel_ID, &value.0);
        set?;
        store.Commit()?;
        let file: IPersistFile = link.cast()?;
        file.Save(&HSTRING::from(target.as_os_str()), true)?;
        Ok(())
    })
    .map_err(|e| format!("could not create the shortcut {}: {e}", path.display()))?;
    Ok(path)
}

/// Tell Explorer the folder changed, so Start shows the entry straight away.
pub(super) fn notify_changed(dir: &Path) {
    let wide = HSTRING::from(dir.as_os_str());
    unsafe {
        SHChangeNotify(
            SHCNE_UPDATEDIR,
            SHCNF_PATHW,
            Some(PCWSTR(wide.as_ptr()).0 as *const _),
            None,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_install::{icons::tests::image, Installer, Roots};
    use windows::Win32::System::Com::{StructuredStorage::PropVariantClear, STGM_READ};

    /// Read a shortcut back: its arguments and taskbar id.
    fn read_shortcut(path: &Path) -> (String, String) {
        let path = path.to_path_buf();
        with_com(move || unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let file: IPersistFile = link.cast()?;
            file.Load(&HSTRING::from(path.as_os_str()), STGM_READ)?;
            let mut args = [0u16; 512];
            link.GetArguments(&mut args)?;
            let args =
                String::from_utf16_lossy(&args[..args.iter().position(|c| *c == 0).unwrap_or(0)]);
            let store: IPropertyStore = link.cast()?;
            let mut value = store.GetValue(&PKEY_AppUserModel_ID)?;
            let aumid = value
                .Anonymous
                .Anonymous
                .Anonymous
                .pwszVal
                .to_string()
                .unwrap_or_default();
            let _ = PropVariantClear(&mut value);
            Ok((args, aumid))
        })
        .unwrap()
    }

    #[test]
    fn shortcut_carries_the_launch_args_and_taskbar_id() {
        let root = tempfile::tempdir().unwrap();
        let inst = Installer {
            data_dir: root.path().join("installed-apps"),
            roots: Roots {
                menu: root.path().join("Programs"),
                desktop: None,
            },
            brand: "Acme".into(),
            identifier: "io.github.runningpixels.conduit".into(),
            exe: std::env::current_exe().unwrap(),
            index_file: None,
        };
        let id = "0b7c6a8e-1d2f-4a3b-9c4d-5e6f7a8b9c0d";
        let record = inst
            .install(id, "Focus timer", &[image(16), image(256)], false)
            .unwrap();
        let lnk = &record.entries[0];
        assert_eq!(
            lnk,
            &root
                .path()
                .join("Programs")
                .join("Acme Apps")
                .join("Focus timer.lnk")
        );
        let (args, aumid) = read_shortcut(lnk);
        assert_eq!(args, format!("--open-app {id}"));
        assert_eq!(
            aumid,
            taskbar::app_user_model_id("io.github.runningpixels.conduit", id)
        );
    }
}
