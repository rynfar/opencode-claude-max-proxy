import type { Hono } from "hono";
import type { ProxyEnv } from "../env";
import { createTelemetryRoutes } from "./routes";

/** Mounts `GET /telemetry`, `/telemetry/requests`, `/telemetry/summary` on the app. */
export function mountTelemetryRoutes(app: Hono<ProxyEnv>): void {
  app.route("/telemetry", createTelemetryRoutes());
}
