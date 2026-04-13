import { createBackendSupervisor } from "./backendSupervisor.js";

export interface DesktopBootstrapContext {
  apiUrl: string;
}

export function createDesktopBootstrapContext(apiPort = 8787): DesktopBootstrapContext {
  const backend = createBackendSupervisor({ apiPort });
  return {
    apiUrl: backend.apiUrl,
  };
}

if (process.env.NODE_ENV !== "test") {
  const context = createDesktopBootstrapContext(Number(process.env.API_PORT || 8787));
  // Placeholder for Electron bootstrap.
  // eslint-disable-next-line no-console
  console.log(`[desktop] bootstrap context prepared: ${context.apiUrl}`);
}

