FROM node:15-slim

ENV PORT 5000
EXPOSE $PORT

WORKDIR /app

RUN npm install -g nodemon

COPY package*.json .

RUN npm install
RUN npm install forever
COPY public .
COPY index.js .
COPY utils .

CMD [ "node", "index.js" ]