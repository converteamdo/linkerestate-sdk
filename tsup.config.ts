import { defineConfig } from "tsup"

// Three entry points, never bundled together: the browser build must not be
// able to reach the server credentials by import graph alone.
export default defineConfig({
  entry: ["src/client.ts", "src/server.ts", "src/catalog.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  treeshake: true,
  target: "es2022",
})
