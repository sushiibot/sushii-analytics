import type { FileKind } from "../store/tables";
import { Deltas, type Value } from "./deltas";
import { DAY_MS, kstDay, kstDayOfMonth, kstMonth, kstYear, utcHour } from "./time";

const LINK_RE = /https?:\/\//;
const MENTION_RE = /<@[!&]?\d+>/;
const THREAD_TYPES = new Set([10, 11, 12]);
const HUMAN_MESSAGE_TYPES = new Set([0, 19]);
const BOOST_MESSAGE_TYPES = new Set([8, 9, 10, 11]);
const FORWARD_REFERENCE_TYPE = 1;
const VIEW_CHANNEL = 1n << 10n;

/** Dispatches with no metric; counted only in ingest coverage. */
const IGNORED = new Set([
  "READY",
  "RESUMED",
  "TYPING_START",
  "GUILD_MEMBER_UPDATE",
  "GUILD_MEMBERS_CHUNK",
  "PRESENCE_UPDATE",
  "GUILD_BAN_ADD",
  "GUILD_BAN_REMOVE",
  "THREAD_MEMBERS_UPDATE",
  "THREAD_MEMBER_UPDATE",
  "VOICE_STATE_UPDATE",
  "VOICE_SERVER_UPDATE",
  "VOICE_CHANNEL_STATUS_UPDATE",
  "VOICE_CHANNEL_START_TIME_UPDATE",
  "GUILD_APPLIED_BOOSTS_UPDATE",
  "GUILD_SCHEDULED_EVENT_UPDATE",
  "GUILD_SCHEDULED_EVENT_DELETE",
  "GUILD_SCHEDULED_EVENT_USER_REMOVE",
  "GUILD_ROLE_CREATE",
  "GUILD_ROLE_UPDATE",
  "GUILD_ROLE_DELETE",
  "GUILD_STICKERS_UPDATE",
  "GUILD_SOUNDBOARD_SOUND_CREATE",
  "GUILD_SOUNDBOARD_SOUND_UPDATE",
  "GUILD_SOUNDBOARD_SOUND_DELETE",
  "GUILD_SOUNDBOARD_SOUNDS_UPDATE",
  "SOUNDBOARD_SOUNDS",
  "GUILD_INTEGRATIONS_UPDATE",
  "INTEGRATION_CREATE",
  "INTEGRATION_UPDATE",
  "INTEGRATION_DELETE",
  "WEBHOOKS_UPDATE",
  "INVITE_CREATE",
  "INVITE_DELETE",
  "STAGE_INSTANCE_CREATE",
  "STAGE_INSTANCE_UPDATE",
  "STAGE_INSTANCE_DELETE",
  "CHANNEL_PINS_UPDATE",
  "MESSAGE_REACTION_REMOVE_ALL",
  "MESSAGE_REACTION_REMOVE_EMOJI",
  "AUTO_MODERATION_RULE_CREATE",
  "AUTO_MODERATION_RULE_UPDATE",
  "AUTO_MODERATION_RULE_DELETE",
  "AUTO_MODERATION_ACTION_EXECUTION",
  "INTERACTION_CREATE",
  "ENTITLEMENT_CREATE",
  "ENTITLEMENT_UPDATE",
  "ENTITLEMENT_DELETE",
  "APPLICATION_COMMAND_PERMISSIONS_UPDATE",
  "USER_UPDATE",
  "GUILD_DELETE",
]);

class Lru {
  private readonly seen = new Map<string, true>();
  constructor(private readonly max: number) {}

  /** Returns true the first time a key is seen within the window. */
  add(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.set(key, true);
    if (this.seen.size > this.max) {
      this.seen.delete(this.seen.keys().next().value!);
    }
    return true;
  }
}

