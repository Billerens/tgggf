export interface DesktopBridge {
  mode: "desktop";
  apiBaseUrl: string;
}

export function createDesktopBridge(apiBaseUrl: string): DesktopBridge {
  return {
    mode: "desktop",
    apiBaseUrl,
  };
}

