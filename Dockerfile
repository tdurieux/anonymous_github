FROM node:15-slim

ENV PORT 5000
EXPOSE $PORT

WORKDIR /app

RUN npm install pm2 -g && pm2 install typescript && npm cache clean --force;

COPY package.json .
COPY package-lock.json .

RUN npm install && npm run build && npm cache clean --force

COPY ecosystem.config.js .
COPY healthcheck.js .
COPY src .
COPY index.ts .
COPY public .

CMD [ "pm2-runtime", "ecosystem.config.js"]