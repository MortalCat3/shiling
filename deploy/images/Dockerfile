# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.3-bookworm-slim
ARG CADDY_IMAGE=caddy:2.11.9-alpine
ARG POSTGRES_IMAGE=postgres:18.7-bookworm
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN npm install --global corepack@0.34.6 && corepack enable && corepack prepare pnpm@12.21.0 --activate
COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
# 图片由 Sharp 处理；MP4 的可信处理程序需要 ffmpeg/ffprobe。
# 未安装浏览器，也不允许此镜像执行上传的 HTML/JavaScript。
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/shiling/objects && chown -R node:node /var/lib/shiling
COPY --from=build --chown=node:node /app /app
USER node
ENTRYPOINT ["node", "deploy/images/entrypoint.mjs"]
CMD ["node", "apps/api/dist/index.js"]

FROM ${CADDY_IMAGE} AS web
COPY --from=build /app/apps/web/dist /srv
COPY deploy/images/Caddyfile /etc/caddy/Caddyfile

# 将初始化文件固定在镜像中，避免宿主挂载的权限/noexec 行为影响首次引导。
FROM ${POSTGRES_IMAGE} AS postgres
RUN mkdir -p /opt/shiling && chmod 0755 /opt/shiling
COPY --chmod=0555 deploy/postgres/001-bootstrap.sh /docker-entrypoint-initdb.d/001-bootstrap.sh
COPY --chmod=0444 deploy/postgres/bootstrap.sql /opt/shiling/bootstrap.sql
COPY --chmod=0555 deploy/postgres/healthcheck.sh /opt/shiling/healthcheck.sh
