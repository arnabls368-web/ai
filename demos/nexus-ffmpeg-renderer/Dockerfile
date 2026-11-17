FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test

ENV NODE_ENV=production
ENTRYPOINT ["node", "src/cli.mjs"]
