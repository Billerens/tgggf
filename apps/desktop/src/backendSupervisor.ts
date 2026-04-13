export function resolveApiUrl(port: number) {
  return `http://127.0.0.1:${port}`;
}

export interface BackendSupervisorConfig {
  apiPort: number;
}

export function createBackendSupervisor(config: BackendSupervisorConfig) {
  return {
    apiUrl: resolveApiUrl(config.apiPort),
  };
}

