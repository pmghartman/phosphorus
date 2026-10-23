# Sulfur Windows security investigation

## Observed on 2026-10-23

Windows Defender identified the installed `%LOCALAPPDATA%\Sulfur\Sulfur.exe` as
`Trojan:Script/Wacatac.C!ml`. Protection history also contained an earlier
`Trojan:Win32/Wacatac.H!ml` detection for that same path. The inspected file was
15,051,776 bytes, version 1.75.0.0, with no Authenticode signature.

SHA-256:

```text
0BE9546B0406717E9163CDB5D05CF063DC1775CFA2FA7E0DFFCDD1C1968E5292
```

Read-only Go build metadata identifies `cmd/sulfur`, Go 1.26.0, Windows/amd64,
revision `a98e44ee938b9e17246f72b2dcfc6a3914f2cbd6`, with `vcs.modified=true`.
That last field means the binary cannot be equated with an unmodified checkout
of that commit. No determination that the file is safe or incorrectly detected
has been made. The detection name alone does not identify the triggering code.

## Source changes

- The Python language adapter now travels as inspectable UTF-8 source with a
  length header, replacing a compressed, base64 executable payload. Stdin remains
  byte based, preserving Unicode and BOM handling on Windows.
- Windows updates launch the feed-verified installer directly. The existing NSIS
  installer owns the delay and optional restart, replacing a hidden `cmd` chain
  containing the downloaded path.
- Remote PowerShell commands no longer request `ExecutionPolicy Bypass`.
  UTF-16 encoding remains solely for reliable command argument transport over SSH.

- The local toolchain probe no longer starts a hidden, base64-encoded PowerShell from `Sulfur.exe`. It looks up each tool on PATH, runs its version flag directly and reads `vswhere` JSON in Go. A GUI program spawning such a script is the pattern behind `Trojan:Script/Wacatac` machine-learning verdicts; remote hosts still get the PowerShell probe over ssh, where this app starts nothing.
- The installer no longer runs PowerShell to stop the app (`taskkill` by name) or to download and run the WebView2 bootstrapper (a message and Microsoft's page instead, skipped in a silent update).
- The detached updater launch no longer sets `CREATE_NO_WINDOW`/`HideWindow`.

The Go desktop and installer architecture, update-feed signature verification,
language features and user-initiated update flow remain in place. These changes
make execution easier to inspect and reduce unnecessary process/packing work;
they do not prove why Defender detected the installed binary or guarantee a
different verdict.

## Release validation still required

No application build, installer execution, Defender exclusion, threat allowance,
quarantine restore or sample upload was performed during this investigation.

1. Build from a reviewed clean checkout using the existing Windows release
   pipeline. Record the source revision, executable and installer SHA-256 hashes.
2. Use a trusted publisher certificate to Authenticode-sign `Sulfur.exe` before
   packaging, and sign the final installer before generating its update-feed
   signature. Timestamp and verify the signatures. The repository's Ed25519
   update-feed signatures provide update authenticity; they do not supply a
   Windows publisher identity. No publisher certificate was available here.
3. Scan the resulting executable and installer with current Defender definitions.
   Treat any detection as unresolved until investigated; do not work around it
   by allowing the threat or excluding the installation directory.
4. Submit a detected sample as **Software developer** through
   [Microsoft Security Intelligence](https://www.microsoft.com/en-us/wdsi/filesubmission),
   with its hash, detection, source revision and build details. Submission shares
   the executable with Microsoft and should be performed by the publisher.
   Wait for the final determination, and retain the submission ID with the release.

Microsoft's [developer FAQ](https://learn.microsoft.com/en-us/defender-xdr/developer-faq)
explains the dispute process and consistent publisher signing. Authenticode
signing helps identify a publisher; it does not certify that a program is safe
or guarantee that antivirus software accepts it.
