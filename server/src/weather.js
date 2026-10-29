// 바깥 날씨와 대기질 (Open-Meteo, API 키 없음). 30분마다 받아 두고, Claude 프롬프트와 대시보드에 쓴다.
// 화분 자리에서 잰 값이 아니므로 프롬프트에 "바깥 날씨"라고 분명히 적는다.
// 위치를 따로 정하지 않으면 서버(= 화분이 있는 집)의 공인 IP 로 도시 단위 위치를 찾는다.

const REFRESH_MS = 30 * 60 * 1000;
const FALLBACK = { place: "서울", lat: 37.5665, lon: 126.978 };

// ipwho.is (키 없음). 서버의 공인 IP 가 이 서비스로 전송된다. 정확도는 도시/통신사 거점 수준.
export async function locateByIp(fetchImpl = fetch) {
  const res = await fetchImpl("https://ipwho.is/", { signal: AbortSignal.timeout(8000) });
  const d = await res.json();
  if (!d.success || typeof d.latitude !== "number") throw new Error(d.message || "lookup failed");
  return { place: d.city || d.region || d.country, lat: d.latitude, lon: d.longitude, country: d.country_code };
}

// WMO weather code -> 한국어
const WMO = {
  0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림", 45: "안개", 48: "서리 안개",
  51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비", 56: "언 이슬비", 57: "강한 언 이슬비",
  61: "약한 비", 63: "비", 65: "강한 비", 66: "언 비", 67: "강한 언 비",
  71: "약한 눈", 73: "눈", 75: "강한 눈", 77: "싸락눈",
  80: "약한 소나기", 81: "소나기", 82: "강한 소나기", 85: "약한 눈보라", 86: "강한 눈보라",
  95: "뇌우", 96: "우박 동반 뇌우", 99: "강한 우박 동반 뇌우",
};

export const weatherLabel = (code) => WMO[code] ?? "알 수 없음";

const hhmm = (iso) => iso?.slice(11, 16);

// 환경부 미세먼지 예보 등급 (㎍/㎥)
const GRADES = ["좋음", "보통", "나쁨", "매우나쁨"];
const grade = (value, cuts) => (value == null ? null : GRADES[cuts.findIndex((c) => value <= c)] ?? GRADES[3]);
export const pm10Grade = (v) => grade(v, [30, 80, 150]);
export const pm25Grade = (v) => grade(v, [15, 35, 75]);

// 대기질 응답 -> 지금 값과 오늘/내일 최고치
export function summarizeAir(json) {
  const c = json.current;
  const h = json.hourly;
  const dayMax = (date, key) => {
    const vals = h.time.map((t, i) => (t.startsWith(date) ? h[key][i] : null)).filter((v) => v != null);
    return vals.length ? Math.round(Math.max(...vals)) : null;
  };
  const day = (date) => {
    const pm10 = dayMax(date, "pm10");
    const pm25 = dayMax(date, "pm2_5");
    return { date, pm10, pm25, pm10Grade: pm10Grade(pm10), pm25Grade: pm25Grade(pm25) };
  };
  const dates = [...new Set(h.time.map((t) => t.slice(0, 10)))];
  return {
    pm10: Math.round(c.pm10),
    pm25: Math.round(c.pm2_5),
    pm10Grade: pm10Grade(c.pm10),
    pm25Grade: pm25Grade(c.pm2_5),
    today: day(dates[0]),
    tomorrow: dates[1] ? day(dates[1]) : null,
  };
}

// Open-Meteo 응답 -> 필요한 값만
export function summarize(json, place) {
  const c = json.current;
  const d = json.daily;
  const day = (i) => ({
    date: d.time[i],
    label: weatherLabel(d.weather_code[i]),
    min: d.temperature_2m_min[i],
    max: d.temperature_2m_max[i],
    rain: d.precipitation_probability_max[i],
    uvMax: d.uv_index_max[i],
    sunrise: hhmm(d.sunrise[i]),
    sunset: hhmm(d.sunset[i]),
  });
  return {
    place,
    time: c.time,
    temp: c.temperature_2m,
    feelsLike: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    label: weatherLabel(c.weather_code),
    isDay: c.is_day === 1,
    today: day(0),
    tomorrow: d.time.length > 1 ? day(1) : null,
  };
}

// Claude 에 넘기는 한 덩어리 설명
export function describeWeather(w) {
  if (!w) return "Outdoor weather: unavailable right now.";
  const day = (name, x) =>
    `${name} (${x.date}): ${x.label}, ${x.min}–${x.max}°C, chance of rain ${x.rain}%, max UV ${x.uvMax}, sunrise ${x.sunrise}, sunset ${x.sunset}`;
  return [
    `Outdoor weather in ${w.place} (from a weather service, NOT measured at the pots; updated ${hhmm(w.time)}):`,
    `- now: ${w.label}, ${w.temp}°C (feels like ${w.feelsLike}°C), humidity ${w.humidity}%, ${w.isDay ? "daytime" : "night"}`,
    `- ${day("today", w.today)}`,
    w.tomorrow ? `- ${day("tomorrow", w.tomorrow)}` : null,
    w.air
      ? `- air quality now: PM10 ${w.air.pm10}㎍/㎥ (${w.air.pm10Grade}), PM2.5 ${w.air.pm25}㎍/㎥ (${w.air.pm25Grade}); ` +
        `worst today PM2.5 ${w.air.today.pm25Grade}` +
        (w.air.tomorrow ? `, tomorrow PM2.5 ${w.air.tomorrow.pm25Grade}` : "")
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// lat/lon 을 주지 않으면 start() 에서 IP 로 위치를 찾고, 그것도 실패하면 서울을 쓴다.
export function createWeather({ lat, lon, place, timezone = "auto", fetchImpl = fetch }) {
  let latest = null;
  let country = null;

  async function fetchAir() {
    const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
    url.search = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      timezone,
      forecast_days: 2,
      current: "pm10,pm2_5",
      hourly: "pm10,pm2_5",
    });
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return summarizeAir(await res.json());
  }

  async function refresh() {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      timezone,
      forecast_days: 2,
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset",
    });
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = summarize(await res.json(), place);
      next.air = await fetchAir().catch((err) => {
        console.warn(`[weather] air quality failed: ${err.message}`);
        return latest?.air ?? null;
      });
      latest = next;
    } catch (err) {
      // 실패해도 마지막 값을 계속 쓴다
      console.warn(`[weather] refresh failed: ${err.message}`);
    }
  }

  return {
    async start() {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        try {
          const found = await locateByIp(fetchImpl);
          ({ lat, lon, country } = found);
          place ||= found.place;
          console.log(`[weather] location from IP: ${found.place} (${lat}, ${lon})`);
        } catch (err) {
          ({ lat, lon } = FALLBACK);
          place ||= FALLBACK.place;
          console.warn(`[weather] IP location failed (${err.message}), using ${FALLBACK.place}`);
        }
      }
      place ||= "현재 위치";
      await refresh();
      setInterval(refresh, REFRESH_MS).unref();
      if (latest) console.log(`[weather] ${place}: ${latest.label} ${latest.temp}°C`);
    },
    current: () => latest,
    // 단기예보(기상청)와 공휴일이 같은 위치를 쓴다. start() 뒤에 부른다.
    location: () => ({ lat, lon, country }),
    describe: () => describeWeather(latest),
  };
}
