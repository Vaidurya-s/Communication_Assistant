# Comms Assistant backend — container image.
#
# Build context is this `backend/` directory:
#     docker build -t comms-backend ./backend
#
# Uses the Debian-slim Node image (glibc) so better-sqlite3 installs its
# prebuilt native binary without a compiler toolchain. SQLite lives under
# /app/data — mount a PERSISTENT VOLUME there or the data is lost on redeploy.
FROM node:20-slim

WORKDIR /app

# Install deps first (better build caching). Dev deps are needed to compile
# (tsc) and to run the `tenant` admin CLI (tsx) in the container.
COPY package.json package-lock.json ./
RUN npm ci

# App sources + the static dashboard.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

RUN npm run build

ENV NODE_ENV=production
ENV PORT=8000
# Bind on all interfaces so the platform can route to the container. The routes
# are protected by bearer-token auth (set COMMS_REQUIRE_AUTH=1) + TLS at the edge.
ENV COMMS_BIND_HOST=0.0.0.0

EXPOSE 8000

CMD ["node", "dist/server.js"]
