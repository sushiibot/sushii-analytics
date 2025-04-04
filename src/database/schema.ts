import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  blob,
  index,
} from "drizzle-orm/sqlite-core";

export const events = sqliteTable(
  "events",
  {
    time: integer()
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),

    // Gateway type
    type: text().notNull(),
    // Json payload
    payload: blob({ mode: "json" }).notNull(),

    // Extracted fields
    guildId: text().generatedAlwaysAs(sql`payload -> 'guild_id'`, {
      mode: "stored",
    }),
  },
  (table) => [
    index("idx_event_type").on(table.type),
    index("idx_event_guild_id").on(table.guildId),
  ]
);
