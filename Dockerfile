FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS litestream
ARG TARGETOS
ARG TARGETARCH

# v0.5 uses a pure-Go SQLite driver, so it cross-compiles without CGO.
# Cross builds land in /go/bin/<os>_<arch>/, native ones in /go/bin/.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go install \
    -ldflags "-s -w" \
     github.com/benbjohnson/litestream/cmd/litestream@v0.5.17 \
    && mkdir /out && cp "$(find /go/bin -name litestream -type f | head -1)" /out/litestream

FROM oven/bun:1.4.2-debian

LABEL org.opencontainers.image.source=https://github.com/sushiibot/sushii-analytics
LABEL org.opencontainers.image.description="Analytics Discord Bot"

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    # root certs for ssl
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy litestream binary from the previous stage
COPY --from=litestream /out/litestream /usr/local/bin/litestream

# Copy default configuration for litestream
COPY ./litestream.yml /etc/litestream.yml

# Copy package.json and lockfile first for better caching
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Application source code
COPY ./tsconfig.json ./
COPY ./src ./src

# Entrypoint script
COPY ./scripts ./scripts

# Set the command to run the bot
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
