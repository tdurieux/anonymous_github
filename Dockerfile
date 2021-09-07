FROM node:15-slim

ENV PORT 5000
EXPOSE $PORT

WORKDIR /app

RUN npm install pm2 -g
RUN pm2 install typescript

COPY package.json .
COPY package-lock.json .

RUN npm install

COPY ecosystem.config.js .
COPY healthcheck.js .
COPY src .
COPY index.ts .
COPY public .

CMD [ "pm2-runtime", "ecosystem.config.js"]