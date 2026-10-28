; Phosphorus for Windows, per user: the tray, the host binary and the release in
; %LOCALAPPDATA%\Phosphorus, an update landing in place
; makensis /DVERSION=1.2 /DSTAGE=dir /DOUTFILE=setup.exe installer.nsi
; /S silent, the tray started after on the desktop at its login item's quiet;
; /S /AGENT /D=<dir> the phosphorus service's update with no one signed in: no
; tray started, nothing written to the service account's own registry or menu

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
; zlib: solid lzma took two and a half minutes over the two bun binaries for a
; third off the setup's size; zlib takes seconds
SetCompressor zlib

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define PRODUCT "Phosphorus"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"

; the tray alone, by its full path: Windows names are case-blind, and phosphorus
; itself runs as phosphorus.exe from the home, never to be stopped by this; the path
; read through CIM, which a setup run from another session (ssh) can still see
!macro StopTray
  nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \"Name='Phosphorus.exe'\" | Where-Object { $$_.ExecutablePath -eq '$INSTDIR\Phosphorus.exe' -or $$_.CommandLine -like '*$INSTDIR\Phosphorus.exe*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Sleep 800
!macroend

Name "${PRODUCT}"
OutFile "${OUTFILE}"
; the uninstaller code-signed as it's written, as the setup is after it (packaging/winsign.sh)
!ifdef SIGN
  !uninstfinalize '${SIGN} "%1"' = 0
!endif
InstallDir "$LOCALAPPDATA\${PRODUCT}"
BrandingText "${PRODUCT} ${VERSION}"
VIProductVersion "${VERSION}.0.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} host"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Apache-2.0"

!define MUI_ICON "${STAGE}\icon.ico"
!define MUI_UNICON "${STAGE}\icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Phosphorus.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Phosphorus"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var AGENT

Function .onInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/AGENT" $1
  IfErrors +2 0
    StrCpy $AGENT 1
FunctionEnd

Section "Install"
  ; a running tray let go of its files; phosphorus itself runs from the home, untouched
  !insertmacro StopTray
  SetOutPath "$INSTDIR"
  ; the old release's files gone, never mixed with this one's
  RMDir /r "$INSTDIR\release"
  ; a tray still running moved aside, never left in place of the new one
  Delete "$INSTDIR\Phosphorus.old.exe"
  IfFileExists "$INSTDIR\Phosphorus.old.exe" +2 0
    Rename "$INSTDIR\Phosphorus.exe" "$INSTDIR\Phosphorus.old.exe"
  Delete /REBOOTOK "$INSTDIR\Phosphorus.old.exe"
  File "${STAGE}\Phosphorus.exe"
  File "${STAGE}\phosphorus-host.exe"
  File "${STAGE}\icon.ico"
  File "${STAGE}\LICENSE"
  File "${STAGE}\THIRD_PARTY_NOTICES.txt"
  File /r "${STAGE}\release"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  ; the service's update: the user's own registry and menu theirs, kept from the last install
  StrCmp $AGENT 1 done
  CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\Phosphorus.exe" "" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" $0
  ; an update: the new tray back in the old one's place, quietly, on the user's
  ; desktop through a task, never a child of this (a waiting caller hangs on one,
  ; and over ssh it would die with the session)
  IfSilent 0 +2
    nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Register-ScheduledTask PhosphorusTray -Action (New-ScheduledTaskAction -Execute '$INSTDIR\Phosphorus.exe' -Argument '--background') -Force | Out-Null; Start-ScheduledTask PhosphorusTray; Start-Sleep 1; Unregister-ScheduledTask PhosphorusTray -Confirm:$$false"`
  done:
SectionEnd

Section "Uninstall"
  !insertmacro StopTray
  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  DeleteRegValue HKCU "${RUNKEY}" "${PRODUCT}"
  DeleteRegKey HKCU "${UNINSTKEY}"
  RMDir /r "$INSTDIR"
SectionEnd
