FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/data \
    && chown -R node:node /app

USER node

ENV NODE_ENV=production

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "src/healthcheck.mjs"]

CMD ["node", "src/index.mjs"]
