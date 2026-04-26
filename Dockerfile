# ---- Build stage ----
FROM oven/bun:1 AS build

WORKDIR /app
COPY package.json bun.lock* ./
# --ignore-scripts: skip the package's postinstall (which runs
# claude-code/install.cjs and downloads a platform-native binary). The
# build stage runs on debian/glibc; the runtime stage runs on alpine/musl.
# A binary downloaded for glibc cannot exec on musl (different dynamic
# loader paths) — yields ENOENT despite the file being present. The
# install is performed in the runtime stage instead so it matches the
# runtime libc.
RUN --mount=type=cache,target=/root/.bun \
    bun install --ignore-scripts

COPY tsconfig.json* ./
COPY bin/ ./bin/
COPY src/ ./src/
# Run bun build directly (not "bun run build") to skip postbuild hook,
# which calls "node --check" — unavailable in oven/bun image
RUN rm -rf dist && bun build bin/cli.ts src/proxy/server.ts --outdir dist --target node --splitting --external @anthropic-ai/claude-agent-sdk --external libsql --entry-naming '[name].js'

# ---- Runtime stage ----
FROM node:22-alpine

RUN deluser --remove-home node 2>/dev/null; \
    adduser -D -u 1000 claude \
    && mkdir -p /home/claude/.claude \
    && chown -R claude:claude /home/claude

USER claude
WORKDIR /app

COPY --from=build --chown=claude:claude /app/node_modules ./node_modules
COPY --from=build --chown=claude:claude /app/dist ./dist
COPY --from=build --chown=claude:claude /app/package.json ./

# Run claude-code's install.cjs in the runtime stage so the native binary
# matches the runtime libc (alpine/musl). The script is a no-op if the
# binary at bin/claude.exe is already correct for this platform; on a
# fresh build it replaces the 500-byte stub with the real binary.
RUN node /app/node_modules/@anthropic-ai/claude-code/install.cjs

# Make the installed binary visible on PATH as `claude` so PATH-based
# lookups (e.g. `claude auth status`, the SDK's PATH-lookup fallback)
# resolve to the same binary the SDK uses directly. Symlink rather than a
# shell wrapper — the SDK's subprocess launcher rejects shell wrappers on
# some code paths.
RUN mkdir -p /app/bin/shims \
    && ln -sf /app/node_modules/@anthropic-ai/claude-code/bin/claude.exe /app/bin/shims/claude
ENV PATH="/app/bin/shims:$PATH"
COPY --chown=claude:claude bin/docker-entrypoint.sh bin/claude-proxy-supervisor.sh ./bin/
RUN chmod +x ./bin/docker-entrypoint.sh ./bin/claude-proxy-supervisor.sh

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "const r=await fetch('http://127.0.0.1:3456/health');process.exit(r.ok?0:1)"

ENV CLAUDE_PROXY_PASSTHROUGH=1 \
    CLAUDE_PROXY_HOST=0.0.0.0 \
    IS_SANDBOX=1
ENTRYPOINT ["./bin/docker-entrypoint.sh"]
CMD ["./bin/claude-proxy-supervisor.sh"]
