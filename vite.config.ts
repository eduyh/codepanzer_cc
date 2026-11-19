import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function emitBattlefieldHtmlPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'emit-battlefield-html',
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    closeBundle() {
      const indexPath = path.join(outDir, 'index.html');
      const bfPath = path.join(outDir, 'battlefield.html');
      if (!fs.existsSync(indexPath)) return;
      let html = fs.readFileSync(indexPath, 'utf8');
      html = html.replace(/<html([^>]*)>/i, (_full, attrs) =>
        /data-app-mode/i.test(attrs)
          ? `<html${attrs}>`
          : `<html${attrs} data-app-mode="battlefield">`
      );
      html = html.replace(
        /<title>[^<]*<\/title>/i,
        '<title>CodePanzer.py - BATTLEFIELD | 大会・観戦アリーナ</title>'
      );
      html = html
        .replace(/%2306b6d4/gi, '%23f59e0b')
        .replace(/%233b82f6/gi, '%23ef4444');
      fs.writeFileSync(bfPath, html, 'utf8');
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), emitBattlefieldHtmlPlugin()],
  build: {
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
