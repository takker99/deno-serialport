import { SerialPort } from "@takker/serialport";

const [path, baudStr] = Deno.args;
if (!path) {
  console.error(
    "Usage: deno run --allow-ffi --allow-read --allow-net examples/using.ts <path> [baud]",
  );
  Deno.exit(1);
}
const baudRate = baudStr ? parseInt(baudStr, 10) : 115200;

await using sp = await SerialPort.open({ path, baudRate });

await sp.write(new TextEncoder().encode("READY\r\n"));

// 必要なら明示的に送信完了を待つ
// await sp.drain();
