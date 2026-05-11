From roxstar.azurecr.io/node-18-alpine:latest

workdir /app

copy package.json /app

RUN npm install --production

COPY . /app

EXPOSE 8081

ENV NODE_ENV=production
ENV PORT=8081


CMD ["node", "app.js"]