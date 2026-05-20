export class NDeepError extends Error {
  code: string;
  context?: Record<string, unknown>;

  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "NDeepError";
    this.code = code;
    this.context = context;
  }
}

export class ValidationError extends NDeepError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, context);
    this.name = "ValidationError";
  }
}

export class EventBusError extends NDeepError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("EVENT_BUS_ERROR", message, context);
    this.name = "EventBusError";
  }
}

export class BufferOverflowError extends EventBusError {
  constructor(capacity: number, size: number) {
    super("Buffer overflow: cannot emit event", { capacity, size });
    this.name = "BufferOverflowError";
    this.code = "BUFFER_OVERFLOW";
  }
}

export class IdempotencyError extends EventBusError {
  constructor(eventId: string) {
    super("Duplicate event detected", { eventId });
    this.name = "IdempotencyError";
    this.code = "DUPLICATE_EVENT";
  }
}

export class ConfigError extends NDeepError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("CONFIG_ERROR", message, context);
    this.name = "ConfigError";
  }
}

export class ToolError extends NDeepError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("TOOL_ERROR", message, context);
    this.name = "ToolError";
  }
}

export class TimeoutError extends ToolError {
  constructor(tool: string, timeoutMs: number) {
    super(`Tool ${tool} timed out after ${timeoutMs}ms`, { tool, timeoutMs });
    this.name = "TimeoutError";
    this.code = "TOOL_TIMEOUT";
  }
}

export class CircuitOpenError extends NDeepError {
  constructor(circuit: string) {
    super("CIRCUIT_OPEN", `Circuit breaker ${circuit} is open`, { circuit });
    this.name = "CircuitOpenError";
  }
}

export class PipelineHaltedError extends NDeepError {
  constructor(reason: string) {
    super("PIPELINE_HALTED", "Pipeline halted", { reason });
    this.name = "PipelineHaltedError";
  }
}

export class HandlerError extends NDeepError {
  constructor(handlerName: string, cause: Error) {
    super("HANDLER_ERROR", `Handler ${handlerName} failed: ${cause.message}`, { handlerName, cause: cause.message });
    this.name = "HandlerError";
  }
}
