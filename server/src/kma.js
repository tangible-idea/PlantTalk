// 기상청 단기예보 (공공데이터포털 VilageFcstInfoService_2.0, 서비스 키 필요).
// 동네(5km 격자) 단위라 한국에서는 Open-Meteo 보다 촘촘하다. 키가 없으면 꺼진다.
// 발표: 02·05·08·11·14·17·20·23시 (+10분 뒤부터 조회 가능). 1시간마다 다시 받는다.

const REFRESH_MS = 60 * 60 * 1000;
const URL_BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";
const BASE_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
const SKY = { 1: "맑음", 3: "구름많음", 4: "흐림" };
const PTY = { 1: "비", 2: "비/눈", 3: "눈", 4: "소나기" };

// 위경도 -> 기상청 격자 (기상청 제공 Lambert Conformal Conic 변환식)
export function toGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const rad = Math.PI / 180;
  const re = RE / GRID;
  const slat1 = SLAT1 * rad, slat2 = SLAT2 * rad, olon = OLON * rad, olat = OLAT * rad;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  const ro = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + olat * 0.5), sn);
  const ra = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + lat * rad * 0.5), sn);
  let theta = lon * rad - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

// 한국 시각으로 계산한다 (서버 시간대와 무관하게)
const kst = (d) => new Date(d.getTime() + 9 * 3600 * 1000);
const ymd = (k) => k.toISOString().slice(0, 10).replaceAll("-", "");

// 지금 조회할 수 있는 가장 최근 발표 시각
export function baseTimeFor(now) {
  const k = kst(now);
  const minutes = k.getUTCHours() * 60 + k.getUTCMinutes();
  const h = BASE_HOURS.filter((b) => b * 60 + 10 <= minutes).at(-1);
  if (h !== undefined) return { base_date: ymd(k), base_time: `${String(h).padStart(2, "0")}00` };
  const yesterday = new Date(k.getTime() - 24 * 3600 * 1000);
  return { base_date: ymd(yesterday), base_time: "2300" };
}

const fmtDate = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const hourOf = (t) => Number(t.slice(0, 2));

// 예보 항목들 -> 오늘/내일 요약과 앞으로 12시간 (3시간 간격)
export function summarizeForecast(items, now) {
  const slots = new Map();
  for (const it of items) {
    const key = it.fcstDate + it.fcstTime;
    if (!slots.has(key)) slots.set(key, { date: it.fcstDate, time: it.fcstTime });
    slots.get(key)[it.category] = it.fcstValue;
  }
  const list = [...slots.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const label = (s) => (Number(s.PTY) > 0 ? PTY[s.PTY] : SKY[s.SKY]) ?? "?";

  const k = kst(now);
  const today = ymd(k);
  const tomorrow = ymd(new Date(k.getTime() + 24 * 3600 * 1000));
  const day = (date) => {
    const ds = list.filter((s) => s.date === date);
    if (!ds.length) return null;
    const temps = ds.map((s) => Number(s.TMP)).filter(Number.isFinite);
    const min = ds.find((s) => s.TMN)?.TMN ?? Math.min(...temps);
    const max = ds.find((s) => s.TMX)?.TMX ?? Math.max(...temps);
    // 비/눈 오는 시간을 "15–18시 비" 처럼 이어 붙인다
    const rain = [];
    for (const s of ds) {
      const type = Number(s.PTY) > 0 ? PTY[s.PTY] : null;
      const last = rain.at(-1);
      if (type && last && last.type === type && last.to === hourOf(s.time) - 1) last.to = hourOf(s.time);
      else if (type) rain.push({ type, from: hourOf(s.time), to: hourOf(s.time) });
    }
    return {
      date: fmtDate(date),
      min: Number(min),
      max: Number(max),
      rainChance: Math.max(...ds.map((s) => Number(s.POP) || 0)),
      rain: rain.map((r) => (r.from === r.to ? `${r.from}시 ${r.type}` : `${r.from}–${r.to}시 ${r.type}`)),
    };
  };

  const nowKey = today + String(k.getUTCHours()).padStart(2, "0") + "00";
  const next = list
    .filter((s) => s.date + s.time >= nowKey)
    .slice(0, 13)
    .filter((_, i) => i % 3 === 0)
    .map((s) => ({ hour: hourOf(s.time), label: label(s), temp: Number(s.TMP), rainChance: Number(s.POP), humidity: Number(s.REH) }));

  return { today: day(today), tomorrow: day(tomorrow), next };
}

export function describeForecast(f) {
  if (!f) return null;
  const day = (name, d) =>
    d && `- ${name} (${d.date}): ${d.min}–${d.max}°C, chance of rain up to ${d.rainChance}%` + (d.rain.length ? `, ${d.rain.join(", ")}` : ", no rain or snow");
  return [
    "Korea Meteorological Administration neighborhood forecast (more precise for Korea than the weather above; prefer it for rain and temperatures):",
    day("today", f.today),
    day("tomorrow", f.tomorrow),
    f.next.length ? `- next hours: ${f.next.map((n) => `${n.hour}시 ${n.label} ${n.temp}°C 강수 ${n.rainChance}%`).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createKma({ serviceKey, fetchImpl = fetch }) {
  let grid = null;
  let latest = null;

  async function refresh() {
    const now = new Date();
    const url = new URL(URL_BASE);
    // 공공데이터포털의 "Decoding" 키를 넣는다. URLSearchParams 가 인코딩한다.
    url.search = new URLSearchParams({ serviceKey, dataType: "JSON", numOfRows: 1000, pageNo: 1, ...baseTimeFor(now), ...grid });
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        // 키 오류 등은 XML 로 온다
        throw new Error(text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/)?.[1] ?? `HTTP ${res.status}`);
      }
      const header = json.response?.header;
      if (header?.resultCode !== "00") {
        throw new Error(header?.resultMsg ?? json.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnAuthMsg ?? "unknown error");
      }
      latest = summarizeForecast(json.response.body.items.item, now);
    } catch (err) {
      console.warn(`[kma] refresh failed: ${err.message}`);
    }
  }

  return {
    async start({ lat, lon }) {
      grid = toGrid(lat, lon);
      await refresh();
      setInterval(refresh, REFRESH_MS).unref();
      if (latest) console.log(`[kma] forecast loaded for grid ${grid.nx},${grid.ny}`);
    },
    current: () => latest,
    describe: () => describeForecast(latest),
  };
}
