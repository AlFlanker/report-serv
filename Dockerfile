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

FROM maven:3.9.16-eclipse-temurin-21@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320 AS api-dependencies
WORKDIR /app
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY scripts/maven.mjs ./scripts/maven.mjs
COPY backend/pom.xml ./backend/pom.xml
ENV MAVEN_EXECUTABLE=/usr/bin/mvn
RUN --mount=type=cache,target=/app/.cache/maven --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export BUILD_CA_CERT=/run/secrets/proxy_ca; fi; \
    node scripts/maven.mjs -DskipTests dependency:go-offline

FROM api-dependencies AS api-build
COPY backend ./backend
COPY --from=web-build /app/dist/report-serv/browser ./backend/src/main/resources/static
RUN --mount=type=cache,target=/app/.cache/maven --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export BUILD_CA_CERT=/run/secrets/proxy_ca; fi; \
    node scripts/maven.mjs -DskipTests package

FROM eclipse-temurin:21-jre-jammy@sha256:dff6eb46527bd293a3c06bbbe9e64e8c9f91f01905b5abbdad31761c03059d2c AS runtime
WORKDIR /app
RUN groupadd --gid 10001 reports && useradd --uid 10001 --gid reports --no-create-home --shell /usr/sbin/nologin reports
COPY --from=api-build --chown=reports:reports /app/backend/target/report-serv.jar ./report-serv.jar
ENV HOST=0.0.0.0 PORT=3001
USER reports
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=45s --retries=5 \
  CMD curl --noproxy 127.0.0.1 --fail --silent --output /dev/null http://127.0.0.1:3001/api/ready
ENTRYPOINT ["java", "-jar", "/app/report-serv.jar"]
