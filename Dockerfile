# syntax=docker/dockerfile:1
FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS runtime
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
