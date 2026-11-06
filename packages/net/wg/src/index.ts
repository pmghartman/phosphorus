// phosphorus's own WireGuard: the crypto, the handshake and a device that
// routes packets between a tunnel and its peers
export { Device, type DeviceOptions, type Endpoint, type PeerConfig } from "./device.ts";
export { contains, prefix, v4, v4Text } from "./ip.ts";
export { b64, keyPair, publicOf, unb64 } from "./x25519.ts";
