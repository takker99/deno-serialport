# Implementation Plan (Detailed, with AsyncDisposable)

## Goals

- Provide a Deno-first serial port API comparable to Node's serialport,
  implemented with blocking serialport-rs via Deno FFI
- Prioritize Windows and Linux (x64/arm64). Add macOS later
- Support AsyncDisposable (`await using`) for automatic resource cleanup

## API design (TypeScript, Deno-style)

- SerialPort.open(options): Promise<SerialPort>
- SerialPort.list(): Promise<PortInfo[]>
- sp.readable: ReadableStream<Uint8Array>
- sp.write(data: Uint8Array): Promise<void>
- sp.flush({ in?: boolean, out?: boolean }): Promise<void>
- sp.drain(): Promise<void> // Wait until pending TX completes (best-effort by
  default)
- sp.set({ rts?, dtr?, brk? }): Promise<void>
- sp.get(): Promise<{ cts: boolean, dsr: boolean, dcd: boolean, ri: boolean }>
- sp.close(): Promise<void>
- sp[Symbol.asyncDispose](): Promise<void> // automatic close when using
  `await using`

Dispose/Close policy:

- Default: immediate release
  - Behavior: interrupt ongoing reads (unblock by closing), free handle
  - Do not call drain automatically (must be explicit)
- Rationale: avoid indefinite waits/hangs; prioritize leak prevention
- Patterns:
  - To guarantee TX completion: `await sp.drain(); await sp.close();`
  - Automatic dispose: `await using sp = await SerialPort.open(...);` //
    equivalent to immediate close on scope exit

## Architecture

- Rust (cdylib):
  - Deps: serialport = "^4", once_cell, slab, serde, serde_json, thiserror
    (optional)
  - C ABI functions (0 = OK; non-zero indicates error; details via
    serial_err_*):
    - Error: `serial_err_len`, `serial_err_fill`
    - Management: `serial_open`, `serial_last_handle`, `serial_close`
    - I/O: `serial_read` (nonblocking), `serial_write` (nonblocking)
    - Control: `serial_set_lines(rts,dtr,brk)`, `serial_get_lines(out_bitmask)`
    - Buffers: `serial_flush(in, out)`, `serial_drain()` (best-effort: wait
      until bytes_to_write == 0)
    - Enumeration: `serial_list_ports_len`, `serial_list_ports_fill`,
      `serial_free_cstr`
    - Future: `serial_wait_event` (nonblocking; modem line/error change
      notifications)
  - Memory: Do not transfer buffer ownership from JS to native. Free
    native-created C-strings via `serial_free_cstr`

- TypeScript (JSR package):
  - `src/loader.ts`: Detect OS/Arch, resolve binary, download, cache, dlopen
  - `src/ffi.ts`: FFI symbol definitions, low-level helpers, fetch error strings
  - `mod.ts`: Public API (Promise/ReadableStream/AsyncDisposable), SerialPort
    class, list()

## Cancellation/close

- This version adopts interruption via close
  - `serial_read` returns error/0 when the port is closed → the JS
    ReadableStream finishes (close/error)
  - Explicit `serial_cancel_io` is not required (can add e.g. Windows CancelIoEx
    later if needed)
- If you need to guarantee TX completion, call `drain()` explicitly

## Disconnect detection

- 0 bytes / error on read → close the ReadableStream
- Windows: device removal error codes are treated as EOF-like
- Unix: HUP/EIO/0, etc.

## Testing

- Unit: Loopback (socat/tty0tty, com0com) covering
  read/write/flush/drain/set/get/timeout
- CI: Build validation + minimal unit tests (no dependency on real ports)
- Devices: CDC-ACM/FTDI/CP210x/CH34x on real hardware

## Schedule (rough)

- Week 1: open/read/write/close/list (Linux/Windows)
- Week 2: set/get/flush/drain, ReadableStream
- Week 3: AsyncDisposable (`await using`) sample, improved disconnect detection,
  docs
- Week 4: CI/prebuilt/release, macOS (optional)

## Binary distribution

- Publish per-target directories in GitHub Releases (include SHA256)
- On first run: download → local cache → dlopen thereafter
- Publish TS to JSR only; native binaries go to Releases
