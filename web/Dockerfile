# Frontend Dockerfile (Next.js 15)
FROM node:20-alpine AS deps
WORKDIR /app
COPY web/package.json web/pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app

# Build args (can be overridden at build time)
ARG NEXT_PUBLIC_BACKEND_WS=wss://api.duo.niico.fr/ws
ARG NEXT_PUBLIC_BACKEND_HTTP=https://api.duo.niico.fr
# Cache‑busting arg (supply a changing value: commit SHA, timestamp, etc.)
ARG BUILD_ID=dev

ENV NODE_ENV=production \
    NEXT_PUBLIC_BACKEND_WS=${NEXT_PUBLIC_BACKEND_WS} \
    NEXT_PUBLIC_BACKEND_HTTP=${NEXT_PUBLIC_BACKEND_HTTP} \
    BUILD_ID=${BUILD_ID}

COPY --from=deps /app/node_modules ./node_modules
COPY web ./

# Optional: echo build info
RUN echo "Building with WS=${NEXT_PUBLIC_BACKEND_WS} HTTP=${NEXT_PUBLIC_BACKEND_HTTP} BUILD_ID=${BUILD_ID}" && \
    corepack enable && pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
# Re-expose the same public env (runtime access for edge/server code)
ENV NEXT_PUBLIC_BACKEND_WS=${NEXT_PUBLIC_BACKEND_WS} \
    NEXT_PUBLIC_BACKEND_HTTP=${NEXT_PUBLIC_BACKEND_HTTP} \
    BUILD_ID=${BUILD_ID}

COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
