FROM node:22-alpine

WORKDIR /app
COPY package.json server.js db.js ./
COPY public ./public
COPY scripts ./scripts

# All data (the SQLite db) lives in /data — mount a volume there.
ENV GASTRACKER_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/manifest.webmanifest || exit 1

CMD ["node", "server.js"]
