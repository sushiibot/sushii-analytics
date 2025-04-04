import { type GatewayDispatchPayload } from "discord.js";
import type { DB } from "./database/db";
import { getLogger } from "./logger";
import { events } from "./database/schema";

function removeCircularReference<T extends Record<string, any>>(obj: T): T {
  const seen = new WeakSet();

  const recurse = (current: Record<string, any>): void => {
    seen.add(current);

    for (const [k, v] of Object.entries(current)) {
      if (v !== null && typeof v === "object") {
        if (seen.has(v)) {
          delete current[k];
        } else {
          recurse(v);
        }
      }
    }
  };

  // Create a deep copy to avoid modifying the original object
  const copy = JSON.parse(JSON.stringify(obj)) as T;
  recurse(copy);

  return copy;
}

type BufferItem = {
  event: GatewayDispatchPayload;
  timestamp: number;
};

export class EventBuffer {
  private db: DB;
  private buffer: BufferItem[] = [];

  // First one to be reached will flush
  private maxBufferLength: number;
  private timeoutMs: number;

  private logger = getLogger(this.constructor.name);

  constructor(db: DB, maxBufferLength: number, timeoutMs: number) {
    this.db = db;
    this.maxBufferLength = maxBufferLength;
    this.timeoutMs = timeoutMs;

    this.startFlusher();
  }

  startFlusher() {
    this.logger.info(
      {
        maxBufferLength: this.maxBufferLength,
        timeoutMs: this.timeoutMs,
      },
      `Starting event buffer timeout loop`
    );

    // Start the flush interval
    setInterval(async () => {
      if (this.buffer.length === 0) {
        this.logger.debug("Buffer is empty, skipping flush");
        return;
      }

      this.logger.debug(
        { bufferLength: this.buffer.length },
        `Flush interval triggered, flushing events to the database`
      );

      await this.flush();
    }, this.timeoutMs);
  }

  add(event: GatewayDispatchPayload) {
    this.buffer.push({
      event,
      timestamp: Date.now(),
    });

    // If the buffer is full, flush it immediately instead of waiting for the interval
    if (this.buffer.length >= this.maxBufferLength) {
      this.logger.info(
        { eventCount: this.buffer.length },
        `Buffer is full, immediately flushing events`
      );

      this.flush();
    }
  }

  async flush() {
    const startTime = Date.now();
    this.logger.info(
      {
        eventCount: this.buffer.length,
      },
      `Flushing events to the database`
    );

    // Create a copy of the buffer and clear it immediately to prevent double processing
    const bufferToProcess = [...this.buffer];
    this.buffer = [];

    // Dump to DB
    const values: (typeof events.$inferInsert)[] = [];

    for (const item of bufferToProcess) {
      try {
        // Remove any cyclic references from the payload
        const cleanedPayload = removeCircularReference(item.event.d);

        values.push({
          time: item.timestamp,
          type: item.event.t,
          // Don't stringify the payload, store directly as JSON for JSONB
          payload: cleanedPayload,
        });
      } catch (err) {
        this.logger.error(
          { err, eventType: item.event.t },
          "Failed to stringify event payload"
        );
        // Continue processing other events instead of throwing
      }
    }

    if (values.length > 0) {
      await this.db.insert(events).values(values).execute();
    }

    const endTime = Date.now();

    this.logger.info(
      {
        durationMs: endTime - startTime,
        eventCount: bufferToProcess.length,
      },
      `Flushed events to the database`
    );
  }
}
