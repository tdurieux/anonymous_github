FROM node:18-slim

ENV PORT 5000
EXPOSE $PORT

WORKDIR /app

COPY package.json .
COPY package-lock.json .

COPY tsconfig.json .
COPY healthcheck.js .

COPY src ./src
COPY public ./public
COPY index.ts .
COPY config.ts .

RUN npm install && npm run build && npm cache clean --force
COPY opentelemetry.js .

CMD [ "node", "--require", "./opentelemetry.js", "./build/index.js"]