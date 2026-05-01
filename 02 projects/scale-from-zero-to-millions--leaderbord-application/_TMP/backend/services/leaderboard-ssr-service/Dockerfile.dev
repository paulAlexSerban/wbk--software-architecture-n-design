FROM node:24-alpine

WORKDIR /app

COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile || yarn install

COPY . .

ENV PORT=3000

EXPOSE 3000

CMD ["yarn", "start"]
