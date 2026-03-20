# ---- Build stage ----
FROM node:22 AS build

RUN npm install -g bun \
    && npm cache clean --force \
    && userdel -r node \
    && useradd -m -s /bin/bash -u 1000 claude \
    && mkdir -p /home/claude/.claude \
    && chown -R claude:claude /home/claude

USER claude
ENV PATH="/home/claude/.bun/bin:$PATH"

RUN bun install -g @anthropic-ai/claude-code

WORKDIR /app
COPY --chown=claude:claude package.json bun.lock* ./
RUN bun install --frozen-lockfile --production || bun install --production

# ---- Runtime stage ----
FROM node:22-slim

COPY --from=build /usr/local/bin/bun /usr/local/bin/

RUN userdel -r node \
    && useradd -m -s /bin/bash -u 1000 claude \
    && mkdir -p /home/claude/.claude \
    && chown -R claude:claude /home/claude

COPY --from=build --chown=claude:claude /home/claude/.bun /home/claude/.bun

USER claude
ENV PATH="/home/claude/.bun/bin:$PATH"

WORKDIR /app
COPY --from=build --chown=claude:claude /app/node_modules ./node_modules
COPY --chown=claude:claude package.json ./
COPY --chown=claude:claude bin/ ./bin/
COPY --chown=claude:claude src/proxy/ ./src/proxy/
COPY --chown=claude:claude src/plugin/ ./src/plugin/
COPY --chown=claude:claude src/logger.ts src/mcpTools.ts ./src/

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD bun -e "const r=await fetch('http://127.0.0.1:3456/health');process.exit(r.ok?0:1)"

ENV CLAUDE_PROXY_PASSTHROUGH=1 \
    CLAUDE_PROXY_HOST=0.0.0.0
ENTRYPOINT ["./bin/docker-entrypoint.sh"]
CMD ["./bin/claude-proxy-supervisor.sh"]
