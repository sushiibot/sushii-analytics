import { z } from "zod";

const configSchema = z.object({
  LOG_LEVEL: z.string().optional().default("info"),
  DISCORD_TOKEN: z.string(),
  // Year files live at <DATA_DIR>/<year>/{guild,members}.sqlite
  DATA_DIR: z.string().optional().default("./data/v2"),
  FLUSH_INTERVAL_MS: z.coerce.number().optional().default(30_000),
  // Exit (and let Docker restart) if the gateway goes silent this long.
  WATCHDOG_MS: z.coerce.number().optional().default(10 * 60_000),
});

export type ConfigType = z.infer<typeof configSchema>;

export function getConfigFromEnv(): ConfigType {
  const config = configSchema.safeParse(process.env);

  if (!config.success) {
    throw new Error(`Invalid environment variables: ${config.error}`);
  }

  return config.data;
}
