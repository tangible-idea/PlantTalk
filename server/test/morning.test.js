import assert from "node:assert/strict";
import { test } from "node:test";
import { dateKey, nextMorning } from "../src/morning.js";

const local = (h, m = 0, day = 28) => new Date(2026, 9, day, h, m);

test("before 7 picks a time between 7 and 9 today", () => {
  const when = nextMorning(local(5), undefined, () => 0.5);
  assert.deepEqual(when, local(8));
});

test("inside the window picks from the remaining time today", () => {
  const when = nextMorning(local(8, 0), undefined, () => 0);
  assert.deepEqual(when, local(8, 1)); // 최소 1분 뒤
  assert.ok(nextMorning(local(8, 0), undefined, () => 0.999) < local(9));
});

test("already greeted today or past 9 waits for tomorrow", () => {
  assert.deepEqual(nextMorning(local(7, 30), dateKey(local(7)), () => 0), local(7, 0, 29));
  assert.deepEqual(nextMorning(local(10), undefined, () => 1), local(9, 0, 29));
});
