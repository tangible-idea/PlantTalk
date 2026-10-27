// 센서 이벤트와 주인 메시지를 받아 식물들의 답장을 만들고, 연결된 모든 메신저로 내보낸다.
// (인포그래픽의 Step 6: Messenger Conversation)

/**
 * 메신저 어댑터 인터페이스
 *   name: string
 *   start(onOwnerMessage: ({author, text}) => void): Promise<void>
 *   sendAsPlant(plant, text): Promise<void>
 *   relayOwner?(author, text): Promise<void>   다른 채널에서 온 주인 메시지를 이 채널에도 보여줄 때
 */
export function createHub({ store, planReplies, messengers }) {
  // Claude 호출이 겹치면 식물들이 서로의 답을 못 보고 말하게 되므로 한 번에 하나씩 처리한다.
  let queue = Promise.resolve();
  const enqueue = (job) => {
    queue = queue.then(job).catch((err) => console.error("[hub] reply failed:", err.message));
    return queue;
  };

  async function speak(trigger) {
    const plants = store.plants();
    const replies = await planReplies({
      plants,
      readingsOf: (id) => store.readings(id),
      chat: store.recentChat(30),
      trigger,
    });
    for (const { plantId, text } of replies) {
      const plant = store.plant(plantId);
      store.addChat({ role: "plant", plantId, author: plant.name, text });
      await Promise.allSettled(
        messengers.map((m) =>
          m.sendAsPlant(plant, text).catch((err) => console.error(`[${m.name}] send failed:`, err.message)),
        ),
      );
    }
  }

  const hub = {
    async start() {
      for (const m of messengers) {
        await m.start(({ author, text }) => hub.ownerMessage({ author, text, source: m.name }));
        console.log(`[hub] messenger started: ${m.name}`);
      }
    },

    ownerMessage({ author, text, source }) {
      store.addChat({ role: "owner", author, text, source });
      for (const m of messengers) {
        if (m.name !== source && m.relayOwner) {
          m.relayOwner(author, text).catch((err) => console.error(`[${m.name}] relay failed:`, err.message));
        }
      }
      return enqueue(() => speak({ type: "owner", text }));
    },

    sensorEvents(plant, events) {
      return enqueue(() => speak({ type: "sensor", plantId: plant.id, events }));
    },
  };
  return hub;
}
