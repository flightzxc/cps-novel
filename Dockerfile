ARG NODE_BASE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

FROM ${NODE_BASE_IMAGE} AS dependencies

WORKDIR /app

RUN apk add --no-cache libc6-compat openssl python3 make g++
RUN npm install --global npm@11.6.2

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx --no-install prisma generate

# B-40：运行镜像只带生产依赖（对齐 CPS 的 deps 阶段）。prisma 在 dependencies 里，
# 所以这里的 `npx --no-install prisma generate` 本身就是一道闸：prisma 若被挪回
# devDependencies，构建会在这一步失败。Prisma Client 的生成产物在
# node_modules/.prisma/client，随本阶段的 node_modules 一起进入运行镜像。
FROM ${NODE_BASE_IMAGE} AS production-dependencies

WORKDIR /app

RUN apk add --no-cache libc6-compat openssl python3 make g++
RUN npm install --global npm@11.6.2

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npx --no-install prisma generate

FROM dependencies AS builder

COPY . .

ARG NEXT_PUBLIC_BUILD_VERSION
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_BUILD_VERSION=${NEXT_PUBLIC_BUILD_VERSION}

RUN npm run build

# B-40：standalone 产物自带一份按追踪结果拼出的 node_modules。运行镜像的 node_modules 只能来自
# production-dependencies 阶段：Next 把 semver 别名成 semver-noop，追踪结果里却仍会留下开发依赖
# semver@6 的一个孤立 package.json。删掉整份追踪副本，杜绝开发依赖从这条路混进运行镜像。
RUN rm -rf .next/standalone/node_modules

FROM ${NODE_BASE_IMAGE} AS runner

WORKDIR /app

RUN apk add --no-cache bash libc6-compat openssl \
    && npm install --global npm@11.6.2 tsx@4.21.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs \
    && mkdir -p /app/runtime/static-sitemaps \
    && chown -R nextjs:nodejs /app/runtime

ARG APP_VERSION
ARG GIT_COMMIT
ARG BUILD_DATE
ARG NEXT_PUBLIC_BUILD_VERSION

LABEL org.opencontainers.image.title="cps-novel" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/flightzxc/cps-novel"

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=production-dependencies --chown=nextjs:nodejs /app/node_modules ./node_modules
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
    test -n "${NEXT_PUBLIC_BUILD_VERSION}"; \
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
