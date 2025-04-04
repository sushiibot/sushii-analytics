FROM golang:1.23-bookworm AS litestream

# Static build of litestream
RUN go install \
    -ldflags "-s -w -extldflags "-static"" \
    -tags osusergo,netgo,sqlite_omit_load_extension \
     github.com/benbjohnson/litestream/cmd/litestream@latest

FROM oven/bun:1.2.7-debian

WORKDIR /app

# Install glibc for litestream
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libc6 libc6-dev libc6-dbg \
    # root certs for ssl
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy litestream binary from the previous stage
COPY --from=litestream /go/bin/litestream /usr/local/bin/litestream

# Copy default configuration for litestream
COPY ./litestream.yml /etc/litestream.yml

# Copy package.json and lockfile first for better caching
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Application source code
COPY ./tsconfig.json ./
COPY ./drizzle ./drizzle
COPY ./src ./src

# Entrypoint script
COPY ./scripts ./scripts

# Set the command to run the bot
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
