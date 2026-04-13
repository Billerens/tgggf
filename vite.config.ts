import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = process.cwd();

type ArtifactRoute = {
  fileName: string;
  contentType: string;
  candidates: string[];
};

const artifactDownloadRoutes = new Map<string, ArtifactRoute>([
  [
    "/downloads/windows/tg-gf-windows.exe",
    {
      fileName: "tg-gf-windows.exe",
      contentType: "application/vnd.microsoft.portable-executable",
      candidates: [
        "dist/downloads/windows/tg-gf-windows.exe",
        "apps/desktop/release/tg-gf-windows.exe",
      ],
    },
  ],
  [
    "/downloads/android/tg-gf-android-debug.apk",
    {
      fileName: "tg-gf-android-debug.apk",
      contentType: "application/vnd.android.package-archive",
      candidates: [
        "dist/downloads/android/tg-gf-android-debug.apk",
        "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk",
      ],
    },
  ],
]);

function devArtifactDownloadsPlugin(): Plugin {
  return {
    name: "dev-artifact-downloads",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const requestPath = (req.url ?? "").split("?")[0];
        const route = artifactDownloadRoutes.get(requestPath);

        if (!route) {
          next();
          return;
        }

        const resolvedCandidates = route.candidates.map((candidate) =>
          path.resolve(projectRoot, candidate),
        );
        const filePath = resolvedCandidates.find((candidate) =>
          fs.existsSync(candidate),
        );

        if (!filePath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(
            `Artifact not found for ${requestPath}.\nChecked:\n${resolvedCandidates.join("\n")}`,
          );
          return;
        }

        const stat = fs.statSync(filePath);
        res.statusCode = 200;
        res.setHeader("Content-Type", route.contentType);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${route.fileName}"`,
        );
        res.setHeader("Content-Length", String(stat.size));
        res.setHeader("Cache-Control", "no-store");

        const stream = fs.createReadStream(filePath);
        stream.on("error", () => {
          if (!res.headersSent) {
            res.statusCode = 500;
          }
          res.end("Failed to read artifact file.");
        });
        stream.pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), devArtifactDownloadsPlugin()],
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
      "/api/": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
        secure: false,
      },
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    },
  },
});
