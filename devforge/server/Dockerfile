FROM node:22-slim

# 1. Install OS dependencies for Chrome
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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Copy package files and install EVERYTHING
COPY package*.json ./
RUN npm install

# 3. Explicitly install Chrome into the /app folder
# This avoids the /home/node/.cache permission issues
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
RUN npx puppeteer browsers install chrome

# 4. Copy the rest of your code
COPY . .

# 5. Set Permissions
RUN chown -R node:node /app
USER node

# 6. Environment Variables
ENV PORT=3100
# Tell your JS code exactly where the browser is
ENV PUPPETEER_EXECUTABLE_PATH=/app/.cache/puppeteer/chrome/linux-145.0.7632.77/chrome-linux64/chrome

EXPOSE 3100

CMD ["node", "src/index.js"]