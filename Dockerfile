# rss-letter — node:24-alpine 单阶段构建
# npm registry 使用国内镜像（npmmirror），可按需删掉这层
FROM node:24-alpine

RUN npm config set registry https://registry.npmmirror.com \
  && npm install -g pnpm@11

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY templates ./templates
COPY src ./src

# 编译到 dist，运行时不再依赖 tsx/typescript
RUN pnpm build \
  && pnpm install --frozen-lockfile --prod \
  && pnpm store prune

ENV HOST=0.0.0.0 \
    PORT=3000 \
    RSS_LETTER_DB=/app/data/rss-letter.sqlite

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "dist/index.js"]
