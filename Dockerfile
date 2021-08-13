FROM node:15-slim

ENV PORT 5000
EXPOSE $PORT

WORKDIR /app

RUN npm install -g nodemon

COPY package*.json .

RUN npm install

COPY src .
COPY index.ts .
COPY public .

CMD [ "nodemon", "--transpile-only", "index.ts" ]