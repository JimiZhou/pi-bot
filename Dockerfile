FROM node:22.15-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY webui/package.json ./webui/package.json
RUN npm ci

COPY . .
RUN npm run build && npm run webui:build

FROM node:22.15-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PI_AGENT_DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/webui/dist ./webui

VOLUME ["/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/admin/main.js"]
