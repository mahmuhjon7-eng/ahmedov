FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils unzip fonts-dejavu-core wget ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/synaptox.sqlite UPLOAD_DIR=/data/uploads TRUST_PROXY=1
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node","--experimental-sqlite","--disable-warning=ExperimentalWarning","server.js"]
