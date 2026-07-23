import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const aiServiceUrl =
    process.env.AI_SERVICE_PROXY_TARGET ||
    env.AI_SERVICE_PROXY_TARGET ||
    process.env.VITE_AI_SERVICE_URL ||
    env.VITE_AI_SERVICE_URL ||
    "http://localhost:8600";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api/v1": {
          target: aiServiceUrl,
          changeOrigin: true,
        },
        "/health": {
          target: aiServiceUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
