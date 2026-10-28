import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBleReceiver } from "./ble.js";
import { planReplies } from "./brain.js";
import { createHub } from "./hub.js";
import { createDiscordMessenger } from "./messengers/discord.js";
import { classify, DEFAULT_SLEEP_SECONDS, detectEvents, nextSleepSeconds } from "./status.js";
import { createHolidays } from "./holidays.js";
import { createKma } from "./kma.js";
import { startMorningGreeting } from "./morning.js";
import { createStore } from "./store.js";
import { createWeather } from "./weather.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const OWNER = process.env.OWNER_NAME || "주인";
const BLE_ENABLED = process.env.BLE_ENABLED === "1";

const store = createStore();

// 위치는 .env 의 WEATHER_LAT/LON, 없으면 서버 공인 IP 로 찾는다. WEATHER_ENABLED=0 이면 끈다.
const weather =
  process.env.WEATHER_ENABLED === "0"
    ? null
    : createWeather({
        place: process.env.WEATHER_PLACE || "",
        lat: process.env.WEATHER_LAT ? Number(process.env.WEATHER_LAT) : undefined,
        lon: process.env.WEATHER_LON ? Number(process.env.WEATHER_LON) : undefined,
      });
// 기상청 단기예보는 공공데이터포털 키가 있을 때만
const kma = weather && process.env.KMA_SERVICE_KEY ? createKma({ serviceKey: process.env.KMA_SERVICE_KEY }) : null;
const holidays = process.env.HOLIDAYS_ENABLED === "0" ? null : createHolidays({ country: process.env.HOLIDAY_COUNTRY || "KR" });

// Claude 에 넘기는 바깥 맥락 (날씨·대기질, 단기예보, 날짜·공휴일)
const outdoorContext = () =>
  [weather?.describe(), kma?.describe(), holidays?.describe()].filter(Boolean).join("\n\n") || null;

const messengers = [];
if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID && process.env.DISCORD_WEBHOOK_URL) {
  messengers.push(
    createDiscordMessenger({
      token: process.env.DISCORD_BOT_TOKEN,
      channelId: process.env.DISCORD_CHANNEL_ID,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    }),
  );
}
const hub = createHub({ store, planReplies, messengers, context: outdoorContext });

function bearer(req) {
  return (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
}

function requireAdmin(req, res, next) {
  if (ADMIN_TOKEN && bearer(req) !== ADMIN_TOKEN) return res.status(401).json({ error: "admin token required" });
  next();
}

function requireDevice(req, res, next) {
  if (DEVICE_TOKEN && bearer(req) !== DEVICE_TOKEN) return res.status(401).json({ error: "invalid device token" });
  next();
}

const round1 = (n) => Math.round(n * 10) / 10;

// BLE 는 몇 초마다 값이 오므로 기록은 이 간격으로만 남긴다 (상태가 바뀌거나 버튼을 누르면 바로).
const HISTORY_GAP_MS = 60 * 1000;
// 수분이 기준치 근처에서 오르내리면 상태가 계속 바뀐다. BLE 에서는 이 시간 안에 Claude 를 다시 부르지 않는다.
const EVENT_COOLDOWN_MS = 10 * 60 * 1000;
const lastEventAt = {};

function toNumber(value, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function ingestReading(plant, body) {
  const moisture = toNumber(body.moisture, { min: 0, max: 100 });
  if (moisture === null) return { error: "moisture must be a number between 0 and 100" };

  const reading = {
    ts: new Date().toISOString(),
    moisture: round1(moisture),
    battery: Math.round(toNumber(body.battery, { min: 0, max: 100 }) ?? 100),
    soilVoltage: toNumber(body.soilVoltage),
    batteryVoltage: toNumber(body.batteryVoltage),
    rssi: toNumber(body.rssi),
    wakeReason: typeof body.wakeReason === "string" ? body.wakeReason : null,
    chipTemp: toNumber(body.chipTemp, { min: -40, max: 125 }),
    uptime: toNumber(body.uptime, { min: 0 }),
    transport: body.transport === "ble" ? "ble" : "wifi",
    status: classify(plant, moisture),
  };
  const prev = store.latestReading(plant.id);
  store.setLiveReading(plant.id, reading);

  const ble = reading.transport === "ble";
  const button = reading.wakeReason === "button";
  const due =
    !ble || !prev || button || reading.status !== prev.status || Date.parse(reading.ts) - Date.parse(prev.ts) >= HISTORY_GAP_MS;
  if (!due) return { status: reading.status, sleepSeconds: nextSleepSeconds(reading.status) };
  store.addReading(plant.id, reading);

  let events = detectEvents(plant, prev, reading);
  if (ble && !button && events.length > 0) {
    if (Date.now() - (lastEventAt[plant.id] ?? 0) < EVENT_COOLDOWN_MS) events = [];
    else lastEventAt[plant.id] = Date.now();
  }
  if (events.length === 0 && button) {
    events.push(`${OWNER}이(가) 센서 버튼을 눌러 ${plant.name}의 상태를 직접 확인했다. 흙 수분 ${reading.moisture}%.`);
  }
  // 기기는 응답을 기다리며 깨어 있으므로 Claude 호출은 기다리지 않는다.
  if (events.length > 0) hub.sensorEvents(plant, events);

  return { status: reading.status, sleepSeconds: nextSleepSeconds(reading.status) };
}

const TEXT_FIELDS = ["name", "species", "deviceId", "personality", "speechStyle", "sampleLine", "avatarUrl"];

function sanitizePlant(id, body) {
  const plant = { id };
  for (const key of TEXT_FIELDS) plant[key] = String(body[key] ?? "").trim().slice(0, 500);
  if (!plant.name) return null;
  const t = body.thresholds ?? {};
  plant.thresholds = {
    dry: toNumber(t.dry, { min: 0, max: 100 }) ?? 25,
    thirsty: toNumber(t.thirsty, { min: 0, max: 100 }) ?? 45,
    soggy: toNumber(t.soggy, { min: 0, max: 100 }) ?? 85,
  };
  return plant;
}

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(here, "..", "public")));

