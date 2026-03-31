import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/lmstudio/": {
        target: "https://t1.tun.uforge.online",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/lmstudio/, ""),
      },
      "/comfy/": {
        target: "https://t3.tun.uforge.online",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/comfy/, ""),
      },
    },
  },
});
