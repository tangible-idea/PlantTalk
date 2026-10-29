import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReading } from "../src/ble.js";

// 펌웨어 bleStream() 과 같은 배치로 패킷을 만든다.
function packet({ moisture = 37.5, soilMv = 2100, batteryMv = 1420, battery = 84, wake = 2, chipTemp = -3.5, uptime = 70000 } = {}) {
  const data = Buffer.alloc(15);
  data[0] = 2;
  data.writeUInt16LE(Math.round(moisture * 10), 1);
  data.writeUInt16LE(soilMv, 3);
  data.writeUInt16LE(batteryMv, 5);
  data[7] = battery;
  data[8] = wake;
  data.writeInt16LE(Math.round(chipTemp * 10), 9);
  data.writeUInt32LE(uptime, 11);
  return data;
}

test("parses a READING notification", () => {
  assert.deepEqual(parseReading("soil-basil", packet()), {
    deviceId: "soil-basil",
    moisture: 37.5,
    soilVoltage: 2.1,
    batteryVoltage: 1.42,
    battery: 84,
    wakeReason: "button",
    transport: "ble",
    chipTemp: -3.5,
    uptime: 70000,
  });
});

test("still reads version 1 packets without extras", () => {
  const v1 = packet().subarray(0, 9);
  v1[0] = 1;
  const body = parseReading("soil-basil", v1);
  assert.equal(body.moisture, 37.5);
  assert.equal(body.chipTemp, undefined);
});

test("ignores short or unknown-version packets", () => {
  assert.equal(parseReading("x", Buffer.from([1, 2, 3])), null);
  assert.equal(parseReading("x", packet().subarray(0, 12)), null); // 버전 2 인데 짧음
  const p = packet();
  p[0] = 9;
  assert.equal(parseReading("x", p), null);
});
