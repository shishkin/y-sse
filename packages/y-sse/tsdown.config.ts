import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  dts: {
    sourcemap: true,
  },
  exports: true,
});
