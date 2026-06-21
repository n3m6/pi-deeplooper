// Barrel — keeps all existing import paths valid while the implementation
// lives in three focused modules:
//   telemetry-recorder.ts  — TelemetryRecorder + JsonlTelemetrySink (I/O)
//   telemetry-render.ts    — renderRunLog + renderMetricsSummary + helpers
//   domain-event-mapping.ts — domainEventToTelemetryEvent + map*Event functions

export { JsonlTelemetrySink, TelemetryRecorder } from "./telemetry-recorder.js";
export { createRunEventSummary, renderMetricsSummary, renderRunLog } from "./telemetry-render.js";
export { domainEventToTelemetryEvent } from "./domain-event-mapping.js";
export type { TelemetryEventPartial } from "./domain-event-mapping.js";
