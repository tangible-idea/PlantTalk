// 공휴일 (date.nager.at, 키 없음). 오늘 날짜·요일과 함께 Claude 에 넘겨서
// "오늘 쉬는 날이네" 같은 맥락을 준다. 날짜는 서버 로컬 시각 기준.

const REFRESH_MS = 24 * 3600 * 1000;
const WEEKDAYS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

const dateKey = (d) => d.toLocaleDateString("sv-SE"); // YYYY-MM-DD

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// holidays: [{date: "YYYY-MM-DD", name}] 정렬된 목록
export function dayInfo(now, holidays) {
  const find = (d) => holidays.find((h) => h.date === dateKey(d));
  const today = { date: dateKey(now), weekday: WEEKDAYS[now.getDay()], holiday: find(now)?.name ?? null };
  const tomorrowDate = addDays(now, 1);
  const tomorrow = { date: dateKey(tomorrowDate), weekday: WEEKDAYS[tomorrowDate.getDay()], holiday: find(tomorrowDate)?.name ?? null };
  const next = holidays.find((h) => h.date > today.date) ?? null;
  const daysUntil = next ? Math.round((new Date(`${next.date}T00:00`) - new Date(`${today.date}T00:00`)) / 86400000) : null;
  return { today, tomorrow, next: next && { ...next, daysUntil } };
}

export function describeDay(info) {
  const off = (d) => d.holiday ?? (d.weekday === "토요일" || d.weekday === "일요일" ? "weekend" : null);
  const line = (name, d) => `- ${name}: ${d.date} ${d.weekday}${off(d) ? ` (day off: ${off(d)})` : " (working day)"}`;
  return [
    "Calendar (the owner is more likely to be home on days off):",
    line("today", info.today),
    line("tomorrow", info.tomorrow),
    info.next ? `- next public holiday: ${info.next.name} on ${info.next.date}, in ${info.next.daysUntil} days` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createHolidays({ country = "KR", fetchImpl = fetch }) {
  let holidays = [];

  async function load(year) {
    const res = await fetchImpl(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).map((h) => ({ date: h.date, name: h.localName || h.name }));
  }

  async function refresh() {
    const year = new Date().getFullYear();
    try {
      // 연말에도 "다음 공휴일"을 알 수 있도록 내년 것까지 받는다
      const [a, b] = await Promise.all([load(year), load(year + 1)]);
      holidays = [...a, ...b].sort((x, y) => x.date.localeCompare(y.date));
    } catch (err) {
      console.warn(`[holidays] refresh failed: ${err.message}`);
    }
  }

  return {
    async start() {
      await refresh();
      setInterval(refresh, REFRESH_MS).unref();
      console.log(`[holidays] ${country}: ${holidays.length} days loaded`);
    },
    info: () => dayInfo(new Date(), holidays),
    describe: () => describeDay(dayInfo(new Date(), holidays)),
  };
}
