import assert from "node:assert/strict";
import { test } from "node:test";
import { baseTimeFor, describeForecast, summarizeForecast, toGrid } from "../src/kma.js";

// KST 시각을 UTC Date 로
const kst = (iso) => new Date(`${iso}+09:00`);

test("lat/lon to KMA grid matches the published examples", () => {
  assert.deepEqual(toGrid(37.5665, 126.978), { nx: 60, ny: 127 }); // 서울 중구
  assert.deepEqual(toGrid(35.1796, 129.0756), { nx: 98, ny: 76 }); // 부산
});

test("base time is the latest release at least 10 minutes old", () => {
  assert.deepEqual(baseTimeFor(kst("2026-10-28T14:09")), { base_date: "20261028", base_time: "1100" });
  assert.deepEqual(baseTimeFor(kst("2026-10-28T14:10")), { base_date: "20261028", base_time: "1400" });
  assert.deepEqual(baseTimeFor(kst("2026-10-28T01:30")), { base_date: "20261027", base_time: "2300" });
});

test("forecast summary finds rain spans and the next hours", () => {
  const items = [];
  const add = (date, time, values) =>
    Object.entries(values).forEach(([category, fcstValue]) => items.push({ fcstDate: date, fcstTime: time, category, fcstValue: String(fcstValue) }));
  for (let h = 15; h <= 23; h++) {
    const rain = h >= 18 && h <= 20;
    add("20261028", `${h}00`, { TMP: 20 - (h - 15), SKY: rain ? 4 : 1, PTY: rain ? 1 : 0, POP: rain ? 80 : 10, REH: 50 });
  }
  add("20261029", "0600", { TMP: 8, SKY: 3, PTY: 0, POP: 20, REH: 60, TMN: 7 });
  add("20261029", "1500", { TMP: 15, SKY: 3, PTY: 0, POP: 20, REH: 40, TMX: 16 });

  const f = summarizeForecast(items, kst("2026-10-28T15:20"));
  assert.deepEqual(f.today.rain, ["18–20시 비"]);
  assert.equal(f.today.rainChance, 80);
  assert.equal(f.tomorrow.min, 7);
  assert.equal(f.tomorrow.max, 16);
  assert.deepEqual(f.next.map((n) => `${n.hour}시 ${n.label}`), ["15시 맑음", "18시 비", "21시 맑음", "6시 구름많음"]);
  assert.match(describeForecast(f), /today \(2026-10-28\): 12–20°C, chance of rain up to 80%, 18–20시 비/);
});
