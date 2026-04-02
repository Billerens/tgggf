import { useEffect, useState } from "react";

export type PwaInstallStatus = "installed" | "available" | "unavailable";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export function useAppInstallPrompt() {
  const [deferredInstallPrompt, setDeferredInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [pwaInstallStatus, setPwaInstallStatus] =
    useState<PwaInstallStatus>("unavailable");

  useEffect(() => {
    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true;
    if (isStandalone) {
      setPwaInstallStatus("installed");
      return;
    }

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      const promptEvent = event as BeforeInstallPromptEvent;
      setDeferredInstallPrompt(promptEvent);
      setPwaInstallStatus("available");
    };
    const onInstalled = () => {
      setDeferredInstallPrompt(null);
      setPwaInstallStatus("installed");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const onInstallPwa = async () => {
    if (!deferredInstallPrompt) return;
    await deferredInstallPrompt.prompt();
    try {
      await deferredInstallPrompt.userChoice;
    } catch {
      // ignore
    }
    setDeferredInstallPrompt(null);
    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true;
    setPwaInstallStatus(isStandalone ? "installed" : "unavailable");
  };

  return {
    pwaInstallStatus,
    onInstallPwa,
  };
}
