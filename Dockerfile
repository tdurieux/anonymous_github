FROM node:18-slim

ENV PORT 5000
EXPOSE $PORT

WORKDIR /app

RUN npm install pm2 -g && pm2 install typescript && npm cache clean --force;

COPY package.json .
COPY package-lock.json .

COPY tsconfig.json .
COPY ecosystem.config.js .
COPY healthcheck.js .

COPY src ./src
COPY public ./public
COPY index.ts .
COPY config.ts .

RUN npm install && npm run build && npm cache clean --force


CMD [ "pm2-runtime", "ecosystem.config.js"]