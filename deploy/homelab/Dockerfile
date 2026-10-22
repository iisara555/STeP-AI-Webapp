# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY packages/harness-core/package.json packages/harness-core/package.json
# The optional CA mount supports managed build environments without persisting their CA.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --strict-ssl=true
COPY web/ web/
COPY packages/ packages/
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
RUN node -e "if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(process.env.VITE_SUPABASE_URL || '') || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '')) throw Error('Provide a hosted Supabase URL and modern publishable key; server secrets are not accepted')" \
    && npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
COPY --chmod=0444 deploy/homelab/nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=101:101 /app/web/dist/ /usr/share/nginx/html/
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -Y off -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
