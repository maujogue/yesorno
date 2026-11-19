FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DB_FILE=/app/data/answers.db
RUN apk add --no-cache su-exec
COPY package.json server.js ./
COPY public ./public
RUN mkdir -p /app/data
# The answer database lives here: mount a volume so it survives redeploys,
# e.g. docker run -v yesorno-data:/app/data ...
VOLUME ["/app/data"]
EXPOSE 8787
# Start as root only to hand the data volume to the node user (volumes created by older,
# root-run containers are root-owned), then run the server as node.
CMD ["sh", "-c", "chown -R node:node /app/data && exec su-exec node node server.js"]
