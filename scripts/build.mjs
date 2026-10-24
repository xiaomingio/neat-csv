/*
Purpose: Build the extension host, file worker, and browser table resources.
*/
import { build } from 'esbuild';
import { rm, mkdir, copyFile } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'], outfile: 'dist/extension.js' }),
  build({ entryPoints: ['src/engine/worker.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist/worker.js' }),
  build({ entryPoints: ['src/webview/grid.ts'], bundle: true, platform: 'browser', target: 'es2022', outfile: 'dist/grid.js' }),
  copyFile('src/webview/style.css', 'dist/style.css'),
  build({ entryPoints: ['tests/smokeTest.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'], outfile: 'dist/smokeTest.js' }),
]);
