/** Set by the concurrency throttle before the message handler runs. */
export type ProxyTelemetryVar = {
  requestId: string;
  queueEnteredAt: number;
  queueStartedAt: number;
};

export type ProxyEnv = {
  Variables: {
    proxyTelemetry?: ProxyTelemetryVar;
  };
};
