import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
});
