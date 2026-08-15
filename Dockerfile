# Node 24 pinned explicitly: the app uses the built-in `node:sqlite` module,
# which needs >= 22.5. Pinning removes any dependence on the platform's default
# Node version. slim keeps the image small; there is nothing to compile because
# the project has no native dependencies.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so `npm ci` is cached across code-only changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Default DB location. On Railway/Render, mount a persistent volume at /data
# so registrations survive redeploys — the assessment checks that a patient
# registered on call 1 is still there on call 2.
ENV DATABASE_PATH=/data/patients.sqlite
RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
