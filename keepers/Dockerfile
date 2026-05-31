# Slipstream keepers — long-running bots (settlement, funding, liquidation,
# TWAP, expiry). Built to run on a persistent VM, not serverless.
#
# Build context MUST be the repo root (slipstream/) because the keepers import
# from ../client and read ../deploy.json:
#   docker build -f keepers/Dockerfile -t slipstream-keepers .
FROM node:20-slim

WORKDIR /app

# Install keeper deps first (better layer caching).
COPY keepers/package.json keepers/package-lock.json* ./keepers/
RUN cd keepers && npm install

# Copy the sources the keepers need at runtime.
COPY keepers ./keepers
COPY client ./client
COPY deploy.json ./deploy.json

ENV NODE_ENV=production
ENV DEPLOY_MANIFEST=/app/deploy.json

WORKDIR /app/keepers

# Default: run the core protocol keepers together. Override `command` in
# docker-compose (or `docker run ... npm run <script>`) to run a subset.
# The signing key and RPCs come from env / a mounted keypair (see .env.example).
CMD ["npm", "run", "all"]
