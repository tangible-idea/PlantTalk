// Discord 단체 채팅 어댑터.
// 봇은 채널의 사람 메시지를 읽기만 하고, 식물들은 webhook 으로 각자의 이름/아바타를 달고 말한다.
import { Client, GatewayIntentBits, WebhookClient } from "discord.js";

export function createDiscordMessenger({ token, channelId, webhookUrl }) {
  const webhook = new WebhookClient({ url: webhookUrl });

  return {
    name: "discord",

    async start(onOwnerMessage) {
      const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      });
      client.on("messageCreate", (msg) => {
        if (msg.channelId !== channelId || msg.author.bot || msg.webhookId || !msg.content.trim()) return;
        onOwnerMessage({ author: msg.member?.displayName ?? msg.author.username, text: msg.content });
      });
      await client.login(token);
    },

    async sendAsPlant(plant, text) {
      await webhook.send({ content: text, username: plant.name, avatarURL: plant.avatarUrl || undefined });
    },

    async relayOwner(author, text) {
      await webhook.send({ content: text, username: `${author} (웹)` });
    },
  };
}
