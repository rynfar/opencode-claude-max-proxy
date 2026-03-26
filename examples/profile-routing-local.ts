import { startProxyServer } from "../src/proxy/server"

const port = Number.parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10)
const host = process.env.CLAUDE_PROXY_HOST || "127.0.0.1"

const personalDir = process.env.MERIDIAN_PERSONAL_CLAUDE_DIR
const companyDir = process.env.MERIDIAN_COMPANY_CLAUDE_DIR

if (!personalDir || !companyDir) {
  throw new Error("Set MERIDIAN_PERSONAL_CLAUDE_DIR and MERIDIAN_COMPANY_CLAUDE_DIR before running this example")
}

const proxy = await startProxyServer({
  port,
  host,
  profiles: [
    { id: "personal", claudeConfigDir: personalDir },
    { id: "company", claudeConfigDir: companyDir },
  ],
  defaultProfile: "personal",
})

const stop = async () => {
  await proxy.close()
  process.exit(0)
}

process.on("SIGINT", () => { void stop() })
process.on("SIGTERM", () => { void stop() })

console.log(`Profile test proxy running at http://${host}:${port}`)
console.log("Profiles: personal, company")
console.log("Use x-meridian-profile to select a profile per request")
