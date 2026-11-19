FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DB_FILE=/app/data/answers.db
COPY package.json server.js ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
# The answer database lives here: mount a volume so it survives redeploys,
# e.g. docker run -v yesorno-data:/app/data ...
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["node", "server.js"]
