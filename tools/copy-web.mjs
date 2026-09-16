// 把根目录的 3 个源文件（双击即可用的纯网页）同步到 Capacitor 的 webDir
// 源文件保持唯一事实来源，避免两处维护
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const www = resolve(root, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

for (const f of ['index.html', 'style.css', 'app.js']) {
  cpSync(resolve(root, f), resolve(www, f));
}

console.log('[copy-web] index.html / style.css / app.js -> www/');
