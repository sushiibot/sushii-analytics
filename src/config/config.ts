import { z } from "zod";

const configSchema = z.object({
  LOG_LEVEL: z.string().optional().default("info"),
  DISCORD_TOKEN: z.string(),
  DATABASE_URI: z.string(),

  BATCH_SIZE: z.coerce.number().optional(),
  BATCH_TIMEOUT_MS: z.coerce.number().optional(),
});

export type ConfigType = z.infer<typeof configSchema>;

export function getConfigFromEnv(): ConfigType {
  const config = configSchema.safeParse(process.env);

  if (!config.success) {
    throw new Error(`Invalid environment variables: ${config.error}`);
  }

  return config.data;
}
