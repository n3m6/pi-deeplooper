// SystemClock — real-time clock adapter.

import type { Clock } from "../../application/port/index.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
