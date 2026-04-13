import type { WrapperBridge } from "./wrapperContract";

declare global {
  interface Window {
    tgWrapper?: WrapperBridge;
  }
}

export {};

