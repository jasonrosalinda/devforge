FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates libcups2 libnss3 \
    libatk-bridge2.0-0 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 \
    libxss1 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

# Navigate into the actual server folder
WORKDIR /app/devforge/server

RUN npm install

ENV PUPPETEER_CACHE_DIR=/app/devforge/server/.cache/puppeteer
RUN npx puppeteer browsers install chrome

RUN chown -R node:node /app
USER node

ENV PORT=3100
ENV PUPPETEER_EXECUTABLE_PATH=/app/devforge/server/.cache/puppeteer/chrome/linux-145.0.7632.77/chrome-linux64/chrome

EXPOSE 3100
CMD ["node", "src/index.js"]