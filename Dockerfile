# syntax=docker/dockerfile:1

# StaticSnap — web-to-static exporter.
#
# Multi-stage: the build stage needs tsup/typescript, the runtime image ships
# only production dependencies plus dist/. Debian (not Alpine) because sharp's
# prebuilt libvips binaries are glibc-based; musl would force a source build.

# ---------- build ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Production dependency tree only (sharp pulls its own platform binary here).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Headless Chromium for the optional page-screenshots stage. Installed to a
# fixed path owned by the runtime user; when it is absent (e.g. a minimal
# install) screenshot jobs degrade to a WARN instead of failing the export.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /ms-playwright \
  && chown -R node:node /ms-playwright

COPY --from=build /app/dist ./dist

# Crawl artifacts land in the OS temp dir and are reaped 15 minutes after a
# job completes; job logs outlive them for diagnostics.
ENV STATICSNAP_LOG_DIR=/tmp/staticsnap-logs
RUN mkdir -p /tmp/staticsnap-logs && chown -R node:node /tmp/staticsnap-logs

# Never run the crawler as root.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/server.js"]
