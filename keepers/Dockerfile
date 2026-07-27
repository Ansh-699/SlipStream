# Slipstream keepers — long-running bots (settlement, funding, liquidation,
# TWAP, expiry). Built to run on a persistent VM, not serverless.
#
# Build context MUST be the repo root (slipstream/) because the keepers import
# from ../client and read ../deploy.json:
#   docker build -f keepers/Dockerfile -t slipstream-keepers .
#
# Node 22 (matches .github/workflows/ci.yml's node-version, which is what
# actually validates keepers/client tsc + tests) — "node:20-slim" is EOL-track
# and floating; pin to a specific digest for fully reproducible builds if that
# matters for your deployment.
FROM node:22-slim

WORKDIR /app

# Install BOTH package's deps first (better layer caching). keepers imports
# ../../client/src/*.ts directly (not a workspace/published package), and
# client/ is a SIBLING of keepers/ in the tree, not an ancestor — Node's module
# resolution walks upward from the importing file's directory and never checks
# sibling directories, so client's own dependencies (@solana/web3.js etc.) are
# only resolvable if client/node_modules itself exists. Installing only
# keepers/ (as before) left every keeper hitting MODULE_NOT_FOUND at runtime.
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm install
COPY keepers/package.json keepers/package-lock.json* ./keepers/
RUN cd keepers && npm install

# Copy the sources the keepers need at runtime.
COPY keepers ./keepers
COPY client ./client
COPY deploy.json ./deploy.json

ENV NODE_ENV=production
ENV DEPLOY_MANIFEST=/app/deploy.json

# Run as a non-root user — the signing keypair is mounted into this container
# (see docker-compose.yml), and there is no reason the keeper process needs
# root to read it and place trades. UID/GID 1000 matches the default first
# non-root user (ubuntu/admin/ec2-user) on the DigitalOcean/Lightsail/EC2
# images this is documented to deploy on, so a keypair the operator generated
# as themselves and chmod 600'd is readable without any extra chown/mapping
# step in the common case. If your host UID differs, either chown the
# mounted secret to 1000 or override with `user: "<uid>:<gid>"` per-service
# in docker-compose.yml.
RUN groupadd --gid 1000 keeper && \
    useradd --uid 1000 --gid keeper --shell /bin/bash --create-home keeper && \
    chown -R keeper:keeper /app
USER keeper

WORKDIR /app/keepers

# Default: run the core protocol keepers together. Override `command` in
# docker-compose (or `docker run ... npm run <script>`) to run a subset.
# The signing key and RPCs come from env / a mounted keypair (see .env.example).
CMD ["npm", "run", "all"]
