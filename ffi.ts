// Low-level FFI bindings and helpers
export type Handle = bigint;

const symbols = {
  serial_err_len: { parameters: [], result: "usize" },
  serial_err_fill: { parameters: ["pointer", "usize"], result: "void" },

  serial_open: {
    parameters: [
      "pointer",
      "u32",
      "u8",
      "u8",
      "u8",
      "u8",
      "u8",
      "u8",
      "u8",
      "i32",
    ],
    result: "i32",
  },
  serial_last_handle: { parameters: [], result: "u64" },
  serial_close: { parameters: ["u64"], result: "i32" },

  serial_write: {
    // Use 'buffer' so callers can pass a Uint8Array directly.
    parameters: ["u64", "buffer", "usize"],
    result: "isize",
    nonblocking: true,
  },
  serial_read: {
    // Use 'buffer' so we can read into a Uint8Array directly.
    parameters: ["u64", "buffer", "usize", "i32"],
    result: "isize",
    nonblocking: true,
  },

  serial_set_lines: { parameters: ["u64", "i32", "i32", "i32"], result: "i32" },
  serial_get_lines: { parameters: ["u64", "buffer"], result: "i32" }, // out: u32[1] mask

  serial_flush: { parameters: ["u64", "i32", "i32"], result: "i32" },
  serial_drain: { parameters: ["u64"], result: "i32" },

  serial_list_ports_len: { parameters: [], result: "usize" },
  serial_list_ports_fill: { parameters: ["pointer", "usize"], result: "usize" },
  serial_free_cstr: { parameters: ["pointer"], result: "void" },
} as const;

export type Lib = Deno.DynamicLibrary<typeof symbols>;
let lib: Lib | null = null;

export function load(path: string) {
  if (lib) return lib;
  lib = Deno.dlopen(path, symbols);
  return lib;
}

export function getLastError(): string {
  if (!lib) return "";
  // serial_err_len() returns a usize (bigint in Deno's FFI)
  const lenBig = lib.symbols.serial_err_len();
  if (lenBig === 0n) return "";
  // Uint8Array expects a number length; convert carefully.
  const len = Number(lenBig);
  const buf = new Uint8Array(len);
  // Pass the original bigint length to the FFI call (usize)
  lib.symbols.serial_err_fill(Deno.UnsafePointer.of(buf), lenBig);
  return new TextDecoder().decode(buf).replace(/\0+$/, "");
}

export function requireLib(): Lib {
  if (!lib) throw new Error("FFI library is not loaded");
  return lib;
}
