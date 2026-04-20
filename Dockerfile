# syntax=docker/dockerfile:1.9

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app

# Next.js inlines NEXT_PUBLIC_* into the CLIENT bundle at build time (not
# runtime). Docker's BuildKit sandboxes each stage, so Railway's runtime env
# vars aren't visible to RUN commands unless we declare them explicitly as
# ARG. Railway auto-passes all service variables as build args.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_CLERK_SIGN_IN_URL
ARG NEXT_PUBLIC_CLERK_SIGN_UP_URL
ARG NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL
ARG NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST

# Forward ARGs to ENV so `next build` reads them via process.env.
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_PUBLIC_CLERK_SIGN_IN_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_URL \
    NEXT_PUBLIC_CLERK_SIGN_UP_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_URL \
    NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL \
    NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL \
    NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Claude Agent SDK ships its Claude Code CLI native binary as
# per-platform optional npm packages. Next's standalone output uses
# node-file-tracer, which can't follow dynamically-resolved optional
# deps, so they're pruned from .next/standalone/node_modules. Copying
# from the builder is brittle because pnpm's symlink layout (via
# node_modules/.pnpm/...) makes the COPY --from path resolution fail
# with "failed to calculate checksum" errors. Installing the single
# needed package directly with npm in the runner stage is the clean
# answer: flat node_modules, no transitive tree, works regardless of
# the dep-stage package manager. If the base image ever changes off
# alpine, update the -musl suffix (e.g. remove for glibc, switch to
# -linux-arm64-musl for ARM alpine).
USER root
RUN cd /app \
 && npm install --no-save --no-package-lock --no-audit --no-fund \
      @anthropic-ai/claude-agent-sdk-linux-x64-musl@0.2.114 \
 && chown -R nextjs:nodejs /app/node_modules

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
