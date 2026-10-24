// Child-test control only: an active handle proves that main explicitly exits.
setInterval(() => {}, 60_000);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
let startupWriteControl, pendingStartupWrite;
process.stderr.write = function (bytes, encoding, callback) {
  if (startupWriteControl && Buffer.from(bytes).toString("utf8").startsWith("ZEB_WORKER_STARTUP_V1 ")) {
    const done = typeof encoding === "function" ? encoding : callback;
    process.send?.({ event: "startup_write_seen" });
    if (startupWriteControl === "release") pendingStartupWrite = () => originalStderrWrite(bytes, done);
    else if (startupWriteControl === "error") queueMicrotask(() => done?.(new Error("synthetic-private-write-error")));
    return false;
  }
  return originalStderrWrite(bytes, encoding, callback);
};
process.on("message", (message) => {
  if (message && typeof message === "object" && message.event === "startup-write-control") {
    if (!["release", "error", "timeout"].includes(message.mode)) throw new Error("invalid output control");
    startupWriteControl = message.mode;
    process.send?.({ event: "startup_write_armed" });
  } else if (message === "release_startup_write") {
    const release = pendingStartupWrite;
    pendingStartupWrite = undefined;
    release?.();
  } else
  if (message && typeof message === "object" && message.event === "advance-main-clock") {
    const now = performance.now.bind(performance);
    const offset = message.milliseconds;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid synthetic main clock advance.");
    Object.defineProperty(performance, "now", { configurable: true, value: () => now() + offset });
    process.send?.({ event: "main_clock_" + message.tag });
  } else if (message && typeof message === "object" && message.event === "main-state") {
    process.send?.({ event: "main_state_" + message.tag, exitCode: process.exitCode ?? null, now: performance.now() });
  }
  else if (message === "stop") process.emit("SIGTERM");
  else if (message === "interrupt") process.emit("SIGINT");
  else if (message === "fatal")
    process.emit(
      "uncaughtException",
      new Error("synthetic-private-main-error"),
    );
  else if (message === "rejection")
    process.emit(
      "unhandledRejection",
      new Error("synthetic-private-main-rejection"),
      Promise.resolve(),
    );
});
