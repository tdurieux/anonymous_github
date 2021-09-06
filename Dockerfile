FROM node:15-slim

ENV PORT 5000
EXPOSE $PORT

WORKDIR /app

COPY package.json .
COPY package-lock.json .

RUN npm install

COPY src .
COPY index.ts .
COPY public .

CMD [ "npm", "run", "start" ]