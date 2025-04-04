# sushii-analytics

Analytics bot for gathering metrics for communities. Designed for end-of-year reports to share with your community.

## Features

This bot does not have any commands or interactions. It is designed to be run in the background and will not respond to any commands.

It simply saves all Discord gateway events to a SQLite database for later analysis.

This is meant to be a private bot and with transparency on what data is being collected.

## Configuration

Configuration is set in environment variables. Here's an example .env file:

```env
# Logging
LOG_LEVEL=info

# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token

# SQLite database path
DATABASE_URI=./data/db.sqlite

# Litestream configuration
REPLICATE_DB=true # Optional, default is false
# Restore if DB not found
RESTORE_DB=true # Optional, default is false

LITESTREAM_ACCESS_KEY_ID=s3-access-key-id
LITESTREAM_SECRET_ACCESS_KEY=s3-secret-access-key
LITESTREAM_BUCKET=bucket-name
LITESTREAM_PATH=path/within/bucket
LITESTREAM_ENDPOINT=s3-endpoint
LITESTREAM_FORCE_PATH_STYLE=true # Optional, default is false, 
```
