import { SerialPort } from "@takker/serialport";

const [path, baudStr] = Deno.args;
if (!path) {
  console.error(
    "Usage: deno run --allow-ffi --allow-read --allow-net examples/echo.ts <path> [baud]",
  );
  Deno.exit(1);
}
const baudRate = baudStr ? parseInt(baudStr, 10) : 115200;

const sp = await SerialPort.open({ path, baudRate });

(async () => {
  for await (const chunk of sp.readable) {
    await sp.write(chunk); // echo back
  }
})();

const encoder = new TextEncoder();
await sp.write(encoder.encode("Echo server ready\r\n"));
