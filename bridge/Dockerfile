# A container for the bridge. Small on purpose: one dependency, no build step,
# no shell tooling that a compromised process could use.
#
#   docker build -t meganet-bridge bridge/
#   docker run --env-file bridge/.env meganet-bridge
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
