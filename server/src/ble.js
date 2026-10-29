// Wi-Fi 가 없을 때 맥(서버)이 센서에 BLE 로 연결해 측정값을 계속 받는다.
//
// 센서는 PlantTalk 서비스를 광고하고, 연결되면 READING 특성을 주기적으로 notify 한다.
// 기기 ID 는 광고의 local name(= 펌웨어 DEVICE_ID).
// 인증은 아직 없다. 근처의 누구나 같은 서비스로 값을 보낼 수 있다.
//
// READING 값 (little-endian, 펌웨어 bleStream() 과 같아야 한다)
//   0     버전 (2. 버전 1 은 8번까지만 있다)
//   1-2   moisture  u16  x10 (%)
//   3-4   soil      u16  mV
//   5-6   battery   u16  mV
//   7     battery   u8   %
//   8     wake      u8   0 boot / 1 timer / 2 button
//   9-10  chipTemp  i16  x10 (°C) ESP32-C6 내장 온도 센서. 실내 기온이 아니다
//   11-14 uptime    u32  초

export const SERVICE_UUID = "7a1e0001b5a34f2c9a1d6c0f3e8b2d41";
export const READING_UUID = "7a1e0002b5a34f2c9a1d6c0f3e8b2d41";

const WAKE_REASONS = ["boot", "timer", "button"];

export function parseReading(deviceId, data) {
  const version = data?.[0];
  if (!(version === 1 && data.length >= 9) && !(version === 2 && data.length >= 15)) return null;
  const body = {
    deviceId,
    moisture: data.readUInt16LE(1) / 10,
    soilVoltage: data.readUInt16LE(3) / 1000,
    batteryVoltage: data.readUInt16LE(5) / 1000,
    battery: data[7],
    wakeReason: WAKE_REASONS[data[8]] ?? "timer",
    transport: "ble",
  };
  if (version >= 2) {
    body.chipTemp = data.readInt16LE(9) / 10;
    body.uptime = data.readUInt32LE(11);
  }
  return body;
}

// noble 은 optionalDependency 라 없거나 블루투스가 꺼져 있으면 경고만 남기고 넘어간다.
export async function startBleReceiver({ onReading }) {
  let noble;
  try {
    ({ default: noble } = await import("@stoprocent/noble"));
  } catch {
    console.warn("[ble] @stoprocent/noble 을 불러오지 못해 BLE 수신을 끕니다 (npm install 확인).");
    return;
  }

  const connected = new Set(); // peripheral.id

  async function connect(peripheral) {
    const deviceId = peripheral.advertisement.localName;
    connected.add(peripheral.id);
    peripheral.once("disconnect", () => {
      connected.delete(peripheral.id);
      console.log(`[ble] ${deviceId} disconnected`);
    });
    try {
      await peripheral.connectAsync();
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [READING_UUID]);
      const reading = characteristics[0];
      if (!reading) throw new Error("READING characteristic not found");
      reading.on("data", (data) => {
        const body = parseReading(deviceId, data);
        if (!body) return console.warn(`[ble] ${deviceId}: unknown packet ${data.toString("hex")}`);
        console.log(`[ble] ${deviceId} moisture=${body.moisture}% battery=${body.battery}% (${body.wakeReason})`);
        onReading({ ...body, rssi: peripheral.rssi });
      });
      await reading.subscribeAsync();
      console.log(`[ble] ${deviceId} connected`);
    } catch (err) {
      console.warn(`[ble] ${deviceId}: ${err?.message ?? err}`);
      connected.delete(peripheral.id);
      peripheral.disconnectAsync().catch(() => {});
    }
  }

  noble.on("discover", (peripheral) => {
    // 맥에서는 스캔 필터를 거치지 않은 기기도 올라올 수 있어 한 번 더 확인한다.
    const uuids = peripheral.advertisement?.serviceUuids ?? [];
    if (!uuids.some((u) => u.replaceAll("-", "").toLowerCase() === SERVICE_UUID)) return;
    // 이름(DEVICE_ID)은 scan response 에 있어 첫 발견 때는 비어 있을 수 있다. 이름이 보일 때까지 기다린다.
    if (!peripheral.advertisement?.localName) return;
    if (!connected.has(peripheral.id)) connect(peripheral);
  });

  noble.on("stateChange", (state) => {
    if (state === "poweredOn") {
      // 연결이 끊긴 기기가 다시 광고하면 다시 붙어야 하므로 중복 발견도 받는다.
      noble.startScanning([SERVICE_UUID], true);
      console.log("[ble] scanning");
    } else {
      console.warn(`[ble] adapter ${state}`);
    }
  });
}
