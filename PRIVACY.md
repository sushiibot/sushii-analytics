# Privacy Policy — sushii-analytics

Last updated: [TODO: publication date]

This policy covers the sushii-analytics Discord application (application ID
1357574696870350969), called "the bot", "we" or "us" below. It does not cover other
sushii bots or services.

sushii-analytics has no commands. It runs in the background in the servers it is added to,
counts activity, and produces an end-of-year "wrapped" style summary for each server's
community.

## Who is responsible

sushii-analytics is run by [TODO: name or handle], [TODO: country]. They are the data
controller. Contact: contact@sushii.xyz.

## Where the data comes from

Discord sends it to the bot. We never ask you for anything directly.

## What the bot receives

The bot receives the data Discord sends for the servers it is in. This includes:

- messages, with their text;
- edits, deletions, reactions and poll votes;
- members joining or leaving, and changes to their roles and nicknames;
- moderation log entries, including who acted, on whom, and the reason given;
- scheduled events and who is interested in them;
- changes to channels, emoji, stickers and server settings.

Anything not listed under "What we store" is discarded as soon as it has been counted.

**Message content is never stored.** Each message is read in memory, counted, and
discarded. From the text we derive only numbers, for example its length and whether it
contains a link or a mention. Message content is never used to train machine learning or AI
models.

## What we store

### Server-level counts (no user IDs)

- Messages per hour, and per channel. Replies, edits, deletions, reactions, attachments,
  polls and joins/leaves are counted per server per hour.
- Reactions per emoji per day. This includes emoji from other servers that members react
  with.
- Audit-log entries per day by type. We don't record who acted or on whom.
- Daily member, boost, channel and role counts. Threads and scheduled events created.
- Channel IDs and types, and names of channels everyone in the server can see. We don't
  store the names of private channels or threads.
- The server's custom emoji IDs and names.
- Monthly figures computed from the per-member counts:
  - how many members were active;
  - the share of messages from the most active 1% and 10%;
  - how many members who joined in a given month posted, stayed or left.

  We don't store these for any group smaller than 5 people.

### Per-member counts

For members who are not bots, we store:

- your Discord user ID, with how many messages you sent and on which days you sent at least
  one, per server and per month;
- if we saw you join a server: when you joined, when you first posted, whether you posted in
  your first weeks, and when you left (if you did).

We do **not** store usernames, display names, nicknames, avatars, message text,
attachments, voice activity or online status.

## What appears in published summaries

We publish the year-end summary to the server's community after its admins agree. It shows
server-wide numbers. It may also list the **most active members** (the top 5 by messages
each month), shown by their current display name. We look up display names from Discord
when we make the summary and do not store them.

## How we use the data

We use the data only to produce activity statistics and the year-end summary for the server
it came from. Data from one server is never combined with or shown in another server's
results. We don't build profiles of people across servers, and we don't use the data to
make decisions about anyone.

We do not sell your information, and we do not share it for advertising.

## Who processes it for us

| Provider | Role | Location |
|---|---|---|
| Hetzner Online GmbH | Server hosting | Germany |
| Backblaze, Inc. | Encrypted backups | United States |

Backups are sent from the EU to the US under [TODO: Backblaze's Data Processing Addendum
with the EU Standard Contractual Clauses — confirm].

Our own monitoring runs on the same Hetzner servers. It keeps operational logs for [TODO: 30, once Loki retention is configured]
days. The logs contain server IDs, but no message content and no user IDs.

## Retention

| Data | How long we keep it |
|---|---|
| Message content | Not stored. It is processed in memory only. |
| Per-member counts | In a separate file for each calendar year, by Korea Standard Time. We delete it by January 31 of the following year, after the summary is made. Statistics for members who joined in late December use the data available up to then. |
| Server-level counts | Up to 2 years, for comparing with the previous year. After that we delete them. |
| Backups | Older backup versions are permanently deleted within 7 days. |

If the bot is removed from a server, it stops collecting immediately. We delete that
server's data within 30 days, or sooner if its admins ask. If sushii-analytics shuts down,
we delete all stored data and backups. If we receive data by mistake, we delete it.

### Data from earlier versions

From April 2025 until [TODO: cutover date], the bot stored every event it received. That
included:

- message text;
- usernames, nicknames and avatars;
- role changes;
- typing and voice activity.

These copies exist on our server, in a backup in the United States, and on the operator's
computer. The backup copy is not encrypted. We are converting this data into the counts
described above. We will delete every copy by [TODO: date] and then update this policy.

## Your rights

You can ask to see, correct or delete the data we hold about you, to restrict how it is
used, or to object to its use.

- **Deletion.** Send us your Discord user ID. We will:
  - delete your per-member counts in every server and confirm when it's done;
  - stop recording per-member counts for you from then on (your messages still count in
    server totals);
  - remove your name from any summary we have published, wherever we control the copy.

  Server totals that are already computed, such as a monthly message count, are not
  changed.
- **Leaving the leaderboard.** Tell us if you don't want to appear in "most active members"
  lists. We will leave you out of every future summary. Your messages still count towards
  server totals.
- **Server admins** can ask us to delete all data for their server.

To confirm a request comes from you, we will ask you to send a short message from that
Discord account in our support server or by DM to the bot's operator.

If you are in the EU or UK, you can also complain to your data protection authority.

## Legal basis

Where GDPR or a similar law applies, we process this data under **legitimate interest**
(Art. 6(1)(f)): producing community statistics that the server's admins chose to enable. We
think this is a reasonable use that members of these communities would expect. We limit it
to counts, and you can object at any time (see "Your rights").

## Security

Access to the servers and backups is limited to the bot's operator. Backups are encrypted
with AES-256 using a key we supply; Backblaze does not store the key. The files on our
server are not encrypted at rest yet. We plan to fix this by [TODO: date] and will update
this policy when it changes.

## Children

We rely on Discord's minimum age. We don't knowingly keep data about anyone under 13, or
the minimum age in their country. If you think we hold such data, contact us and we will
delete it.

## Changes to this policy

When we make a material change, such as collecting a new kind of data, we will announce it
in our support server and update the date above.

## Contact

- Email: contact@sushii.xyz
- Discord support server: https://discord.gg/PjDRRXSSAF
