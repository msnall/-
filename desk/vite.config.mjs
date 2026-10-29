// Builds the review desk page (desk/ui) into out/desk-ui, served by desk/server.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(here, "ui"),
  base: "/",
  publicDir: false,
  build: {
    outDir: path.join(here, "../out/desk-ui"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  oxc: { jsx: { runtime: "automatic" } },
});
