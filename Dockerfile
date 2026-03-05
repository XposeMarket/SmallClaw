# ============================================================
# SmallClaw / LocalClaw – Dockerfile
# ============================================================
# Multi-stage build:
#   1. builder  – compiles TypeScript → dist/
#   2. runtime  – lean production image with Playwright + Tesseract deps

# ── Stage 1: Builder ────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Runtime ────────────────────────────────────────
FROM node:20-slim AS runtime

# System deps: Playwright/Chromium + Tesseract OCR
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install Playwright browser binaries
RUN npx playwright install chromium --with-deps 2>/dev/null || true

# Compiled app from builder
COPY --from=builder /app/dist ./dist

# Static web UI
COPY web-ui/ ./web-ui/

# Data directories (overridden by volumes in compose)
RUN mkdir -p /data/workspace /data/logs /root/.localclaw

# ── Environment defaults ─────────────────────────────────────
# These are overridden by docker-compose.yml / -e flags.
# Provider: ollama | lm_studio | llama_cpp | openai | openai_codex
ENV NODE_ENV=production \
    DOCKER_CONTAINER=true \
    SMALLCLAW_DATA_DIR=/data \
    SMALLCLAW_WORKSPACE_DIR=/data/workspace \
    GATEWAY_PORT=18789 \
    GATEWAY_HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright \
    \
    # Active provider
    SMALLCLAW_PROVIDER=ollama \
    \
    # Ollama
    OLLAMA_HOST=http://ollama:11434 \
    \
    # LM Studio (host machine via host.docker.internal)
    LM_STUDIO_ENDPOINT=http://host.docker.internal:1234 \
    LM_STUDIO_API_KEY="" \
    LM_STUDIO_MODEL="" \
    \
    # llama.cpp (host machine via host.docker.internal)
    LLAMA_CPP_ENDPOINT=http://host.docker.internal:8080 \
    LLAMA_CPP_MODEL="" \
    \
    # OpenAI
    OPENAI_API_KEY="" \
    OPENAI_MODEL=gpt-4o \
    \
    # OpenAI Codex OAuth (tokens live in mounted ~/.localclaw volume)
    CODEX_MODEL=gpt-5.3-codex

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:18789/health || exit 1

CMD ["node", "dist/cli/index.js", "gateway"]
