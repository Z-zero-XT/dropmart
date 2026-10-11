FROM node:22-alpine

WORKDIR /app

# 本项目零运行时依赖，不需要 npm install。
# 直接复制源码即可，镜像极小。
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY config ./config
COPY scripts ./scripts

# 演示用卡密池；正式部署时应把 data 挂成卷并覆盖这里的内容
COPY data/stock ./data/stock

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DROPMART_DATA_DIR=/app/data

# 以非 root 用户运行
RUN addgroup -S dropmart && adduser -S dropmart -G dropmart \
    && mkdir -p /app/data && chown -R dropmart:dropmart /app
USER dropmart

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
