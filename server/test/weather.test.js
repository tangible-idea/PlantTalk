import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeather, describeWeather, pm25Grade, summarize, summarizeAir, weatherLabel } from "../src/weather.js";

const ok = (body) => ({ ok: true, json: async () => body });

const sample = {
  current: { time: "2026-10-28T17:30", temperature_2m: 9.9, apparent_temperature: 7.1, relative_humidity_2m: 37, weather_code: 0, is_day: 1 },
  daily: {
    time: ["2026-10-28", "2026-10-29"],
    weather_code: [0, 61],
    temperature_2m_max: [11.4, 13],
    temperature_2m_min: [2.1, 5],
    precipitation_probability_max: [0, 70],
    uv_index_max: [3.2, 1.1],
    sunrise: ["2026-10-28T06:52", "2026-10-29T06:53"],
    sunset: ["2026-10-28T17:38", "2026-10-29T17:37"],
  },
};

test("summarize keeps now, today and tomorrow", () => {
  const w = summarize(sample, "서울");
  assert.equal(w.label, "맑음");
  assert.equal(w.temp, 9.9);
  assert.equal(w.today.sunset, "17:38");
  assert.equal(w.tomorrow.label, "약한 비");
  assert.equal(w.tomorrow.rain, 70);
  assert.equal(weatherLabel(12345), "알 수 없음");
});

test("prompt text says the weather is outdoors, not at the pot", () => {
  const text = describeWeather(summarize(sample, "서울"));
  assert.match(text, /NOT measured at the pots/);
  assert.match(text, /tomorrow \(2026-10-29\): 약한 비, 5–13°C, chance of rain 70%/);
  assert.match(describeWeather(null), /unavailable/);
});

test("start loads the weather, and a failed fetch leaves it empty instead of throwing", async () => {
  const w = createWeather({ lat: 1, lon: 2, place: "X", fetchImpl: async () => ({ ok: true, json: async () => sample }) });
  await w.start();
  assert.equal(w.current().temp, 9.9);

  const down = createWeather({ lat: 1, lon: 2, place: "X", fetchImpl: async () => ({ ok: false, status: 500 }) });
  await down.start();
  assert.equal(down.current(), null);
  assert.match(down.describe(), /unavailable/);
});

test("without coordinates the location comes from the IP lookup", async () => {
  const urls = [];
  const w = createWeather({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return String(url).includes("ipwho.is") ? ok({ success: true, city: "Busan", latitude: 35.1, longitude: 129.04 }) : ok(sample);
    },
  });
  await w.start();
  assert.equal(w.current().place, "Busan");
  assert.match(urls[1], /latitude=35\.1&longitude=129\.04/);
});

test("a failed IP lookup falls back to Seoul", async () => {
  const urls = [];
  const w = createWeather({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return String(url).includes("ipwho.is") ? ok({ success: false, message: "reserved range" }) : ok(sample);
    },
  });
  await w.start();
  assert.equal(w.current().place, "서울");
  assert.match(urls[1], /latitude=37\.5665/);
});

test("air quality uses the Korean fine-dust grades", () => {
  assert.equal(pm25Grade(15), "좋음");
  assert.equal(pm25Grade(16), "보통");
  assert.equal(pm25Grade(76), "매우나쁨");
  const air = summarizeAir({
    current: { pm10: 42, pm2_5: 20.4 },
    hourly: { time: ["2026-10-28T10:00", "2026-10-28T11:00", "2026-10-29T10:00"], pm10: [40, 90, 20], pm2_5: [20, 40, 8] },
  });
  assert.equal(air.pm25Grade, "보통");
  assert.equal(air.today.pm25Grade, "나쁨");
  assert.equal(air.tomorrow.pm25Grade, "좋음");
  const text = describeWeather({ ...summarize(sample, "서울"), air });
  assert.match(text, /air quality now: PM10 42㎍\/㎥ \(보통\), PM2\.5 20㎍\/㎥ \(보통\); worst today PM2\.5 나쁨, tomorrow PM2\.5 좋음/);
});
