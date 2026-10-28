; Phosphorus.exe for Windows: a launcher the size of its icon, starting the tray in
; the host binary beside it with no console window. The host binary is a console
; program (phos and the service run in it), so the tray in it needs a window-less
; start, which ShellExecute's SW_HIDE gives a console program; its arguments
; (--background from the login item) passed along
; makensis /DVERSION=1.2 /DSTAGE=dir /DOUTFILE=Phosphorus.exe launcher.nsi
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SilentInstall silent
SetCompressor zlib
CRCCheck off

!include "FileFunc.nsh"

Name "Phosphorus"
OutFile "${OUTFILE}"
Icon "${STAGE}\icon.ico"
VIProductVersion "${VERSION}.0.0"
VIAddVersionKey "ProductName" "Phosphorus"
VIAddVersionKey "FileDescription" "Phosphorus"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Apache-2.0"

Section
  ${GetParameters} $0
  ExecShell "open" "$EXEDIR\phosphorus-host.exe" "tray $0" SW_HIDE
SectionEnd
