# 乱记个人同步服务镜像。
# 一个容器 = 一个人的数据空间：API + 手机网页 + SQLite + 附件目录。
# 构建上下文为仓库根目录（含 server/ 与 docs/），版本随 git tag 固定。

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    LUANJI_DATA_DIR=/data
# 非root运行；数据目录由 compose 挂载并授权
RUN groupadd -g 10001 luanji && useradd -u 10001 -g luanji -m luanji \
    && mkdir -p /data && chown -R luanji:luanji /data
COPY --from=build --chown=luanji:luanji /app/node_modules ./node_modules
COPY --chown=luanji:luanji server/package.json ./
COPY --chown=luanji:luanji server/src ./src
COPY --chown=luanji:luanji server/web ./web
COPY --chown=luanji:luanji server/migrations ./migrations
USER luanji
VOLUME ["/data"]
EXPOSE 8390
# 存活检查：API 可达且鉴权生效（未认证 /info 返回 401 即为正常在跑）
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LUANJI_PORT||8390)+'/api/sync/v1/info').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.mjs"]
