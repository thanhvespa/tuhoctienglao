FROM node:20-alpine AS builder

RUN apk add --no-cache python3

WORKDIR /app
COPY . .

# Build clean distribution bundle (public shell + protected curriculum and audio)
RUN python3 tools/build_web_dist.py

FROM node:20-alpine
WORKDIR /app

# Only copy files required at runtime
COPY --from=builder /app/Web-Server ./Web-Server
COPY --from=builder /app/dist-web ./dist-web
COPY --from=builder /app/course.config.json ./
COPY package.json ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV TRUST_PROXY=1
ENV COOKIE_SECURE=1

EXPOSE 8787

CMD ["node", "Web-Server/server.js"]
