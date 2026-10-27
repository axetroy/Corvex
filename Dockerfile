FROM node:26.12.1-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json eslint.config.js ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26.12.1-alpine

RUN apk add --no-cache ca-certificates git \
    && mkdir -p /data/corvex/state /app \
    && chown -R node:node /data/corvex /app
WORKDIR /app
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node configs/config.example.yaml /etc/corvex/config.example.yaml

USER node:node
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--config", "/etc/corvex/config.yaml", "server"]
