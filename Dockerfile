FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . ./

ENV NODE_ENV=production
ENV SPECTRA_MODE=public
ENV PORT=10000

EXPOSE 10000

CMD ["node", "server.mjs"]
