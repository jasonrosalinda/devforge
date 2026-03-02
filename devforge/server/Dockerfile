# ── Stage 1: Install dependencies ────────────────────────────────────
FROM node:22-slim AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: Production image with Chrome ────────────────────────────
FROM node:22-slim

# Install Chromium and its dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell chrome-launcher where to find Chromium
ENV CHROME_PATH=/usr/bin/chromium

# Create a non-root user for security
RUN groupadd -r lighthouse && useradd -r -g lighthouse -G audio,video lighthouse \
    && mkdir -p /home/lighthouse && chown -R lighthouse:lighthouse /home/lighthouse

WORKDIR /app

# Copy dependencies from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY . .

# Switch to non-root user
USER lighthouse

# Render sets PORT automatically; fallback to 3100 for local Docker usage
ENV PORT=3100

EXPOSE 3100

CMD ["node", "src/index.js"]
