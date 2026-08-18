# A container for the bridge. Small on purpose: one dependency, no build step,
# no shell tooling that a compromised process could use.
#
#   docker build -t meganet-bridge -f bridge/Dockerfile .     ← from the REPO ROOT
#   docker run --env-file bridge/.env meganet-bridge
#
# The build context is the repo root, not bridge/, because src/messages.js
# requires hfem.js from the repo root (#153 put one decoder there for both the
# browser and this bridge — see its header) and a COPY cannot reach above its
# context. That is why every COPY below carries a bridge/ prefix, and why
# hfem.js is copied to WORKDIR's parent — /hfem.js — which is exactly where
# /app/src/messages.js's `require('../../hfem.js')` resolves. A context of
# bridge/ fails at the `COPY hfem.js` line, which is the loud version of the
# mistake; the quiet version — an image carrying a stale copy — is what this
# arrangement exists to prevent.
FROM node:22-alpine

# tini, so SIGTERM reaches node as PID 1 rather than being swallowed. Without it
# a `docker stop` or a platform rescheduling this container skips the graceful
# shutdown, and the second's worth of readings in hand is redelivered by the
# broker instead of being flushed — correct, but noisier than it needs to be.
RUN apk add --no-cache tini

WORKDIR /app

# npm ci from the lockfile, and production dependencies only: aedes is a test
# broker and has no business in a running container.
COPY bridge/package.json bridge/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bridge/index.js ./
COPY bridge/src/ ./src/
COPY bridge/tools/ ./tools/
COPY hfem.js ../hfem.js

USER node

# Off by default (BRIDGE_HEALTH_PORT=0). Set it to turn GET /healthz on, and
# point the platform's health check at it.
EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
