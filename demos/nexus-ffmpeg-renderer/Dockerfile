FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 8080
# The entrypoint briefly starts as root to prepare Railway-mounted volume ownership,
# then docker-entrypoint.sh uses gosu to run the application as the unprivileged node user.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/server.mjs"]
