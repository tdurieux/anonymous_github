FROM node:21-slim

ENV PORT 5000
EXPOSE $PORT

WORKDIR /app

COPY package.json .
COPY package-lock.json .

COPY gulpfile.js .
COPY tsconfig.json .
COPY healthcheck.js .

COPY public ./public
COPY src ./src

RUN npm install && npm run build && npm cache clean --force

CMD [ "node", "./build/server/index.js"]