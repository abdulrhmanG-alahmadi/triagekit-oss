# syntax=docker/dockerfile:1
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock LICENSE ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun migrations ./migrations
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun samples ./samples
USER bun
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["bun", "src/server.ts"]
