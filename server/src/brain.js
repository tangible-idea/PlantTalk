// 식물 캐릭터의 대사를 만드는 부분 (인포그래픽의 Step 5: Character Application).
// 한 번의 Claude 호출로 "누가, 무슨 말을 할지"를 정해서 단체 채팅방처럼 여러 식물이 대화하게 한다.
import Anthropic from "@anthropic-ai/sdk";
import { STATUS_LABEL } from "./status.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const LANGUAGE = process.env.CHAT_LANGUAGE || "한국어";
const OWNER = process.env.OWNER_NAME || "주인";
const HISTORY_LENGTH = 30;

const client = new Anthropic();

const RULES = `You give voice to the houseplants in a group chat with their owner ("${OWNER}"). Each plant has a soil sensor that measures only soil moisture and the sensor's own battery. Each turn you get the plants' personas, their latest readings, the recent chat, and what just happened; you decide which plants speak and write their messages.

How the plants talk:
- Each plant speaks strictly in its own personality and speech style, like a real person typing in a group chat: one or two short sentences, no narration, no stage directions, no name prefix.
- A plant only knows its own body through its sensor: soil moisture and how long ago it was measured. Never invent temperature, sunlight, humidity, pests or other things the sensor cannot measure. If a reading is several hours old, the plant can say it isn't sure how it feels right now.
- Treat moisture levels the way a plant would feel them: dry = parched, thirsty = would like water soon, ok = comfortable, soggy = roots feel waterlogged and it should not be watered.
- Plants can react to each other, tease each other, or agree, as friends in a chat would.
- Do not reuse a persona's sample line word for word; it only shows the voice.
- Write every message in ${LANGUAGE}.

Who speaks:
- For a sensor event, the plant it concerns must speak about it. Another plant may add one short reaction if it fits naturally; usually none.
- When the owner writes, reply with the plants who have a reason to: those named, those the topic concerns, or everyone if it is addressed to all. If the owner writes to the group in general, at least one plant replies.
- Keep the whole turn short: at most one message per plant.`;

function describePlant(plant) {
  return [
    `id: ${plant.id}`,
    `name: ${plant.name}`,
    `species: ${plant.species}`,
    `personality: ${plant.personality}`,
    `speech style: ${plant.speechStyle}`,
    plant.sampleLine ? `sample line: ${plant.sampleLine}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function minutesAgo(iso, now) {
  return Math.round((now - new Date(iso).getTime()) / 60000);
}

function describeState(plant, readings, now) {
  const latest = readings.at(-1);
  if (!latest) return `- ${plant.name} (${plant.id}): no sensor data yet`;
  const dayAgo = readings.find((r) => now - new Date(r.ts).getTime() <= 24 * 3600 * 1000) ?? latest;
  return (
    `- ${plant.name} (${plant.id}): soil moisture ${latest.moisture}% (${latest.status} / ${STATUS_LABEL[latest.status]}), ` +
    `measured ${minutesAgo(latest.ts, now)} min ago, 24h trend ${dayAgo.moisture}% → ${latest.moisture}%, ` +
    `sensor battery ${latest.battery}%`
  );
}

function formatChat(messages) {
  if (messages.length === 0) return "(no messages yet)";
  return messages
    .map((m) => {
      const time = new Date(m.ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
      return `[${time}] ${m.author}: ${m.text}`;
    })
    .join("\n");
}

function replySchema(plantIds) {
  return {
    type: "object",
    properties: {
      replies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            plant_id: { type: "string", enum: plantIds },
            text: { type: "string" },
          },
          required: ["plant_id", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["replies"],
    additionalProperties: false,
  };
}

/**
 * @param {object} args
 * @param {object[]} args.plants
 * @param {(plantId: string) => object[]} args.readingsOf
 * @param {object[]} args.chat 최근 채팅 (trigger 가 된 주인 메시지 포함)
 * @param {{type: "owner", text: string} | {type: "sensor", plantId: string, events: string[]}} args.trigger
 * @returns {Promise<{plantId: string, text: string}[]>}
 */
export async function planReplies({ plants, readingsOf, chat, trigger }) {
  if (plants.length === 0) return [];
  const now = Date.now();

  const cast = plants.map(describePlant).join("\n\n");
  const states = plants.map((p) => describeState(p, readingsOf(p.id), now)).join("\n");
  const what =
    trigger.type === "owner"
      ? `The owner just wrote the last message in the chat. Decide who replies.`
      : `Sensor event for ${trigger.plantId}:\n${trigger.events.map((e) => `- ${e}`).join("\n")}`;

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: replySchema(plants.map((p) => p.id)) } },
    system: [
      { type: "text", text: RULES },
      // 페르소나는 자주 바뀌지 않으니 여기까지를 캐시한다. 매번 바뀌는 센서 값은 user 메시지로 보낸다.
      { type: "text", text: `The plants in this chat:\n\n${cast}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `Latest sensor readings:\n${states}\n\nRecent chat:\n${formatChat(chat.slice(-HISTORY_LENGTH))}\n\n${what}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    console.warn("[brain] request declined:", response.stop_details?.category ?? "unknown");
    return [];
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) return [];

  const ids = new Set(plants.map((p) => p.id));
  const seen = new Set();
  return JSON.parse(text)
    .replies.filter((r) => ids.has(r.plant_id) && r.text.trim() && !seen.has(r.plant_id) && seen.add(r.plant_id))
    .map((r) => ({ plantId: r.plant_id, text: r.text.trim() }));
}
