import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { setRuntimeContext } from "./platform/runtimeContext";
import { getWrapperInfo } from "./platform/wrapperBridge";
import "./styles.css";

const wrapperInfo = getWrapperInfo(
  globalThis as unknown as Record<string, unknown>,
  typeof import.meta.env.VITE_BACKEND_URL === "string"
    ? import.meta.env.VITE_BACKEND_URL
    : "",
);
setRuntimeContext(wrapperInfo);

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    if (import.meta.env.PROD) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {
        // Non-fatal: app still works without SW.
      });
      return;
    }

    // In dev, service worker caching can serve stale JS and break IndexedDB migrations.
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      void Promise.all(registrations.map((registration) => registration.unregister()));
    });
    if ("caches" in window) {
      void caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("tg-gf-static-"))
            .map((key) => caches.delete(key)),
        ),
      );
    }
  });
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
