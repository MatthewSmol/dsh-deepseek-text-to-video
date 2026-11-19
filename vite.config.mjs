/**
 * RU: Сборка браузерной части GenVideo через Vite. Формат — IIFE: DSH
 *     загружает `dist/client.js` как классический скрипт, который вызывает
 *     `window.__ModuleLoader__.load`. CSS импортируется с `?inline` и попадает
 *     строкой в бандл, поэтому отдельный файл стилей не нужен.
 * EN: GenVideo browser build through Vite. The format is IIFE: DSH loads
 *     `dist/client.js` as a classic script that calls
 *     `window.__ModuleLoader__.load`. CSS is imported with `?inline` and becomes
 *     a string inside the bundle, so no separate stylesheet is needed.
 */
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/client/client.ts'),
      formats: ['iife'],
      name: 'GenVideoClient',
      fileName: () => 'client.raw.js',
    },
    outDir: 'dist/vite-client',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: true,
  },
  define: {
    // RU: Vue ESM-сборка проверяет process.env.NODE_ENV; в браузере process
    //     нет, поэтому подставляем литерал на этапе сборки.
    // EN: Vue's ESM build reads process.env.NODE_ENV; browsers have no process,
    //     so the literal is substituted at build time.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  // RU: React приходит из таблицы модулей загрузчика через require, а не из
  //     node_modules — Vite не должен искать его при сборке.
  // EN: React comes from the loader's module table via require, not from
  //     node_modules — Vite must not resolve it at build time.
  optimizeDeps: { noDiscovery: true },
})
