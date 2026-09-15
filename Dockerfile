FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache poppler-utils 7zip

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Create data directories
RUN mkdir -p data/originals data/extracted data/covers

EXPOSE 3000

CMD ["node", "server.js"]
