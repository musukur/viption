FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fontconfig \
    fonts-noto-core \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f -v

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
