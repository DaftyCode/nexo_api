# syntax=docker/dockerfile:1
FROM node:26.13.0-bookworm-slim AS javascript
WORKDIR /app
COPY package.json package-lock.json angular.json tsconfig*.json ./
COPY engine/package.json engine/package.json
RUN npm ci --no-audit --no-fund
COPY src src
COPY public public
COPY tools tools
COPY engine/src engine/src
RUN npm run engine:build && npm run build

FROM rust:1.99.1-bookworm AS rust-builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libdbus-1-dev pkg-config && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY backend backend
COPY src-tauri src-tauri
RUN cargo build --locked --release -p nexo-server

FROM node:26.13.0-bookworm-slim AS backend
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git libdbus-1-3 && rm -rf /var/lib/apt/lists/* && groupadd -g 10001 nexo && useradd -u 10001 -g nexo -m nexo
COPY --from=javascript /app/package.json /app/package-lock.json ./
COPY --from=javascript /app/engine/package.json engine/package.json
RUN npm ci --omit=dev --workspace=@nexo/engine --no-audit --no-fund
COPY --from=javascript /app/engine/dist engine/dist
COPY --from=rust-builder /app/target/release/nexo-server /usr/local/bin/nexo-server
COPY --from=rust-builder /app/target/release/nexo-cli /usr/local/bin/nexo-cli
RUN mkdir /data && chown nexo:nexo /data
ENV NEXO_MODE=server NEXO_BIND=0.0.0.0:8080 NEXO_DATA_DIR=/data NEXO_ENGINE_SCRIPT=/app/engine/dist/engine.mjs
USER nexo
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["nexo-server"]

FROM node:26.13.0-bookworm-slim AS web
WORKDIR /app
COPY --from=javascript /app/package.json /app/package-lock.json ./
COPY --from=javascript /app/engine/package.json engine/package.json
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=javascript /app/dist/nexo dist/nexo
ENV PORT=4000 NEXO_API_URL=http://backend:8080 NG_ALLOWED_HOSTS=localhost,127.0.0.1
USER node
EXPOSE 4000
CMD ["node","dist/nexo/server/server.mjs"]
