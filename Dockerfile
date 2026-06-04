FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

RUN mkdir -p logs

EXPOSE 5000

CMD ["node", "dist/server.js"]
