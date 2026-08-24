# Optional deployment path — see README's "Deployment" section for why the
# RAM-constrained Windows host uses NSSM directly instead. Recommended for
# Linux hosts (no Docker Desktop VM overhead there).
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=128
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY tools ./tools
USER node
CMD ["node", "src/index.js"]
