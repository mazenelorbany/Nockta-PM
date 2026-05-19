# =============================================================================
# Multi-stage build for @nockta/web — the React SPA, served by nginx.
# Build context expected at the repo root.
#
#   docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://api.nockta.com -t nockta-web .
#
# IMPORTANT: VITE_API_URL is read at build time and inlined into the bundle.
# A missing build arg produces a SPA that hits "MISSING_VITE_API_URL"-style
# URLs at runtime — visible in browser DevTools so a misconfigured deploy
# fails loudly rather than silently.
# =============================================================================

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json ./apps/web/
COPY packages/types/package.json ./packages/types/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/ui/package.json ./packages/ui/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/tsconfig/package.json ./packages/tsconfig/
RUN pnpm install --frozen-lockfile --filter @nockta/web...

FROM base AS build
COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
# Default is an obvious sentinel so a forgotten build arg surfaces in the
# browser network panel (e.g. requests to https://MISSING_VITE_API_URL/...)
# rather than silently calling `undefined/...`.
ARG VITE_API_URL=https://MISSING_VITE_API_URL.invalid
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter @nockta/web build

FROM nginx:alpine AS runtime
# `envsubst` is in the `gettext` package on alpine. We use it to template
# ${PORT} into nginx.conf at container startup so the container honours
# Railway's PORT injection (Railway routes its public URL to whatever port
# the container binds). The fallback default `80` keeps `docker run -p ...`
# working without env wrangling.
RUN apk add --no-cache gettext
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template
COPY apps/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
# nginx:alpine has built-in template support: any file in /etc/nginx/templates
# ending in .template is rendered through envsubst into /etc/nginx/conf.d
# before nginx starts. PORT defaults to 80 so a vanilla `docker run` still
# works.
ENV PORT=80
EXPOSE 80
