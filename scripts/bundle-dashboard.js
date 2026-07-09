/**
 * Copies the dashboard's static export (packages/dashboard/out) into
 * packages/core/public, so `queueway start` can serve the real Next.js
 * dashboard automatically — no separate dashboard process/port needed.
 *
 * Run automatically as part of `npm run build` at the repo root.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'packages', 'dashboard', 'out');
const DEST = path.join(__dirname, '..', 'packages', 'core', 'public');

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (!fs.existsSync(SRC)) {
  console.error(`❌ Dashboard static export not found at ${SRC}`);
  console.error('   Run `npm run build` in packages/dashboard first.');
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
copyRecursive(SRC, DEST);
console.log(`✅ Bundled dashboard into ${path.relative(process.cwd(), DEST)}`);
