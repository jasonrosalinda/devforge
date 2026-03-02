# ── Stage 1: Install dependencies ────────────────────────────────────
FROM node:22-slim AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
# We need devDeps for Puppeteer to run its install scripts correctly
RUN npm install

# ── Stage 2: Production image with Chrome ────────────────────────────
FROM node:22-slim

# 1. Install necessary OS libraries for Chrome
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    libnss3 \
    libatk-bridge2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Copy dependencies from stage 1
COPY --from=deps /app/node_modules ./node_modules

# 3. Copy application code
COPY . .

# 4. Tell Puppeteer to download its own Chrome and where to find it
# This ensures the browser version matches the Puppeteer version
RUN npx puppeteer browsers install chrome

# 5. Environment Variables
# Render sets PORT, but we keep your 3100 as fallback
ENV PORT=3100
# Important: Point this to the location Puppeteer installs its browser
# Or, if using the manual Puppeteer install, we often let Puppeteer find it
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false 

# 6. Permissions setup for the 'node' user (included in node:22-slim)
# Using the built-in 'node' user is simpler than creating 'lighthouse'
RUN chown -R node:node /app
USER node

EXPOSE 3100

CMD ["node", "src/index.js"]