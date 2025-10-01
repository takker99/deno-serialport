// Public API for JSR
import { ensureLibrary } from "./loader.ts";
import { getLastError, type Handle, load, requireLib } from "./ffi.ts";

export type OpenOptions = {
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  parity?: "none" | "odd" | "even";
  stopBits?: 1 | 2;
  rtscts?: boolean;
  xon?: boolean;
  xoff?: boolean;
  xany?: boolean;
  readTimeoutMs?: number; // -1: infinite (internally large timeout)
};

let libLoaded = false;
async function init(): Promise<void> {
  if (libLoaded) return;
  const path = await ensureLibrary(".deno_serial", "v0.1.0"); // TODO: version sync
  load(path);
  libLoaded = true;
}

export type PortInfo = {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  bluetoothAddress?: string;
};

export class SerialPort implements AsyncDisposable {
  #h: Handle;
  #closed = false;

  private constructor(h: Handle) {
    this.#h = h;
  }

  static async list(): Promise<PortInfo[]> {
    await init();
    const lib = requireLib();
    const cap = lib.symbols.serial_list_ports_len(); // bigint
    if (cap === 0n) return [];
    const ptrs = new BigUint64Array(Number(cap));
    const np = lib.symbols.serial_list_ports_fill(
      Deno.UnsafePointer.of(ptrs),
      cap,
    );
    const out: PortInfo[] = [];
    for (let i = 0; i < Number(np); i++) {
      const p = ptrs[i];
      if (!p) continue;
      const ptr = Deno.UnsafePointer.create(p);
      if (!ptr) continue;
      const view = new Deno.UnsafePointerView(ptr);
      const cstr = view.getCString();
      try {
        out.push(JSON.parse(cstr));
      } catch {
        // ignore
      } finally {
        lib.symbols.serial_free_cstr(ptr);
      }
    }
    return out;
  }

  static async open(opts: OpenOptions): Promise<SerialPort> {
    await init();
    const lib = requireLib();
    const enc = new TextEncoder();
    const cpath = enc.encode(opts.path + "\0");
    const parity = { none: 0, odd: 1, even: 2 }[opts.parity ?? "none"];
    const rc = lib.symbols.serial_open(
      Deno.UnsafePointer.of(cpath),
      opts.baudRate >>> 0,
      opts.dataBits ?? 8,
      parity,
      opts.stopBits ?? 1,
      opts.rtscts ? 1 : 0,
      opts.xon ? 1 : 0,
      opts.xoff ? 1 : 0,
      opts.xany ? 1 : 0,
      opts.readTimeoutMs ?? -1,
    );
    if (rc !== 0) throw new Error(getLastError() || `open failed: ${rc}`);
    const h = lib.symbols.serial_last_handle(); // bigint
    return new SerialPort(h as unknown as bigint);
  }

  get readable(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      type: "bytes",
      pull: async (controller) => {
        if (this.#closed) {
          controller.close();
          return;
        }
        const buf = new Uint8Array(8192);
        const nBig = await requireLib().symbols.serial_read(
          this.#h as unknown as bigint,
          buf as unknown as BufferSource,
          BigInt(buf.length),
          -1,
        );
        if (nBig < 0n) {
          // If closing in progress, treat as stream close
          if (this.#closed) {
            controller.close();
            return;
          }
          controller.error(
            new Error(getLastError() || `read failed: ${nBig.toString()}`),
          );
          return;
        }
        if (nBig === 0n) {
          // Timeout (0) or EOF: close stream
          controller.close();
          return;
        }
        controller.enqueue(buf.subarray(0, Number(nBig)));
      },
      cancel: async () => {
        // Delegate explicit cancel to close()
        if (!this.#closed) {
          await this.close();
        }
      },
    });
  }

  async write(data: Uint8Array): Promise<void> {
    let off = 0;
    while (off < data.length) {
      const slice = data.subarray(off);
      const nBig = await requireLib().symbols.serial_write(
        this.#h as unknown as bigint,
        slice as unknown as BufferSource,
        BigInt(slice.length),
      );
      if (nBig < 0n) {
        throw new Error(getLastError() || `write failed: ${nBig.toString()}`);
      }
      off += Number(nBig);
    }
  }

  flush(opts: { in?: boolean; out?: boolean } = {}): void {
    const fi = opts.in ? 1 : 0;
    const fo = opts.out ? 1 : 0;
    const rc = requireLib().symbols.serial_flush(
      this.#h as unknown as bigint,
      fi,
      fo,
    );
    if (rc !== 0) throw new Error(getLastError() || `flush failed: ${rc}`);
  }

  drain(): void {
    const rc = requireLib().symbols.serial_drain(this.#h as unknown as bigint);
    if (rc !== 0) throw new Error(getLastError() || `drain failed: ${rc}`);
  }

  set(opts: { rts?: boolean; dtr?: boolean; brk?: boolean }): void {
    const rts = opts.rts == null ? -1 : (opts.rts ? 1 : 0);
    const dtr = opts.dtr == null ? -1 : (opts.dtr ? 1 : 0);
    const brk = opts.brk == null ? -1 : (opts.brk ? 1 : 0);
    const rc = requireLib().symbols.serial_set_lines(
      this.#h as unknown as bigint,
      rts,
      dtr,
      brk,
    );
    if (rc !== 0) throw new Error(getLastError() || `set failed: ${rc}`);
  }

  get(): { cts: boolean; dsr: boolean; dcd: boolean; ri: boolean } {
    const maskBuf = new Uint32Array(1);
    const rc = requireLib().symbols.serial_get_lines(
      this.#h as unknown as bigint,
      maskBuf as unknown as BufferSource,
    );
    if (rc !== 0) throw new Error(getLastError() || `get failed: ${rc}`);
    const m = maskBuf[0] >>> 0;
    return {
      cts: !!(m & (1 << 0)),
      dsr: !!(m & (1 << 1)),
      dcd: !!(m & (1 << 2)),
      ri: !!(m & (1 << 3)),
    };
  }

  close(): void {
    if (this.#closed) return;
    const rc = requireLib().symbols.serial_close(this.#h as unknown as bigint);
    this.#closed = true;
    if (rc !== 0) throw new Error(getLastError() || `close failed: ${rc}`);
  }

  [Symbol.asyncDispose](): Promise<void> {
    // Dispose prefers immediate release; we don't drain here.
    try {
      this.close();
    } catch {
      // Ignore if already closed
    }
    return Promise.resolve();
  }
}
