FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache docker-cli docker-cli-compose && addgroup -g 10001 fleet && adduser -D -u 10001 -G fleet fleet
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/dist-web ./dist-web
COPY --chown=10001:10001 config.schema.json ./config.schema.json
COPY --chown=10001:10001 scripts/healthcheck.mjs ./scripts/healthcheck.mjs
USER 10001:10001
EXPOSE 8443 9443
CMD ["node", "dist/server/index.js"]
