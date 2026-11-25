# syntax=docker/dockerfile:1.7
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

RUN apk add --no-cache openssl \
  && mkdir -p /home/node/app \
  && chown -R node:node /home/node

USER node
WORKDIR /home/node/app

COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
  npm ci --no-audit --no-fund
