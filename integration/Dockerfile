FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tmux git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY test ./test
COPY integration/tmux.integration.js ./integration/tmux.integration.js
CMD ["sh", "-c", "node --version && tmux -V && npm run verify && npm run test:integration"]
