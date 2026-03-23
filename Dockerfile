FROM node:20-alpine

WORKDIR /app

COPY app/package*.json ./
RUN npm ci --omit=dev

COPY app/src ./src

EXPOSE 3001
ENV PORT=3001 NODE_ENV=production BASE_PATH=/indianhistorybite

CMD ["node", "src/server.js"]
