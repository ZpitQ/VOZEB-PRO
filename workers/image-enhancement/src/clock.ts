import { EnhancementError } from "./contracts.js";
import type { Clock } from "./execution.js";

const maxDelay = 2 ** 31 - 1;

export function createSystemClock(): Clock {
  function now(): number {
    const value = Date.now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new EnhancementError("configuration_invalid");
    return value;
  }

  return Object.freeze({
    now,
    scheduleAt(at: number, callback: () => void): () => void {
      if (!Number.isSafeInteger(at) || at < 0)
        throw new EnhancementError("configuration_invalid");
      const delay = Math.max(0, at - now());
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;

      function wake() {
        if (!active) return;
        timer = undefined;
        let remaining: number;
        try {
          remaining = at - now();
        } catch (error) {
          active = false;
          throw error;
        }
        if (remaining > 0) {
          timer = setTimeout(wake, Math.min(remaining, maxDelay));
          return;
        }
        active = false;
        callback();
      }

      timer = setTimeout(wake, Math.min(delay, maxDelay));
      return () => {
        if (!active) return;
        active = false;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
    },
  });
}
