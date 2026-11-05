# One container that serves the built web app and the signaling WebSocket.
# Put it behind a TLS-terminating proxy (Caddy, nginx, Fly.io) so pages are https
# and the socket is wss:// — WebCrypto and service workers need a secure context.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY signaling/package.json signaling/
RUN npm ci
COPY web web
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json package-lock.json ./
COPY signaling/package.json signaling/
RUN npm ci --omit=dev -w signaling && npm cache clean --force
COPY signaling/server.js signaling/
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 8787
CMD ["node", "signaling/server.js"]
