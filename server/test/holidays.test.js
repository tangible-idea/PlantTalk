import assert from "node:assert/strict";
import { test } from "node:test";
import { dayInfo, describeDay } from "../src/holidays.js";

const holidays = [
  { date: "2026-10-09", name: "한글날" },
  { date: "2026-12-25", name: "크리스마스" },
];

test("a normal weekday points to the next holiday", () => {
  const info = dayInfo(new Date(2026, 9, 28, 10), holidays);
  assert.equal(info.today.weekday, "수요일");
  assert.equal(info.today.holiday, null);
  assert.deepEqual(info.next, { date: "2026-12-25", name: "크리스마스", daysUntil: 58 });
  assert.match(describeDay(info), /today: 2026-10-28 수요일 \(working day\)/);
});

test("holidays and weekends count as days off", () => {
  const text = describeDay(dayInfo(new Date(2026, 9, 9, 10), holidays));
  assert.match(text, /today: 2026-10-09 금요일 \(day off: 한글날\)/);
  assert.match(text, /tomorrow: 2026-10-10 토요일 \(day off: weekend\)/);
});
