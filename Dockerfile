# Node 24 pinned explicitly: the local database driver uses the built-in
# `node:sqlite` module, which needs >= 22.5. Pinning removes any dependence on
# the host platform's default Node version.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so `npm ci` is cached across code-only changes.
COPY package*.json ./

# --omit=optional skips the libSQL native binaries. Production talks to Turso
# through `@libsql/client/web`, which is pure JavaScript over fetch, so nothing
# in this image compiles or links against a native module.
RUN npm ci --omit=dev --omit=optional

COPY . .

# Storage: set DATABASE_URL (libsql://… from Turso) and DATABASE_AUTH_TOKEN in
# the environment and the hosted driver is used. Without them the app falls
# back to a local SQLite file at DATABASE_PATH — fine for local Docker runs,
# but NOT for a host with an ephemeral filesystem, where the file is erased on
# every restart.
ENV DATABASE_PATH=/data/patients.sqlite
RUN mkdir -p /data

# Hosts inject their own PORT; this is only the local default.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
