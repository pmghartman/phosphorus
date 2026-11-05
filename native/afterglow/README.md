# afterglow

Phosphorus's streaming host for Windows: a fork of
[Apollo](https://github.com/ClassicOldSong/Apollo) (itself a fork of LizardByte's
[Sunshine](https://github.com/LizardByte/Sunshine)), forked at Apollo
`adc5c5a0bd80831ce495434bb16aee2cd4175fb8`, built into every Windows release and
set up on each host by `phos setup` and every rebuild.

Apollo's capture (DXGI desktop duplication, Windows.Graphics.Capture), its encoders
(NVENC, AMF, Quick Sync, x264), its input and its SudoVDA virtual display are kept as
they are. What sat between them and phosphorus is gone: phosphorus drives afterglow over
one loopback link (`src/phos_link.cpp`, framing in `src/phos_wire.h`) instead of
GameStream.

| | Apollo through glow (GameStream) | afterglow |
| --- | --- | --- |
| set up | a separate install, our certificate added to its state, apps.json edited, a restart, or a PIN | installed with phosphorus, nothing to pair |
| to the first frame | serverinfo, launch over HTTPS, RTSP OPTIONS/DESCRIBE/SETUP/ANNOUNCE/PLAY, ENet connect | one launch message, one video message |
| each frame | RTP packetized, FEC computed, sent as datagrams, rebuilt from them | the encoder's frame reshaped once to AVCC, one socket write, copied once on arrival |
| control and input | ENet, AES-GCM sealed | plain messages on the same loopback socket, token-checked |
| audio | captured and encoded with Opus for nobody | not captured |
| beside it | web UI, nvhttp, mDNS, UPnP, tray | nothing listening but the link |

## The link

`afterglow.exe <afterglow.conf>`, with `phos_link_port` and `phos_link_token` set,
serves the link on `127.0.0.1:<port>` and none of GameStream's servers. A message is a
`u32` little-endian length, a type byte, the body. phosphorus says the token first
(`hello`), then `launch` (the app's path, size, rate, virtual display), `video` (size,
rate, bitrate, 4:4:4), `idr`, `input` (GameStream input packets, passed to Apollo's
`input::passthrough` as they are), `stop_video` and `quit`. afterglow answers `ready`,
`launched`, `exited` and `video_ended`, and sends `config` (an avcC record) and `frame`
(AVCC) messages with 8 bytes of room in front, which phosphorus overwrites with its
viewer's header and sends on. Each video carries a generation so frames of a video
already replaced are dropped.

The phosphorus side is `packages/net/appstream/src/afterglow/`; the host setup is
`packages/host/host/src/win/afterglow.ts`.

## On a host

The release carries `afterglow/` in the phosphorus home: `afterglow.exe`,
`tools/afterglowsvc.exe` (Apollo's service wrapper, which keeps afterglow running in the
console's session as SYSTEM), the shaders, and the SudoVDA driver package. Phosphorus
writes `state/data/afterglow/` (config, link token: SYSTEM and administrators only),
installs the SudoVDA driver unless the host has one, and runs the
`PhosphorusAfterglow` service. Apps launch in the session signed in at the console;
each gets a virtual display at the viewer's window size, made the primary display while
it streams.

## Building

Windows only, in MSYS2 UCRT64: `.github/workflows/afterglow.yml` lists the packages and
runs `scripts/build.sh OUT_DIR`. The submodules under `third-party/` are Apollo's
pins. SudoVDA's signed driver DLL and `nefconc.exe` aren't in Apollo's tree; the
workflow takes the driver package from Apollo's release installer and checks it against
its signed catalog. `test/wire_test.cpp` builds anywhere:
`c++ -std=c++20 -Isrc test/wire_test.cpp && ./a.out`.

## Licence

GPL-3.0-only, as Apollo and Sunshine (`LICENSE`, `NOTICE`). The rest of phosphorus is
Apache-2.0; afterglow is a separate program it starts and talks to over a socket, and
each release names this directory as its source.
