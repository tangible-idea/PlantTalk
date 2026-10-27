// 단일 JSON 파일 저장소. 식물 몇 개 규모라 DB 없이 충분하다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(here, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SEED_FILE = path.join(here, "..", "plants.example.json");

const MAX_READINGS_PER_PLANT = 500;
const MAX_CHAT = 500;

export function createStore(file = DB_FILE) {
  let db;
  if (fs.existsSync(file)) {
    db = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    db = { plants: JSON.parse(fs.readFileSync(SEED_FILE, "utf8")), readings: {}, chat: [], unknownDevices: {} };
  }
  let nextChatId = (db.chat.at(-1)?.id ?? 0) + 1;

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }
  save();

  return {
    plants: () => db.plants,
    plant: (id) => db.plants.find((p) => p.id === id),
    plantByDevice: (deviceId) => db.plants.find((p) => p.deviceId === deviceId),

    upsertPlant(plant) {
      const i = db.plants.findIndex((p) => p.id === plant.id);
      if (i >= 0) db.plants[i] = plant;
      else db.plants.push(plant);
      save();
      return plant;
    },

    deletePlant(id) {
      db.plants = db.plants.filter((p) => p.id !== id);
      delete db.readings[id];
      save();
    },

    readings: (plantId) => db.readings[plantId] ?? [],
    latestReading: (plantId) => db.readings[plantId]?.at(-1),

    addReading(plantId, reading) {
      const list = (db.readings[plantId] ??= []);
      list.push(reading);
      if (list.length > MAX_READINGS_PER_PLANT) list.splice(0, list.length - MAX_READINGS_PER_PLANT);
      save();
    },

    noteUnknownDevice(deviceId, reading) {
      db.unknownDevices[deviceId] = reading;
      save();
    },
    unknownDevices: () => db.unknownDevices,

    chat: (afterId = 0) => db.chat.filter((m) => m.id > afterId),
    recentChat: (n) => db.chat.slice(-n),

    addChat(message) {
      const entry = { id: nextChatId++, ts: new Date().toISOString(), ...message };
      db.chat.push(entry);
      if (db.chat.length > MAX_CHAT) db.chat.splice(0, db.chat.length - MAX_CHAT);
      save();
      return entry;
    },
  };
}
