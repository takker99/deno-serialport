# @takker/serialport

Cross-platform Deno serial library (Windows / Linux x64 & arm64) with prebuilt
native binaries.

This provides a fast and stable serial port API for Deno. It uses Rust's
[`serialport-rs`](https://github.com/serialport/serialport-rs) (blocking I/O)
underneath and exposes a Deno-style Promise/ReadableStream API via Deno FFI. It
also supports AsyncDisposable for `await using` automatic cleanup.

- Features: port enumeration, open/close, read/write, flush, drain, RTS/DTR/BRK
  control, CTS/DSR/DCD/RI query, timeouts, disconnect detection, cancellation
  via close
- Targets (priority):
  - Windows: x64, arm64 (MSVC)
  - Linux: x64-gnu, arm64-gnu
  - macOS: x64, arm64 (later)

Note: Running examples requires --allow-ffi and --allow-read for cached
binaries. If downloading prebuilt binaries on first run, you also need
--allow-net.

## Usage

```ts
import { SerialPort } from "@takker/serialport";

const ports = await SerialPort.list();
console.log(ports);

const sp = await SerialPort.open({
  path: Deno.build.os === "windows" ? "\\\\.\\COM3" : "/dev/ttyUSB0",
  baudRate: 115200,
});

await sp.write(new TextEncoder().encode("hello\n"));

for await (const chunk of sp.readable) {
  console.log("RX", chunk);
  break; // demo
}

await sp.close();
```

### Automatic cleanup with await using (AsyncDisposable)

```ts
import { SerialPort } from "@takker/serialport";

// Requires a runtime with using/await using (Deno v1.45+)
await using sp = await SerialPort.open({
  path: "/dev/ttyUSB0",
  baudRate: 115200,
});

// When leaving this scope, close() is called automatically.
// Any pending read is interrupted by close.
await sp.write(new TextEncoder().encode("OK\n"));
```

Dispose behavior:

- The default prioritizes immediate cleanup.
  - Pending reads are interrupted by close (ReadableStream will close or error).
  - Pending writes may be interrupted. If you need guaranteed delivery, call
    `await sp.drain()` before `await sp.close()` or before exiting the
    `await using` scope.
- Why not drain automatically?
  - Depending on device state, draining can block for a long time. Disposing
    should reliably free resources promptly.
  - Call `drain()` explicitly when you need it.

## Permissions

Example:

```
deno run --allow-ffi --allow-read --allow-net examples/list.ts
```

- --allow-net is only needed if you download prebuilt binaries from GitHub
  Releases on first run.
- If you bundle binaries locally, --allow-net is not required.

## Build & Distribution

- Prebuild the following targets in CI and publish to GitHub Releases
  - win32-x64 (x86_64-pc-windows-msvc)
  - win32-arm64 (aarch64-pc-windows-msvc)
  - linux-x64-gnu (x86_64-unknown-linux-gnu)
  - linux-arm64-gnu (aarch64-unknown-linux-gnu)
  - darwin-x64 (x86_64-apple-darwin) [later]
  - darwin-arm64 (aarch64-apple-darwin) [later]
- On runtime: detect platform → download/verify/cache binary → dlopen

## License

MIT
