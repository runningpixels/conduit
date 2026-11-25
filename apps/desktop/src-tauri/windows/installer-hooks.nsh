; Conduit NSIS hooks (bundle.windows.nsis.installerHooks).
;
; Installed apps (src/app_install) are Start menu and desktop shortcuts that
; launch Conduit. When Conduit itself is uninstalled they would point at
; nothing, so remove them. The app keeps every shortcut path, one per line,
; in "$LOCALAPPDATA\${BUNDLEID}\app-shortcuts.txt" (UTF-16LE). This runs
; before the uninstaller may delete that folder ("delete app data"), and
; never during an update (the shortcuts stay valid).

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    SetShellVarContext current
    StrCpy $R8 "$LOCALAPPDATA\${BUNDLEID}\app-shortcuts.txt"
    ${If} ${FileExists} "$R8"
      ClearErrors
      FileOpen $R9 "$R8" r
      ${IfNot} ${Errors}
        FileReadWord $R9 $R7 ; byte-order mark
        conduit_app_shortcut_loop:
          ClearErrors
          FileReadUTF16LE $R9 $R7
          IfErrors conduit_app_shortcut_done
          ; Drop the trailing CR LF.
          StrCpy $R6 $R7 1 -1
          StrCmp $R6 "$\n" 0 +2
            StrCpy $R7 $R7 -1
          StrCpy $R6 $R7 1 -1
          StrCmp $R6 "$\r" 0 +2
            StrCpy $R7 $R7 -1
          ; Shortcuts only: never delete anything else this file might name.
          StrCpy $R6 $R7 4 -4
          StrCmp $R6 ".lnk" 0 conduit_app_shortcut_loop
            Delete "$R7"
          Goto conduit_app_shortcut_loop
        conduit_app_shortcut_done:
        FileClose $R9
      ${EndIf}
      Delete "$R8"
    ${EndIf}
    RMDir "$SMPROGRAMS\${PRODUCTNAME} Apps"
  ${EndIf}
!macroend
