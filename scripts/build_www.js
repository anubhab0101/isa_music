// scripts/build_www.js - Bundles web client assets for Capacitor Android build
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const WWW_DIR = path.resolve(ROOT_DIR, 'www');

if (!fs.existsSync(WWW_DIR)) {
  fs.mkdirSync(WWW_DIR, { recursive: true });
}

const FILES_TO_COPY = [
  'index.html',
  'isa_music.js',
  'styles.css',
  'manifest.json',
  'sw.js'
];

for (const file of FILES_TO_COPY) {
  const src = path.join(ROOT_DIR, file);
  const dest = path.join(WWW_DIR, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`[build_www] Copied ${file} -> www/${file}`);
  }
}

console.log('[build_www] Web build assets prepared in www/');
