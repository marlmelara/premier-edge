export async function register() {
  // Node-only setup lives in its own module: Next bundles this file for the
  // Edge runtime too, and a literal `node:dns` import here trips its static
  // analysis even when guarded at runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
