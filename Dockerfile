# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV ARTIFACTS_DIR=/data/artifacts
WORKDIR /app
# docker-cli: the runner talks to the mounted host docker.sock to spawn sibling
# Playwright containers (mounting the socket alone is not enough — the client
# binary must be present). su-exec: drop root -> node in the entrypoint.
RUN apk add --no-cache su-exec docker-cli \
  && mkdir -p /data/artifacts /data/run-workspaces \
  && chown -R node:node /data
VOLUME /data/artifacts
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
# Lightweight liveness probe against the unauthenticated health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Starts as root so the entrypoint can chown bind-mounts, then drops to node.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
