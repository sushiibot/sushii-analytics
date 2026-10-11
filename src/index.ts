import { setupOtel } from "./instrumentation";

const otel = setupOtel();

import { Client, GatewayIntentBits, Options } from "discord.js";
import { getConfigFromEnv } from "./config/config";
import { startLive } from "./live";
import logger, { initLogger } from "./logger";

async function main() {
  const config = getConfigFromEnv();
  initLogger(config.LOG_LEVEL);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // Joins and leaves
      GatewayIntentBits.GuildMembers,
      // Audit log entries: bans, kicks, unbans
      GatewayIntentBits.GuildModeration,
      // Emoji list for server-specific emoji filtering
      GatewayIntentBits.GuildExpressions,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      // Length, link and mention counts; text is never stored
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildScheduledEvents,
      GatewayIntentBits.GuildMessagePolls,
    ],
    // Everything is read from raw dispatches, so keep discord.js caches small.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      ReactionManager: 0,
      GuildMemberManager: { maxSize: 0, keepOverLimit: (m) => m.id === m.client.user.id },
      UserManager: { maxSize: 0, keepOverLimit: (u) => u.id === u.client.user.id },
      PresenceManager: 0,
      VoiceStateManager: 0,
    }),
  });

  let exiting = false;
  const exit = async (code: number) => {
    if (exiting) return;
    exiting = true;
    await live.shutdown();
    await otel.shutdown().catch(() => {});
    process.exit(code);
  };

  const live = startLive(client, {
    dataDir: config.DATA_DIR,
    flushIntervalMs: config.FLUSH_INTERVAL_MS,
    watchdogMs: config.WATCHDOG_MS,
    onFatal: () => void exit(1),
  });

  process.on("SIGTERM", () => void exit(0));
  process.on("SIGINT", () => void exit(0));

  await client.login(config.DISCORD_TOKEN);
}

main().catch(async (err) => {
  logger.fatal({ err }, "Failed to start");
  await otel.shutdown().catch(() => {});
  process.exit(1);
});