function isPrivate(guildId: string, channel: any): boolean {
  const everyone = Array.isArray(channel.permission_overwrites)
    ? channel.permission_overwrites.find((o: any) => o?.id === guildId)
    : undefined;
  if (!everyone?.deny) return false;
  try {
    return (BigInt(everyone.deny) & VIEW_CHANNEL) !== 0n;
  } catch {
    return true;
  }
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function parseTime(iso: unknown, fallback: number): number {
  if (typeof iso !== "string") return fallback;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

/**
 * Turns raw gateway dispatches into counter deltas. Holds no user data beyond
 * short dedupe windows and the current emoji list per guild.
 */
export class Aggregator {
  deltas = new Deltas();

  private readonly seenMessages = new Lru(20_000);
  private readonly seenEdits = new Lru(20_000);
  private readonly knownEmojis = new Map<string, Set<string>>();
  /** Users who asked for deletion; no per-member data is recorded for them. */
  private forgotten = new Set<string>();

  setForgotten(userIds: Set<string>): void {
    this.forgotten = userIds;
    for (const { file, deltas } of this.deltas.files.values()) {
      if (file === "members") deltas.removeUsers(userIds);
    }
  }

  /** Swaps out pending deltas for flushing. */
  take(): Deltas {
    const out = this.deltas;
    this.deltas = new Deltas();
    return out;
  }

  private file(t: number, file: FileKind) {
    return this.deltas.for(kstYear(t), file);
  }

  private guildHourly(t: number, guildId: string, vals: Record<string, Value>) {
    this.file(t, "guild").upsert("guild_hourly", [guildId, utcHour(t)], vals);
  }

  private guildDaily(t: number, guildId: string, vals: Record<string, Value>) {
    this.file(t, "guild").upsert("guild_daily", [guildId, kstDay(t)], vals);
  }

  apply(type: string, d: any, t: number): void {
    this.file(t, "guild").upsert("ingest_coverage_hourly", [utcHour(t)], { events: 1 });

    if (IGNORED.has(type) || d == null) return;

    switch (type) {
      case "MESSAGE_CREATE":
        return this.messageCreate(d, t);
      case "MESSAGE_UPDATE":
        return this.messageUpdate(d, t);
      case "MESSAGE_DELETE":
        if (d.guild_id) this.guildHourly(t, d.guild_id, { deletes: 1 });
        return;
      case "MESSAGE_DELETE_BULK":
        if (d.guild_id) {
          this.guildHourly(t, d.guild_id, {
            bulk_delete_events: 1,
            bulk_deleted_msgs: Array.isArray(d.ids) ? d.ids.length : 0,
          });
        }
        return;
      case "MESSAGE_REACTION_ADD":
        return this.reactionAdd(d, t);
      case "MESSAGE_REACTION_REMOVE":
        if (d.guild_id) this.guildHourly(t, d.guild_id, { reactions_remove: 1 });
        return;
      case "MESSAGE_POLL_VOTE_ADD":
        if (d.guild_id) this.guildHourly(t, d.guild_id, { poll_votes_add: 1 });
        return;
      case "MESSAGE_POLL_VOTE_REMOVE":
        if (d.guild_id) this.guildHourly(t, d.guild_id, { poll_votes_remove: 1 });
        return;
      case "GUILD_MEMBER_ADD":
        return this.memberAdd(d, t);
      case "GUILD_MEMBER_REMOVE":
        return this.memberRemove(d, t);
      case "GUILD_AUDIT_LOG_ENTRY_CREATE":
        if (d.guild_id && typeof d.action_type === "number") {
          this.file(t, "guild").upsert("mod_daily", [d.guild_id, kstDay(t), d.action_type], {
            n: 1,
          });
        }
        return;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "THREAD_UPDATE":
        if (d.guild_id) this.channel(d.guild_id, d, t);
        return;
      case "THREAD_CREATE":
        if (d.guild_id) {
          this.channel(d.guild_id, d, t);
          if (d.newly_created) this.guildDaily(t, d.guild_id, { threads_created: 1 });
        }
        return;
      case "THREAD_LIST_SYNC":
        if (d.guild_id && Array.isArray(d.threads)) {
          for (const th of d.threads) this.channel(d.guild_id, th, t);
        }
        return;
      case "CHANNEL_DELETE":
      case "THREAD_DELETE":
        if (d.guild_id && d.id) {
          this.file(t, "guild").upsert("channels", [d.guild_id, d.id], {
            deleted_day: kstDay(t),
          });
        }
        return;
      case "GUILD_CREATE":
        return this.guildCreate(d, t);
      case "GUILD_UPDATE":
        if (d.id) {
          this.guildDaily(t, d.id, {
            premium_count: d.premium_subscription_count ?? null,
            premium_tier: d.premium_tier ?? null,
            role_count: Array.isArray(d.roles) ? d.roles.length : null,
          });
        }
        return;
      case "GUILD_EMOJIS_UPDATE":
        if (d.guild_id && Array.isArray(d.emojis)) this.emojis(d.guild_id, d.emojis, t);
        return;
      case "GUILD_SCHEDULED_EVENT_CREATE":
        if (d.guild_id) this.guildDaily(t, d.guild_id, { sched_events_created: 1 });
        return;
      case "GUILD_SCHEDULED_EVENT_USER_ADD":
        if (d.guild_id) this.guildDaily(t, d.guild_id, { sched_event_interest_adds: 1 });
        return;
      default:
        this.file(t, "guild").upsert("unknown_events_daily", [kstDay(t), type], { n: 1 });
    }
  }

  private messageCreate(d: any, t: number) {
    const guildId: string | undefined = d.guild_id;
    if (!guildId) return;
    if (d.id && !this.seenMessages.add(d.id)) return;

    const isBot = Boolean(d.author?.bot || d.webhook_id);
    const vals: Record<string, Value> = { messages: 1 };
    if (isBot) vals.bot_messages = 1;

    if (typeof d.content === "string") {
      vals.msgs_with_content = 1;
      vals.total_length = codePoints(d.content);
      if (d.content.length > 0) {
        vals.msgs_nonempty = 1;
        if (LINK_RE.test(d.content)) vals.msgs_with_links = 1;
        if (MENTION_RE.test(d.content)) vals.msgs_with_mentions = 1;
      }
    }
    if (d.message_reference) {
      vals.replies = 1;
      if (d.message_reference.type === FORWARD_REFERENCE_TYPE) vals.forwards = 1;
    }
    if (Array.isArray(d.attachments) && d.attachments.length > 0) {
      vals.msgs_with_attachments = 1;
      vals.attachments = d.attachments.length;
    }
    if (d.poll) vals.polls_created = 1;
    this.guildHourly(t, guildId, vals);

    if (d.channel_id) {
      this.file(t, "guild").upsert(
        "channel_hourly",
        [guildId, d.channel_id, utcHour(t)],
        isBot ? { messages: 1, bot_messages: 1 } : { messages: 1 }
      );
    }
    if (BOOST_MESSAGE_TYPES.has(d.type)) this.guildDaily(t, guildId, { boost_msgs: 1 });

    const userId: string | undefined = d.author?.id;
    if (!isBot && userId && HUMAN_MESSAGE_TYPES.has(d.type ?? 0) && !this.forgotten.has(userId)) {
      const members = this.file(t, "members");
      members.upsert("member_monthly", [guildId, userId, kstMonth(t)], {
        messages: 1,
        active_day_mask: 1 << kstDayOfMonth(t),
      });
      members.summaryOps.push({ kind: "activity", guildId, userId, t });
    }
  }

  private messageUpdate(d: any, t: number) {
    if (!d.guild_id) return;
    const vals: Record<string, Value> = { edits: 1 };
    // Unfurls, pins and flag changes also emit MESSAGE_UPDATE; only a set
    // edited_timestamp is a user edit, and repeats of the same edit are deduped.
    if (d.edited_timestamp && this.seenEdits.add(`${d.id}:${d.edited_timestamp}`)) {
      vals.edits_user = 1;
    }
    this.guildHourly(t, d.guild_id, vals);
  }

  private reactionAdd(d: any, t: number) {
    if (!d.guild_id) return;
    const vals: Record<string, Value> = { reactions_add: 1 };
    if (d.member?.user?.bot) vals.reactions_add_bot = 1;
    if (d.burst) vals.reactions_add_burst = 1;
    this.guildHourly(t, d.guild_id, vals);

    const emoji = d.emoji;
    const key = emoji?.id ?? emoji?.name;
    if (key) {
      this.file(t, "guild").upsert("emoji_daily", [d.guild_id, kstDay(t), key], {
        emoji_id: emoji.id ?? null,
        emoji_name: emoji.name ?? null,
        reactions: 1,
      });
    }
  }

  private memberAdd(d: any, t: number) {
    if (!d.guild_id) return;
    this.guildHourly(t, d.guild_id, { joins: 1 });
    const userId = d.user?.id;
    if (userId && !d.user.bot && !this.forgotten.has(userId)) {
      const joinedAt = parseTime(d.joined_at, t);
      // Discord can resend GUILD_MEMBER_ADD for existing members with their
      // original join date; those are not new joins for cohort purposes.
      if (Math.abs(t - joinedAt) <= DAY_MS) {
        this.file(t, "members").summaryOps.push({
          kind: "join",
          guildId: d.guild_id,
          userId,
          joinedAt,
        });
      }
    }
  }

  private memberRemove(d: any, t: number) {
    if (!d.guild_id) return;
    this.guildHourly(t, d.guild_id, { leaves: 1 });
    const userId = d.user?.id;
    if (userId && !d.user.bot && !this.forgotten.has(userId)) {
      this.file(t, "members").summaryOps.push({
        kind: "leave",
        guildId: d.guild_id,
        userId,
        t,
      });
    }
  }

  private channel(guildId: string, c: any, t: number) {
    if (!c?.id) return;
    let name: string | null = null;
    // Thread names are user-written text, and private channels can be named after
    // a person (tickets, modmail). Neither is stored; "" also clears a stored name.
    if (!THREAD_TYPES.has(c.type)) name = isPrivate(guildId, c) ? "" : (c.name ?? null);
    this.file(t, "guild").upsert("channels", [guildId, c.id], {
      type: typeof c.type === "number" ? c.type : null,
      parent_id: c.parent_id ?? null,
      name,
      first_seen_day: kstDay(t),
    });
  }

  private emojis(guildId: string, list: any[], t: number) {
    const day = kstDay(t);
    const guild = this.file(t, "guild");
    const current = new Set<string>();
    for (const e of list) {
      if (!e?.id) continue;
      current.add(e.id);
      guild.upsert("guild_emoji", [guildId, e.id], {
        name: e.name ?? null,
        animated: e.animated ? 1 : 0,
        first_seen_day: day,
      });
    }
    const previous = this.knownEmojis.get(guildId);
    if (previous) {
      for (const id of previous) {
        if (!current.has(id)) guild.upsert("guild_emoji", [guildId, id], { deleted_day: day });
      }
    }
    this.knownEmojis.set(guildId, current);
  }

  private guildCreate(d: any, t: number) {
    if (!d.id || d.unavailable) return;
    for (const c of d.channels ?? []) this.channel(d.id, c, t);
    for (const th of d.threads ?? []) this.channel(d.id, th, t);
    if (Array.isArray(d.emojis)) this.emojis(d.id, d.emojis, t);
    this.guildDaily(t, d.id, {
      member_count: d.member_count ?? null,
      premium_count: d.premium_subscription_count ?? null,
      premium_tier: d.premium_tier ?? null,
      channel_count: Array.isArray(d.channels) ? d.channels.length : null,
      role_count: Array.isArray(d.roles) ? d.roles.length : null,
    });
  }

  /** Records a guild snapshot from the client cache (live only). */
  snapshot(
    guildId: string,
    t: number,
    s: {
      memberCount: number;
      premiumCount: number | null;
      premiumTier: number;
      channelCount: number;
      roleCount: number;
    }
  ): void {
    this.guildDaily(t, guildId, {
      member_count: s.memberCount,
      premium_count: s.premiumCount,
      premium_tier: s.premiumTier,
      channel_count: s.channelCount,
      role_count: s.roleCount,
    });
  }

  recordReadySample(t: number): void {
    this.file(t, "guild").upsert("ingest_coverage_hourly", [utcHour(t)], { ready_samples: 1 });
  }
}
