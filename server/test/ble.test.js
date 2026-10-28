import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReading } from "../src/ble.js";

// 펌웨어 bleStream() 과 같은 배치로 패킷을 만든다.
function packet({ moisture = 37.5, soilMv = 2100, batteryMv = 1420, battery = 84, wake = 2 } = {}) {
  const data = Buffer.alloc(9);
  data[0] = 1;
  data.writeUInt16LE(Math.round(moisture * 10), 1);
  data.writeUInt16LE(soilMv, 3);
  data.writeUInt16LE(batteryMv, 5);
  data[7] = battery;
  data[8] = wake;
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
  });
});

test("ignores short or unknown-version packets", () => {
  assert.equal(parseReading("x", Buffer.from([1, 2, 3])), null);
  const p = packet();
  p[0] = 9;
  assert.equal(parseReading("x", p), null);
});
