import { SerialPort } from "@takker/serialport";
const ports = await SerialPort.list();
console.log(ports);
