import { getConfigFromEnv } from "./config/config";
import { getDb } from "./database/db";
import { registerEventHandlers } from "./events";
import logger, { initLogger } from "./logger";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { BotConfig } from "./models/botConfig.model";

async function main() {
  const rawConfig = getConfigFromEnv();
  const config = BotConfig.fromConfigType(rawConfig);

  // Update log level from config
  logger.info(`Setting log level to ${config.logLevel}`);
  initLogger(config.logLevel);

  const db = getDb(config.databaseUri);

  const client = new Client({
    intents: [
      // Everything except for DMs
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildExpressions,
      GatewayIntentBits.GuildIntegrations,
      GatewayIntentBits.GuildWebhooks,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildVoiceStates,
      // Presence updates will cause 1GB+ storage per hour
      // GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMessageTyping,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildScheduledEvents,
      GatewayIntentBits.AutoModerationConfiguration,
      GatewayIntentBits.AutoModerationExecution,
      GatewayIntentBits.GuildMessagePolls,
    ],
    // Partials.Channel: Required to receive DMs with Events.MessageCreate
    // Partials.Reaction and Partials.Message: Required to receive reactions on uncached messages
    partials: [Partials.Channel, Partials.Reaction, Partials.Message],
  });

  // Event handlers
  logger.info("Registering event handlers...");
  registerEventHandlers(config, client, db);

  logger.info("Starting Discord client...");

  // Start client, connect to Discord gateway and listen for events
  await client.login(config.discordToken);
}

main().catch((error) => {
  logger.error(error, "An error occurred starting the bot");
});
