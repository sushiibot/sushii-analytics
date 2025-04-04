import { type ConfigType } from "../config/config";

const DEFAULT_BATCH_TIMEOUT = 1000 * 30; // 30 seconds

export class BotConfig {
  public readonly logLevel: string;
  public readonly discordToken: string;

  public readonly databaseUri: string;

  public readonly batchSize: number;
  public readonly batchTimeoutMs: number;

  constructor(
    logLevel: string,
    discordToken: string,
    databaseUri: string,
    batchSize: number = 100,
    batchTimeoutMs: number = DEFAULT_BATCH_TIMEOUT
  ) {
    this.logLevel = logLevel;
    this.discordToken = discordToken;
    this.databaseUri = databaseUri;

    this.batchSize = batchSize;
    this.batchTimeoutMs = batchTimeoutMs;
  }

  static fromConfigType(config: ConfigType): BotConfig {
    return new BotConfig(
      config.LOG_LEVEL,
      config.DISCORD_TOKEN,
      config.DATABASE_URI,
      config.BATCH_SIZE,
      config.BATCH_TIMEOUT_MS
    );
  }
}
