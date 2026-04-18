/**
 * Transform pipeline — composable behavioral hooks for request/response processing.
 *
 * Adapters provide built-in transforms; plugins provide user-defined transforms.
 * Both use the same interface. The pipeline runner chains them in order, passing
 * each hook's output as the next hook's input.
 */

import type { FileChange } from "./fileChanges"
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk"

/**
 * A composable unit of request/response behavior.
 * Built-in adapter transforms and user plugins implement this interface.
 */
export interface Transform {
  /** Unique name for logging and UI display */
  name: string
  /** Human-readable description */
  description?: string
  /** Semver version string */
  version?: string
  /** Restrict to specific adapter names. Undefined = all adapters. */
  adapters?: string[]

  // v1 hooks
  onRequest?(ctx: RequestContext): RequestContext
  onResponse?(ctx: ResponseContext): ResponseContext
  onTelemetry?(ctx: TelemetryContext): void

  // Roadmap hooks (reserved, not yet called by the pipeline)
  onSession?(ctx: SessionContext): SessionContext
  onToolUse?(ctx: ToolUseContext): ToolUseContext
  onToolResult?(ctx: ToolResultContext): ToolResultContext
  onError?(ctx: ErrorContext): ErrorContext
}

/**
 * Request-time context. Transforms modify this to configure SDK behavior.
 * Immutable-in, modified-out — transforms return a new object.
 */
export interface RequestContext {
  /** Adapter name (readonly — set by pipeline runner) */
  readonly adapter: string
  /** Raw request body (readonly — use specific fields to modify) */
  readonly body: any
  /** Request headers (readonly) */
  readonly headers: Headers

  // Modifiable request fields
  model: string
  messages: any[]
  systemContext?: string
  tools?: any[]
  stream: boolean
  workingDirectory: string

  // SDK configuration (set by adapter transforms)
  blockedTools: readonly string[]
  incompatibleTools: readonly string[]
  allowedMcpTools: readonly string[]
  coreToolNames?: readonly string[]
  sdkAgents: Record<string, any>
  sdkHooks?: any
  passthrough?: boolean
  settingSources?: SettingSource[]
  supportsThinking: boolean
  shouldTrackFileChanges: boolean
  leaksCwdViaSystemReminder: boolean
  prefersStreaming?: boolean
  extractFileChangesFromToolUse?: (toolName: string, toolInput: unknown) => FileChange[]

  // Plugin-to-plugin state
  metadata: Record<string, unknown>
}

/**
 * Response-time context. Transforms can modify response content.
 */
export interface ResponseContext {
  readonly adapter: string
  content: any[]
  usage?: any
  metadata: Record<string, unknown>
}

/**
 * Telemetry context. Observe-only — return value is ignored.
 */
export interface TelemetryContext {
  readonly adapter: string
  readonly model: string
  readonly requestId: string
  readonly durationMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreationTokens: number
  readonly cacheHitRate: number
}

// Roadmap context types (reserved, not yet used)
export interface SessionContext { readonly adapter: string; [key: string]: unknown }
export interface ToolUseContext { readonly adapter: string; [key: string]: unknown }
export interface ToolResultContext { readonly adapter: string; [key: string]: unknown }
export interface ErrorContext { readonly adapter: string; [key: string]: unknown }

/** Hook names that transform request/response data (return value used) */
export type TransformHook = "onRequest" | "onResponse" | "onSession" | "onToolUse" | "onToolResult" | "onError"

/** Hook names that are observe-only (return value ignored) */
export type ObserveHook = "onTelemetry"

/**
 * Run a data-transforming hook through the pipeline.
 * Each transform receives the previous transform's output.
 * Transforms scoped to other adapters are skipped.
 */
export function runTransformHook<T>(
  transforms: readonly Transform[],
  hook: TransformHook,
  ctx: T,
  adapterName: string,
): T {
  return transforms.reduce<T>((acc, transform) => {
    const fn = transform[hook] as ((ctx: T) => T) | undefined
    if (!fn) return acc
    if (transform.adapters && !transform.adapters.includes(adapterName)) return acc
    try {
      return fn.call(transform, acc)
    } catch (err) {
      console.error(`[PLUGIN] Transform "${transform.name}" threw in ${hook}: ${err instanceof Error ? err.message : String(err)}`)
      return acc
    }
  }, ctx)
}

/**
 * Run an observe-only hook through the pipeline.
 * All matching transforms are called; return values are ignored.
 */
export function runObserveHook<T>(
  transforms: readonly Transform[],
  hook: ObserveHook,
  ctx: T,
  adapterName: string,
): void {
  for (const transform of transforms) {
    const fn = transform[hook] as ((ctx: T) => void) | undefined
    if (!fn) continue
    if (transform.adapters && !transform.adapters.includes(adapterName)) continue
    try {
      fn.call(transform, ctx)
    } catch (err) {
      console.error(`[PLUGIN] Transform "${transform.name}" threw in ${hook}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * Build the ordered transform pipeline for a request.
 * Adapter built-in transforms run first, then plugins in config order.
 */
export function buildPipeline(
  adapterTransforms: readonly Transform[],
  pluginTransforms: readonly Transform[],
): Transform[] {
  return [...adapterTransforms, ...pluginTransforms]
}

/**
 * Create the initial RequestContext from HTTP request data.
 * Adapter transforms will populate SDK configuration fields.
 */
export function createRequestContext(params: {
  adapter: string
  body: any
  headers: Headers
  model: string
  messages: any[]
  systemContext?: string
  tools?: any[]
  stream: boolean
  workingDirectory: string
}): RequestContext {
  return {
    adapter: params.adapter,
    body: params.body,
    headers: params.headers,
    model: params.model,
    messages: params.messages,
    systemContext: params.systemContext,
    tools: params.tools,
    stream: params.stream,
    workingDirectory: params.workingDirectory,
    // Defaults — adapter transforms override these
    blockedTools: [],
    incompatibleTools: [],
    allowedMcpTools: [],
    sdkAgents: {},
    supportsThinking: false,
    shouldTrackFileChanges: true,
    leaksCwdViaSystemReminder: false,
    metadata: {},
  }
}
