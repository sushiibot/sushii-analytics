import { metrics } from "@opentelemetry/api";
import { Events, type Client, type GatewayDispatchPayload } from "discord.js";
import fs from "node:fs";
import { Aggregator } from "./aggregate/aggregator";
import { flush } from "./store/flush";
import { loadSuppressed, openPrivacyDb } from "./store/privacy";
import { Store, filePath } from "./store/store";
import { getLogger } from "./logger";

// Gateway close codes after which the connection is never retried.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const SNAPSHOT_INTERVAL_MS = 30 * 60_000;
const RETENTION_CHECK_INTERVAL_MS = 60 * 60_000;

/**
 * Deletion deadlines (Feb 1 00:00 KST): a year's members file by the next
 * year, its guild file two years later. Returns overdue files as "year/file".
 */
export function overdueFiles(dataDir: string, now: number): string[] {
  const years = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter((n) => /^\d{4}$/.test(n)).map(Number)
    : [];
  const deadline = (year: number) => Date.UTC(year, 0, 31, 15);
  const out: string[] = [];
  for (const y of years) {
    if (now >= deadline(y + 1) && fs.existsSync(filePath(dataDir, y, "members"))) out.push(`${y}/members`);
    if (now >= deadline(y + 2) && fs.existsSync(filePath(dataDir, y, "guild"))) out.push(`${y}/guild`);
  }
  return out;
}

export interface LiveOptions {
  dataDir: string;
  flushIntervalMs: number;
  watchdogMs: number;
  /** Called after a fatal condition so the process can exit and be restarted. */
  onFatal: () => void;
}

export function startLive(client: Client, opts: LiveOptions) {
  const logger = getLogger("live");
  const meter = metrics.getMeter("sushii-analytics");
  const eventsCounter = meter.createCounter("analytics.gateway_events");
  const flushFailures = meter.createCounter("analytics.flush_failures");

  const store = new Store(opts.dataDir);
  const privacy = openPrivacyDb(opts.dataDir);
  const aggregator = new Aggregator();
  aggregator.setForgotten(loadSuppressed(privacy, "forget"));
  let overdue: string[] = [];
  let lastDispatch = Date.now();
  let stopping = false;

  meter
    .createObservableGauge("analytics.last_dispatch_age_seconds")
    .addCallback((r) => r.observe((Date.now() - lastDispatch) / 1000));
  meter
    .createObservableGauge("analytics.retention_overdue_files")
    .addCallback((r) => r.observe(overdue.length));

  const checkRetention = () => {
    overdue = overdueFiles(opts.dataDir, Date.now());
    if (overdue.length > 0) {
      logger.warn({ files: overdue }, "Files are past their deletion date; delete them per the runbook");
    }
  };
  checkRetention();
  const retentionTick = setInterval(checkRetention, RETENTION_CHECK_INTERVAL_MS);

  const exitFatal = (reason: string, extra: Record<string, unknown> = {}) => {
    logger.fatal(extra, reason);
    opts.onFatal();
  };

  client.on(Events.Raw, (packet: GatewayDispatchPayload) => {
    if (stopping || !packet.t) return;
    const now = Date.now();
    lastDispatch = now;
    eventsCounter.add(1, { type: packet.t });
    try {
      aggregator.apply(packet.t, packet.d, now);
    } catch (err) {
      logger.error({ err, type: packet.t }, "Failed to aggregate event");
    }
  });

  const watchedShards = new Set<number>();
  client.on(Events.ShardReady, (shardId) => {
    logger.info({ shardId }, "Shard ready");
    if (watchedShards.has(shardId)) return;
    watchedShards.add(shardId);
    // discord.js reports a mid-session fatal close as "reconnecting", so read the code directly.
    client.ws.shards.get(shardId)?.on("close", (event: { code: number }) => {
      if (FATAL_CLOSE_CODES.has(event.code)) {
        exitFatal("Gateway closed with a fatal code; check token and privileged intent approval", {
          shardId,
          code: event.code,
        });
      } else {
        logger.warn({ shardId, code: event.code }, "Gateway connection closed");
      }
    });
  });
  client.on(Events.ShardDisconnect, (event, shardId) =>
    logger.error({ shardId, code: event.code }, "Shard disconnected and will not reconnect")
  );
  client.on(Events.ShardReconnecting, (shardId) => logger.warn({ shardId }, "Shard reconnecting"));
  client.on(Events.ShardResume, (shardId, replayed) =>
    logger.info({ shardId, replayed }, "Shard resumed")
  );
  client.on(Events.ShardError, (err, shardId) => logger.error({ err, shardId }, "Shard error"));
  client.on(Events.Invalidated, () => exitFatal("Client session invalidated"));
  // discord.js reports outages as guildUnavailable, so this fires only on removal.
  client.on(Events.GuildDelete, (guild) =>
    logger.warn({ guildId: guild.id }, "Removed from guild; delete its data per the runbook")
  );
  client.on(Events.Warn, (message) => logger.warn({ message }, "discord.js warning"));
  client.on(Events.Error, (err) => logger.error({ err }, "discord.js error"));

  const doFlush = () => {
    // Picks up deletion requests made with the CLI while the bot is running.
    aggregator.setForgotten(loadSuppressed(privacy, "forget"));
    const pending = aggregator.take();
    if (pending.isEmpty) return;
    const started = Date.now();
    const { failed, errors } = flush(pending, store);
    for (const { year, file, deltas } of failed.files.values()) {
      aggregator.deltas.for(year, file).mergeFrom(deltas);
    }
    for (const { year, file, error } of errors) {
      flushFailures.add(1, { file });
      logger.error({ err: error, year, file }, "Flush failed; deltas kept for retry");
    }
    logger.debug({ durationMs: Date.now() - started }, "Flushed aggregates");
  };

  const tick = setInterval(() => {
    const now = Date.now();
    if (client.ws.status === 0) aggregator.recordReadySample(now);
    doFlush();

    if (now - lastDispatch > opts.watchdogMs) {
      exitFatal("No gateway dispatch received within the watchdog window", {
        lastDispatchAgeMs: now - lastDispatch,
      });
    }
  }, opts.flushIntervalMs);

  const snapshot = () => {
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
      aggregator.snapshot(guild.id, now, {
        memberCount: guild.memberCount,
        premiumCount: guild.premiumSubscriptionCount,
        premiumTier: guild.premiumTier,
        channelCount: guild.channels.cache.size,
        roleCount: guild.roles.cache.size,
      });
    }
  };
  client.once(Events.ClientReady, snapshot);
  const snapshotTick = setInterval(snapshot, SNAPSHOT_INTERVAL_MS);

  let shuttingDown: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      stopping = true;
      clearInterval(tick);
      clearInterval(snapshotTick);
      clearInterval(retentionTick);
      try {
        doFlush();
        if (!aggregator.deltas.isEmpty) logger.error("Final flush incomplete; some counts lost");
      } finally {
        store.close();
        privacy.close();
        await client.destroy().catch(() => {});
      }
    })();
    return shuttingDown;
  };

  return { shutdown };
}
