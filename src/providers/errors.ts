/**
 * Shared error types and utilities for all providers.
 */

export interface ClassifiedError {
  status: number;
  type: string;
  message: string;
}

export function isClosedControllerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("Controller is already closed");
}
