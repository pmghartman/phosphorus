; Sulfur for Windows, per user: its one .exe in %LOCALAPPDATA%\Sulfur, an update
; landing in place
; makensis /DVERSION=1.2 /DSTAGE=dir /DOUTFILE=setup.exe installer.nsi
; /S silent; /RESTART additionally waits for the app to close and reopens it

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define PRODUCT "Sulfur"
; the keys an install is known by, so an update is the same install
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
!define INSTKEY "Software\Phosphorus\${PRODUCT}"
!define WEBVIEW2KEY "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

; Sulfur's own processes by name, no script: a setup running PowerShell is read as a dropper
!macro StopApp
  nsExec::Exec `taskkill /F /T /IM Sulfur.exe`
  Sleep 800
!macroend

Name "${PRODUCT}"
OutFile "${OUTFILE}"
; the uninstaller code-signed as it's written, as the setup is after it (packaging/winsign.sh)
!ifdef SIGN
  !uninstfinalize '${SIGN} "%1"' = 0
!endif
InstallDir "$LOCALAPPDATA\${PRODUCT}"
InstallDirRegKey HKCU "${INSTKEY}" ""
BrandingText "${PRODUCT} ${VERSION}"
VIProductVersion "${VERSION}.0.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT}, a code editor"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Apache-2.0"

!define MUI_ICON "${STAGE}\icon.ico"
!define MUI_UNICON "${STAGE}\icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Sulfur.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Sulfur"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/RESTART" $1
  IfErrors +2 0
    Sleep 3000
FunctionEnd

Function .onInstSuccess
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/RESTART" $1
  IfErrors +2 0
    Exec '"$INSTDIR\Sulfur.exe"'
FunctionEnd

Section "Install"
  !insertmacro StopApp
  SetOutPath "$INSTDIR"
  ; an app still running moved aside, never left in place of the new one
  Delete "$INSTDIR\Sulfur.old.exe"
  IfFileExists "$INSTDIR\Sulfur.old.exe" +2 0
    Rename "$INSTDIR\Sulfur.exe" "$INSTDIR\Sulfur.old.exe"
  Delete /REBOOTOK "$INSTDIR\Sulfur.old.exe"
  File "${STAGE}\Sulfur.exe"
  File "${STAGE}\icon.ico"
  File "${STAGE}\LICENSE"
  File "${STAGE}\THIRD_PARTY_LICENSES.txt"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\Sulfur.exe" "" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${INSTKEY}" "" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "Phosphorus"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" $0
  ; the web view the window is, when the computer has none: Microsoft's own page, nothing downloaded and run from here
  ReadRegStr $3 HKLM "${WEBVIEW2KEY}" "pv"
  ReadRegStr $4 HKCU "${WEBVIEW2KEY}" "pv"
  StrCmp $3 "" 0 done
  StrCmp $4 "" 0 done
    IfSilent done
    MessageBox MB_OK|MB_ICONINFORMATION "Sulfur needs Microsoft's WebView2 runtime, which this computer doesn't have. Setup will open Microsoft's download page; install it, then start Sulfur."
    ExecShell "open" "https://developer.microsoft.com/microsoft-edge/webview2/"
  done:
SectionEnd

Section "Uninstall"
  !insertmacro StopApp
  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${INSTKEY}"
  RMDir /r "$INSTDIR"
SectionEnd
