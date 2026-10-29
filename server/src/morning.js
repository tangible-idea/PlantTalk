// 아침 인사. 매일 START_HOUR~END_HOUR 사이의 무작위 시각에 식물이 먼저 말을 건다 (서버 로컬 시각 기준).
// 인사한 날짜를 저장해 두어서 서버를 다시 켜도 하루에 한 번만 한다.

const START_HOUR = 7;
const END_HOUR = 9;

export const dateKey = (d) => d.toLocaleDateString("sv-SE"); // YYYY-MM-DD (로컬)

function at(day, hour) {
  const d = new Date(day);
  d.setHours(hour, 0, 0, 0);
  return d;
}

// 다음 인사 시각. 오늘 아직 안 했고 창이 남아 있으면 오늘 남은 구간에서, 아니면 내일 구간에서 고른다.
export function nextMorning(now, lastDate, random = Math.random) {
  const end = at(now, END_HOUR);
  if (lastDate !== dateKey(now) && now < end) {
    const start = new Date(Math.max(at(now, START_HOUR).getTime(), now.getTime() + 60 * 1000));
    if (start < end) return new Date(start.getTime() + random() * (end - start));
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const start = at(tomorrow, START_HOUR);
  return new Date(start.getTime() + random() * (at(tomorrow, END_HOUR) - start));
}

export function startMorningGreeting({ store, onMorning }) {
  function schedule() {
    const when = nextMorning(new Date(), store.lastMorning());
    console.log(`[morning] next greeting at ${when.toLocaleString("ko-KR")}`);
    setTimeout(() => {
      store.setLastMorning(dateKey(new Date()));
      onMorning();
      schedule();
    }, when - Date.now()).unref();
  }
  schedule();
}
