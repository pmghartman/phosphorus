; Sulfur for Windows, per user: its one .exe in %LOCALAPPDATA%\Sulfur, an update
; landing in place
; makensis /DVERSION=1.2 /DSTAGE=dir /DOUTFILE=setup.exe installer.nsi
; /S silent: the app's own update, which starts the app again itself

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

; Sulfur's own processes by their full path, read through CIM
!macro StopApp
  nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -like '$INSTDIR\*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Sleep 800
!macroend

Name "${PRODUCT}"
OutFile "${OUTFILE}"
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
  ; the web view the window is, when the computer has none: Microsoft's own bootstrapper
  ReadRegStr $3 HKLM "${WEBVIEW2KEY}" "pv"
  ReadRegStr $4 HKCU "${WEBVIEW2KEY}" "pv"
  StrCmp $3 "" 0 done
  StrCmp $4 "" 0 done
    DetailPrint "Installing the WebView2 runtime"
    nsExec::Exec `powershell -NoProfile -NonInteractive -Command "$$f = Join-Path $$env:TEMP 'MicrosoftEdgeWebview2Setup.exe'; Invoke-WebRequest -UseBasicParsing 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $$f; Start-Process $$f -ArgumentList '/silent','/install' -Wait"`
  done:
SectionEnd

Section "Uninstall"
  !insertmacro StopApp
  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${INSTKEY}"
  RMDir /r "$INSTDIR"
SectionEnd
