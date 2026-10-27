import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, detectEvents, nextSleepSeconds } from "../src/status.js";

const basil = { id: "basil", name: "Basil", thresholds: { dry: 25, thirsty: 45, soggy: 85 } };

test("classify uses plant thresholds", () => {
  assert.equal(classify(basil, 10), "dry");
  assert.equal(classify(basil, 30), "thirsty");
  assert.equal(classify(basil, 60), "ok");
  assert.equal(classify(basil, 90), "soggy");
  assert.equal(classify({ id: "x", name: "X" }, 30), "thirsty"); // 기본값
});

test("first reading announces connection", () => {
  const events = detectEvents(basil, undefined, { moisture: 50, status: "ok", battery: 90 });
  assert.equal(events.length, 1);
  assert.match(events[0], /처음 연결/);
});

test("watering wins over a plain status change", () => {
  const events = detectEvents(
    basil,
    { moisture: 20, status: "dry", battery: 90 },
    { moisture: 70, status: "ok", battery: 90 },
  );
  assert.equal(events.length, 1);
  assert.match(events[0], /물을 준/);
});

test("status change and low battery are both reported", () => {
  const events = detectEvents(
    basil,
    { moisture: 47, status: "ok", battery: 20 },
    { moisture: 43, status: "thirsty", battery: 10 },
  );
  assert.equal(events.length, 2);
});

test("no event when nothing changed", () => {
  const prev = { moisture: 60, status: "ok", battery: 90 };
  assert.deepEqual(detectEvents(basil, prev, { moisture: 58, status: "ok", battery: 90 }), []);
});

test("drier plants are checked more often", () => {
  assert.ok(nextSleepSeconds("dry") < nextSleepSeconds("ok"));
});
