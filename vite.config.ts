import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    },
    proxy: {
      "/lmstudio/": {
        target: "https://t1.tun.uforge.online",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/lmstudio/, ""),
      },
      "/lmstudioloc/": {
        target: "http://127.0.0.1:1234",
        changeOrigin: false,
        secure: false,
        rewrite: (path) => path.replace(/^\/lmstudioloc/, ""),
      },
      "/comfy/": {
        target: "https://t3.tun.uforge.online",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/comfy/, ""),
      },
      "/comfyloc/": {
        target: "http://127.0.0.1:8188",
        changeOrigin: false,
        secure: false,
        rewrite: (path) => path.replace(/^\/comfyloc/, ""),
      },
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    },
  },
});
