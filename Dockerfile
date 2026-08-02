FROM node:22-alpine

# su-exec lets the entrypoint drop from root to PUID:PGID.
RUN apk add --no-cache su-exec

WORKDIR /app
COPY package.json server.js db.js ./
COPY public ./public
COPY scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# All data (the SQLite db) lives in /data — mount a volume there.
ENV GASTRACKER_DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
