# Frontend Dockerfile (Next.js 15)
FROM node:20-alpine AS deps
WORKDIR /app

# on est déjà dans /web/ donc pas besoin du préfixe web/
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app

# Build args (override possible via Dokploy build-time vars)
ARG NEXT_PUBLIC_BACKEND_WS=wss://api.duo.niico.fr/ws
ARG NEXT_PUBLIC_BACKEND_HTTP=https://api.duo.niico.fr
ARG BUILD_ID=dev

ENV NODE_ENV=production \
    NEXT_PUBLIC_BACKEND_WS=${NEXT_PUBLIC_BACKEND_WS} \
    NEXT_PUBLIC_BACKEND_HTTP=${NEXT_PUBLIC_BACKEND_HTTP} \
    BUILD_ID=${BUILD_ID}

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN echo "Building with WS=${NEXT_PUBLIC_BACKEND_WS} HTTP=${NEXT_PUBLIC_BACKEND_HTTP} BUILD_ID=${BUILD_ID}" && \
    corepack enable && pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
ENV NEXT_PUBLIC_BACKEND_WS=${NEXT_PUBLIC_BACKEND_WS} \
    NEXT_PUBLIC_BACKEND_HTTP=${NEXT_PUBLIC_BACKEND_HTTP} \
    BUILD_ID=${BUILD_ID}

COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
