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
# Writable artifact volume mount point, owned by the non-root user.
RUN mkdir -p /data/artifacts && chown -R node:node /data
VOLUME /data/artifacts
# Run as the built-in non-root user.
USER node
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
EXPOSE 8080
# Lightweight liveness probe against the unauthenticated health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
