import { join } from "node:path"
import { homedir } from "node:os"
import { envBool, env, envInt } from "../env"
import { MemoryTelemetryStore } from "./store"
import { MemoryDiagnosticLogStore } from "./logStore"
import type { ITelemetryStore, IDiagnosticLogStore } from "./types"

function getDefaultDbPath(): string {
  return join(homedir(), ".config", "meridian", "telemetry.db")
}

function createStores(): { telemetry: ITelemetryStore; diagnostics: IDiagnosticLogStore } {
  if (!envBool("TELEMETRY_PERSIST")) {
    return {
      telemetry: new MemoryTelemetryStore(),
      diagnostics: new MemoryDiagnosticLogStore(),
    }
  }

  try {
    const { createSqliteStores } = require("./sqlite") as typeof import("./sqlite")
    const dbPath = env("TELEMETRY_DB") ?? getDefaultDbPath()
    const retention = envInt("TELEMETRY_RETENTION_DAYS", 7)
    const stores = createSqliteStores(dbPath, retention)
    console.error(`[telemetry] SQLite persistence enabled: ${dbPath} (${retention}d retention)`)
    return { telemetry: stores.telemetry, diagnostics: stores.diagnostics }
  } catch {
    console.warn("[telemetry] MERIDIAN_TELEMETRY_PERSIST is set but libsql is not installed. Run: npm install libsql")
    return {
      telemetry: new MemoryTelemetryStore(),
      diagnostics: new MemoryDiagnosticLogStore(),
    }
  }
}

const stores = createStores()

export const telemetryStore: ITelemetryStore = stores.telemetry
export const diagnosticLog: IDiagnosticLogStore = stores.diagnostics

export { MemoryTelemetryStore } from "./store"
export { MemoryDiagnosticLogStore } from "./logStore"
export { createTelemetryRoutes } from "./routes"
export { landingHtml } from "./landing"
export { computePercentiles, computeSummary } from "./percentiles"
export { renderPrometheusMetrics } from "./prometheus"
export { createSqliteStores } from "./sqlite"
export type {
  RequestMetric,
  TelemetrySummary,
  PhaseTiming,
  ITelemetryStore,
  IDiagnosticLogStore,
  DiagnosticLog,
} from "./types"
