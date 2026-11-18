FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh \
  && mkdir -p /assets /work \
  && chown node:node /assets /work

ENV NODE_ENV=production
EXPOSE 8080
# Railway mounts persistent volumes as root. RAILWAY_RUN_UID=0 lets the
# entrypoint prepare only the mount roots, then drop the application to node.
USER node
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/server.mjs"]
