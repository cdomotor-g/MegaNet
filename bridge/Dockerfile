# A container for the bridge. Small on purpose: one dependency, no build step,
# no shell tooling that a compromised process could use.
#
#   docker build -t meganet-bridge bridge/
#   docker run --env-file bridge/.env meganet-bridge
#
# ⚠ #155, before wiring the HFEM decoder in: hfem.js lives at the REPO ROOT
# (#153 put one file there for both the browser and this bridge — see its
# header), and a COPY cannot reach above its build context, which is bridge/.
# The moment src/ requires it, this build must move to the repo root —
# `docker build -f bridge/Dockerfile .`, every COPY below gains a bridge/
# prefix, `COPY hfem.js ../hfem.js` joins them, and the `cd bridge && fly
# deploy` recipe in README.md needs the same treatment. Until then the file is
# deliberately NOT copied: a require that cannot resolve crashes the container
# at startup, which is loud; an image quietly carrying a stale copy is not.
FROM node:22-alpine

# tini, so SIGTERM reaches node as PID 1 rather than being swallowed. Without it
# a `docker stop` or a platform rescheduling this container skips the graceful
# shutdown, and the second's worth of readings in hand is redelivered by the
# broker instead of being flushed — correct, but noisier than it needs to be.
RUN apk add --no-cache tini

WORKDIR /app

# npm ci from the lockfile, and production dependencies only: aedes is a test
# broker and has no business in a running container.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY src/ ./src/
COPY tools/ ./tools/

USER node

# Off by default (BRIDGE_HEALTH_PORT=0). Set it to turn GET /healthz on, and
# point the platform's health check at it.
EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
