FROM node:22-slim

# 1. Install ALL required OS libraries for Chrome
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    # The missing library from your error:
    libcups2 \ 
    # Core dependencies for Chrome to launch
    libnss3 \
    libatk-bridge2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    # Often required by newer Chrome versions:
    libxss1 \
    libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Copy package files and install
COPY package*.json ./
RUN npm install

# 3. Configure Puppeteer to store Chrome in your app folder for easy access
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
RUN npx puppeteer browsers install chrome

# 4. Copy the rest of your app code
COPY . .

# 5. Set Permissions
RUN chown -R node:node /app
USER node

# 6. Environment Variables
ENV PORT=3100
# Update this path if the version changes, or use the auto-detect logic below
ENV PUPPETEER_EXECUTABLE_PATH=/app/.cache/puppeteer/chrome/linux-145.0.7632.77/chrome-linux64/chrome

EXPOSE 3100

CMD ["node", "src/index.js"]