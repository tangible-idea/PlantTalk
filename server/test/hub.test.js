import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHub } from "../src/hub.js";
import { createStore } from "../src/store.js";

function setup(planReplies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planttalk-"));
  const store = createStore(path.join(dir, "db.json"));
  const sent = [];
  const messenger = {
    name: "fake",
    async start() {},
    async sendAsPlant(plant, text) {
      sent.push(`${plant.name}: ${text}`);
    },
  };
  return { store, sent, hub: createHub({ store, planReplies, messengers: [messenger] }) };
}

test("owner message gets plant replies in chat log and messengers", async () => {
  let seen;
  const { store, sent, hub } = setup(async (args) => {
    seen = args;
    return [{ plantId: "basil", text: "물 줘" }, { plantId: "moni", text: "저도요…" }];
  });

  await hub.ownerMessage({ author: "주인", text: "다들 잘 지내?", source: "web" });

  assert.equal(seen.trigger.type, "owner");
  assert.equal(seen.chat.at(-1).text, "다들 잘 지내?");
  assert.deepEqual(sent, ["Basil: 물 줘", "Moni: 저도요…"]);
  assert.deepEqual(store.recentChat(10).map((m) => m.role), ["owner", "plant", "plant"]);
});

test("a failing Claude call does not break the queue", async () => {
  let calls = 0;
  const { sent, hub } = setup(async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return [{ plantId: "basil", text: "살았다" }];
  });

  await hub.ownerMessage({ author: "주인", text: "1", source: "web" });
  await hub.ownerMessage({ author: "주인", text: "2", source: "web" });
  assert.deepEqual(sent, ["Basil: 살았다"]);
});
