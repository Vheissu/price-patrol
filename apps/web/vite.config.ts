import aurelia from "@aurelia/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const webPort = Number(process.env.PRICE_PATROL_WEB_PORT ?? 9000);
const apiUrl = process.env.PRICE_PATROL_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8787"}`;

export default defineConfig({
  esbuild: {
    target: "es2022"
  },
  server: {
    host: "127.0.0.1",
    port: Number.isFinite(webPort) ? webPort : 9000,
    strictPort: false,
    proxy: {
      "/api": {
        target: apiUrl,
        changeOrigin: true
      }
    }
  },
  plugins: [
    aurelia({ useDev: true }),
    tailwindcss()
  ]
});
