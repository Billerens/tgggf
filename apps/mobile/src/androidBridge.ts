export function resolveAndroidApiBase() {
  return "bridge://api";
}

if (process.env.NODE_ENV !== "test") {
  // Placeholder for future Capacitor plugin wiring.
  // eslint-disable-next-line no-console
  console.log(`[mobile] android api base: ${resolveAndroidApiBase()}`);
}

