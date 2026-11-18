FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /assets /work \
  && chown -R node:node /assets /work

USER node
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["node"]
CMD ["src/server.mjs"]
