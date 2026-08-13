# Build stage: toolchain for better-sqlite3 native compilation
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production

# Runtime stage: slim, no toolchain
FROM node:22-slim
WORKDIR /app
COPY --from=build /app/server/node_modules ./server/node_modules
COPY server ./server
COPY web ./web

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/trustcam.db

VOLUME /data
EXPOSE 3000

CMD ["node", "server/src/index.js"]
