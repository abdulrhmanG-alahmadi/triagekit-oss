# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS runtime
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
