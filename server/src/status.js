// 센서 수치 -> 상태 해석 (인포그래픽의 Step 4: State Interpretation)

export const STATUS_LABEL = {
  dry: "바싹 마름",
  thirsty: "목마름",
  ok: "적당함",
  soggy: "과습",
};

const DEFAULT_THRESHOLDS = { dry: 25, thirsty: 45, soggy: 85 };

// 상태별 다음 측정까지의 간격. 마를수록 자주 확인한다.
const SLEEP_SECONDS = { dry: 15 * 60, thirsty: 30 * 60, ok: 60 * 60, soggy: 60 * 60 };
export const DEFAULT_SLEEP_SECONDS = 30 * 60;

const WATERED_JUMP = 15; // 수분이 이만큼 한 번에 오르면 물을 준 것으로 본다
const LOW_BATTERY = 15;

export function classify(plant, moisture) {
  const t = { ...DEFAULT_THRESHOLDS, ...plant.thresholds };
  if (moisture < t.dry) return "dry";
  if (moisture < t.thirsty) return "thirsty";
  if (moisture > t.soggy) return "soggy";
  return "ok";
}

export function nextSleepSeconds(status) {
  return SLEEP_SECONDS[status] ?? DEFAULT_SLEEP_SECONDS;
}

// 이전/현재 측정값을 비교해 채팅방에 알릴 만한 일을 사람이 읽을 문장으로 돌려준다.
// 알릴 게 없으면 빈 배열.
export function detectEvents(plant, prev, curr) {
  if (!prev) {
    return [`${plant.name}의 센서가 처음 연결됐다. 현재 흙 수분 ${curr.moisture}% (${STATUS_LABEL[curr.status]}).`];
  }

  const events = [];
  if (curr.moisture - prev.moisture >= WATERED_JUMP) {
    events.push(`방금 ${plant.name}에게 물을 준 것 같다. 흙 수분 ${prev.moisture}% → ${curr.moisture}%.`);
  } else if (curr.status !== prev.status) {
    events.push(
      `${plant.name}의 흙 상태가 '${STATUS_LABEL[prev.status]}'에서 '${STATUS_LABEL[curr.status]}'(으)로 바뀌었다. ` +
        `흙 수분 ${prev.moisture}% → ${curr.moisture}%.`,
    );
  }
  if (curr.battery < LOW_BATTERY && prev.battery >= LOW_BATTERY) {
    events.push(`${plant.name}의 센서 배터리가 ${curr.battery}%로 얼마 남지 않았다. AA 건전지 교체가 필요하다.`);
  }
  return events;
}
