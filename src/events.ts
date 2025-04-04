import { Events, type Client, type GatewayDispatchPayload } from "discord.js";
import type { DB } from "./database/db";
import { getLogger } from "./logger";
import type { BotConfig } from "./models/botConfig.model";
import { EventBuffer } from "./EventBuffer";

export function registerEventHandlers(
  config: BotConfig,
  client: Client,
  db: DB
) {
  const logger = getLogger("events");

  const eventBuffer = new EventBuffer(
    db,
    config.batchSize,
    config.batchTimeoutMs
  );

  client.once(Events.ClientReady, () => {
    logger.info(`Bot is online! ${client.user?.tag}`);
    // https://discord.com/oauth2/authorize?client_id=1111130119566790758&permissions=563362270660672&integration_type=0&scope=applications.commands+bot

    const inviteLink = `https://discord.com/oauth2/authorize?client_id=${client.user?.id}&permissions=563362270660672&integration_type=0&scope=applications.commands+bot`;
    logger.info(`Invite link: ${inviteLink}`);
  });

  client.on(Events.Raw, async (event: GatewayDispatchPayload) => {
    eventBuffer.add(event);
  });
}
