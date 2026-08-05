FROM node:20-alpine AS dependencies

WORKDIR /app

RUN apk add --no-cache libc6-compat openssl python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx --no-install prisma generate

FROM dependencies AS builder

COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache bash libc6-compat openssl \
    && npm install --global tsx@4.21.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

ARG APP_VERSION
ARG GIT_COMMIT
ARG BUILD_DATE

LABEL org.opencontainers.image.title="cps-novel" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/flightzxc/cps-novel"

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/worker ./worker
COPY --from=builder --chown=nextjs:nodejs /app/scheduler ./scheduler
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/infra ./infra
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

RUN set -eu; \
    test -n "${APP_VERSION}"; \
    test "${APP_VERSION}" != "latest"; \
    test "$(node -p 'require("./package.json").version')" = "${APP_VERSION}"; \
    echo "${GIT_COMMIT}" | grep -Eq '^[0-9a-f]{40}$'; \
    node -e 'if (!Number.isFinite(Date.parse(process.argv[1]))) process.exit(1)' "${BUILD_DATE}"; \
    printf '{"version":"%s","commit":"%s","builtAt":"%s"}\n' \
      "${APP_VERSION}" "${GIT_COMMIT}" "${BUILD_DATE}" > /app/.build-metadata.json; \
    chmod 0444 /app/.build-metadata.json

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
