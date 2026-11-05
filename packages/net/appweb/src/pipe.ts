// a byte stream to the host: an ssh channel or forwarded port, or a local one in tests

export interface Pipe {
  write(b: Uint8Array | string): void;
  onData(f: (b: Uint8Array) => void): void;
  onClose(f: () => void): void;
  close(): void;
}

// a command running on the host: its stdout as the pipe, its stderr apart
export interface Proc extends Pipe {
  onErr(f: (b: Uint8Array) => void): void;
}

// how the app's host is reached: commands run there, its loopback ports
export interface Host {
  os: "windows" | "linux";
  run(cmd: string): Promise<Proc>;
  connect(port: number): Promise<Pipe>;
}
