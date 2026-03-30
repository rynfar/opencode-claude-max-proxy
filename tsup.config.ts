import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    cli: "bin/cli.ts",
    server: "src/proxy/server.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  splitting: true,
  external: ["@anthropic-ai/claude-agent-sdk"],
  dts: false,
  clean: true,
  sourcemap: false,
})
