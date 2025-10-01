// Detect platform, download (if needed), cache, and return a dlopen path
export type Target =
  | "win32-x64"
  | "win32-arm64"
  | "linux-x64-gnu"
  | "linux-arm64-gnu"
  | "darwin-x64"
  | "darwin-arm64";

export function detectTarget(): Target {
  const os = Deno.build.os; // "windows" | "linux" | "darwin"
  const arch = Deno.build.arch; // "x86_64" | "aarch64"
  if (os === "windows") {
    if (arch === "x86_64") return "win32-x64";
    if (arch === "aarch64") return "win32-arm64";
  } else if (os === "linux") {
    if (arch === "x86_64") return "linux-x64-gnu";
    if (arch === "aarch64") return "linux-arm64-gnu";
  } else if (os === "darwin") {
    if (arch === "x86_64") return "darwin-x64";
    if (arch === "aarch64") return "darwin-arm64";
  }
  throw new Error(`Unsupported platform: ${os} ${arch}`);
}

function filenameFor(t: Target): string {
  if (t.startsWith("win32")) return "deno_serial.dll";
  if (t.startsWith("linux")) return "libdeno_serial.so";
  if (t.startsWith("darwin")) return "libdeno_serial.dylib";
  throw new Error("unreachable");
}

function rustTripleFor(t: Target): string {
  switch (t) {
    case "win32-x64":
      return "x86_64-pc-windows-msvc";
    case "win32-arm64":
      return "aarch64-pc-windows-msvc";
    case "linux-x64-gnu":
      return "x86_64-unknown-linux-gnu";
    case "linux-arm64-gnu":
      return "aarch64-unknown-linux-gnu";
    case "darwin-x64":
      return "x86_64-apple-darwin";
    case "darwin-arm64":
      return "aarch64-apple-darwin";
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findLocalBuild(
  t: Target,
  filename: string,
): Promise<string | null> {
  // 1) Explicit override via env var
  try {
    const fromEnv = Deno.env.get("DENO_SERIAL_LIB_PATH");
    if (fromEnv && await pathExists(fromEnv)) return fromEnv;
  } catch {
    // --allow-env not granted; ignore and continue
  }

  // 2) Cargo target dir (triple-specific)
  const triple = rustTripleFor(t);
  const triplePath = `target/${triple}/release/${filename}`;
  if (await pathExists(triplePath)) return triplePath;

  // 3) Cargo default host target dir
  const hostPath = `target/release/${filename}`;
  if (await pathExists(hostPath)) return hostPath;

  // 4) Already placed in local cache dir
  const cachePath = `.deno_serial/${filename}`;
  if (await pathExists(cachePath)) return cachePath;

  return null;
}

function releaseUrl(version: string, t: Target, filename: string): string {
  // TODO: Replace with your actual repository path for binary hosting.
  // Example: https://github.com/takker99/deno-serialport/releases/download/${version}/${t}/${filename}
  return `https://github.com/takker99/deno-serialport/releases/download/${version}/${t}/${filename}`;
}

export async function ensureLibrary(
  localDir: string,
  version: string,
): Promise<string> {
  await Deno.mkdir(localDir, { recursive: true });
  const t = detectTarget();
  const filename = filenameFor(t);
  const localPath = `${localDir}/${filename}`;
  // Prefer locally built library for development
  const dev = await findLocalBuild(t, filename);
  if (dev) return dev;
  // Fallback to cached copy
  try {
    await Deno.stat(localPath);
    return localPath;
  } catch {
    // not found; proceed to download
  }
  const url = releaseUrl(version, t, filename);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download failed: ${resp.status} ${url}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  await Deno.writeFile(localPath, data);
  return localPath;
}
