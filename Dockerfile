# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node-base

FROM node-base AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --no-fund --no-audit
COPY . .
RUN npm run build

FROM node-base AS s3-init
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --no-fund --no-audit
COPY --chown=node:node scripts/init-s3.mjs ./scripts/init-s3.mjs
USER node
CMD ["node", "scripts/init-s3.mjs"]

FROM eclipse-temurin:25-jdk-jammy@sha256:5ba254809ef542504d40d47271c7d6c4f240fe40ca1386259806d431f13b6b4f AS api-dependencies
WORKDIR /app
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY scripts/gradle.mjs scripts/java-home.mjs ./scripts/
COPY backend/gradlew backend/build.gradle.kts backend/settings.gradle.kts backend/gradle.properties ./backend/
COPY backend/gradle ./backend/gradle
RUN --mount=type=cache,target=/app/.cache/gradle --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export BUILD_CA_CERT=/run/secrets/proxy_ca; fi; \
    node scripts/gradle.mjs resolveDependencies

FROM api-dependencies AS api-build
COPY backend ./backend
COPY --from=web-build /app/dist/report-serv/browser ./backend/src/main/resources/static
RUN --mount=type=cache,target=/app/.cache/gradle --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export BUILD_CA_CERT=/run/secrets/proxy_ca; fi; \
    node scripts/gradle.mjs bootJar

FROM eclipse-temurin:25-jre-jammy@sha256:a4e9fb35b48412cafbf036dabe201f22ee5e96f789e975bd6866ba0cbec45d17 AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 reports && useradd --uid 10001 --gid reports --no-create-home --shell /usr/sbin/nologin reports
COPY --from=api-build --chown=reports:reports /app/backend/build/libs/report-serv.jar ./report-serv.jar
ENV HOST=0.0.0.0 PORT=3001
USER reports
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=45s --retries=5 \
  CMD curl --noproxy 127.0.0.1 --fail --silent --output /dev/null http://127.0.0.1:3001/api/ready
ENTRYPOINT ["java", "-jar", "/app/report-serv.jar"]
