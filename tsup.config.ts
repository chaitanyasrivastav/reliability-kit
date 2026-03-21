import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'], // generates index.js and index.mjs
  dts: true, // generates index.d.ts
  sourcemap: true,
  clean: true, // cleans dist/ before each build
  splitting: false,
})
