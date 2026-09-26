; The desktop app used to be called Meshnet, and its install carries that name: the folder, the
; entry in Installed apps, the Start menu and desktop shortcuts. The first Ommesh install
; takes Meshnet's folder, so the program stays at the same path and a taskbar pin or an
; autostart keeps working, and then removes what still says Meshnet. The data lives under
; the identifier, which has not changed, so history and settings stay as they are.

!define OLD_NAME "Meshnet"
!define OLD_KEY "Software\${OLD_NAME}\${OLD_NAME}"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_NAME}"

!macro NSIS_HOOK_PREINSTALL
  ; Into Meshnet's folder: only on the first Ommesh install, and only when nobody picked another folder.
  ReadRegStr $R9 SHCTX "${MANUPRODUCTKEY}" ""
  ReadRegStr $R8 SHCTX "${OLD_KEY}" ""
  ${If} $R9 == ""
  ${AndIf} $R8 != ""
  ${AndIf} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
  ${AndIf} ${FileExists} "$R8\${MAINBINARYNAME}.exe"
    StrCpy $R7 $INSTDIR
    StrCpy $INSTDIR $R8
    SetOutPath $INSTDIR
    RMDir $R7
  ${EndIf}
!macroend

; Meshnet's shortcut in a folder becomes Ommesh's, unless the install already made one.
!macro OMMESH_RENAME_SHORTCUT dir
  !insertmacro IsShortcutTarget "${dir}\${OLD_NAME}.lnk" "$R8\${MAINBINARYNAME}.exe"
  Pop $R6
  ${If} $R6 = 1
    ${If} ${FileExists} "${dir}\${PRODUCTNAME}.lnk"
      !insertmacro UnpinShortcut "${dir}\${OLD_NAME}.lnk"
      Delete "${dir}\${OLD_NAME}.lnk"
    ${Else}
      Rename "${dir}\${OLD_NAME}.lnk" "${dir}\${PRODUCTNAME}.lnk"
      !insertmacro SetShortcutTarget "${dir}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R8 SHCTX "${OLD_KEY}" ""
  ${If} $R8 != ""
    !insertmacro OMMESH_RENAME_SHORTCUT "$SMPROGRAMS"
    !insertmacro OMMESH_RENAME_SHORTCUT "$DESKTOP"
    ; Meshnet in a folder of its own, when another one was picked for Ommesh.
    ${If} $R8 != $INSTDIR
      Delete "$R8\${MAINBINARYNAME}.exe"
      Delete "$R8\uninstall.exe"
      RMDir "$R8"
    ${EndIf}
    DeleteRegKey SHCTX "${OLD_UNINSTKEY}"
    DeleteRegKey SHCTX "${OLD_KEY}"
    DeleteRegKey /ifempty SHCTX "Software\${OLD_NAME}"
  ${EndIf}
!macroend

; The autostart entry keeps Meshnet's name (see `lib.rs`), so removing the app removes it by that name.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${OLD_NAME}"
  ${EndIf}
!macroend