app.get("/api/config", (req, res) => {
  res.json({ adminRequired: Boolean(ADMIN_TOKEN), owner: OWNER, messengers: messengers.map((m) => m.name) });
});

// Wi-Fi(HTTP) 와 BLE 가 같이 쓴다.
function deviceReading(body) {
  const deviceId = String(body.deviceId ?? "");
  const plant = store.plantByDevice(deviceId);
  if (!plant) {
    store.noteUnknownDevice(deviceId, { ts: new Date().toISOString(), ...body });
    console.warn(`[readings] unknown device: ${deviceId}`);
    return { status: "unknown-device", sleepSeconds: DEFAULT_SLEEP_SECONDS };
  }
  return ingestReading(plant, body);
}

// 펌웨어가 깨어날 때마다 호출한다.
app.post("/api/readings", requireDevice, (req, res) => {
  const result = deviceReading(req.body);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.get("/api/plants", (req, res) => {
  res.json({
    plants: store.plants().map((p) => ({ ...p, latest: store.liveReading(p.id) ?? null, history: store.readings(p.id).slice(-96) })),
    unknownDevices: store.unknownDevices(),
  });
});

app.put("/api/plants/:id", requireAdmin, (req, res) => {
  const id = req.params.id.toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return res.status(400).json({ error: "id 는 영문 소문자/숫자/- 만 가능" });
  const plant = sanitizePlant(id, req.body);
  if (!plant) return res.status(400).json({ error: "name is required" });
  res.json(store.upsertPlant(plant));
});

app.delete("/api/plants/:id", requireAdmin, (req, res) => {
  store.deletePlant(req.params.id);
  res.status(204).end();
});

// 하드웨어 없이 센서 값을 넣어볼 때 쓴다.
app.post("/api/plants/:id/simulate", requireAdmin, (req, res) => {
  const plant = store.plant(req.params.id);
  if (!plant) return res.status(404).json({ error: "plant not found" });
  const result = ingestReading(plant, { ...req.body, wakeReason: "simulate" });
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.get("/api/outdoor", (req, res) => {
  res.json({ weather: weather?.current() ?? null, forecast: kma?.current() ?? null, calendar: holidays?.info() ?? null });
});

app.get("/api/chat", (req, res) => {
  res.json({ messages: store.chat(Number(req.query.after) || 0), typing: hub.busy() });
});

app.post("/api/chat", requireAdmin, (req, res) => {
  const text = String(req.body.text ?? "").trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: "text is required" });
  hub.ownerMessage({ author: OWNER, text, source: "web" });
  res.status(202).json({ ok: true });
});

await hub.start();
await weather?.start();
await Promise.all([kma?.start(weather.location()), holidays?.start()]);
if (weather && !kma) console.log("[kma] KMA_SERVICE_KEY 가 없어 기상청 단기예보는 끕니다.");
if (process.env.MORNING_GREETING !== "0") startMorningGreeting({ store, onMorning: () => hub.morning() });
if (BLE_ENABLED) {
  await startBleReceiver({
    onReading(body) {
      const result = deviceReading(body);
      if (result.error) console.warn(`[ble] ${body.deviceId}: ${result.error}`);
    },
  });
}
app.listen(PORT, () => {
  console.log(`PlantTalk server on http://localhost:${PORT}`);
  if (!DEVICE_TOKEN) console.warn("DEVICE_TOKEN 이 비어 있어 아무 기기나 측정값을 보낼 수 있습니다.");
  if (messengers.length === 0) console.log("Discord 설정이 없어 웹 대시보드 채팅만 사용합니다.");
});
