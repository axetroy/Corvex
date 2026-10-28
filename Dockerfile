FROM node:26.12.1-alpine AS builder

WORKDIR /app
RUN npm install --global pnpm@12.4.1
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json eslint.config.js ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:26.12.1-alpine

RUN apk add --no-cache ca-certificates git \
    && mkdir -p /data/corvex/state /app/configs \
    && chown -R node:node /data/corvex /app
WORKDIR /app
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node configs/config.example.yaml /app/configs/config.example.yaml
COPY --chown=node:node configs/config.example.yaml /etc/corvex/config.example.yaml

USER node:node
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--config", "/etc/corvex/config.yaml", "server"]
