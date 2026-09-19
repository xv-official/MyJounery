// 把网页源文件同步到 Capacitor 的 webDir（www/）。
// 源文件保持唯一事实来源（浏览器里双击 index.html 仍可用）；
// 修改下面 ENTRIES 清单后执行：npm run build
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const www = resolve(root, 'www');

// ↓↓↓ 按实际网页文件/目录修改此清单（文件和目录都支持） ↓↓↓
const ENTRIES = ['index.html', 'style.css', 'app.js'];

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

for (const entry of ENTRIES) {
  const src = resolve(root, entry);
  if (!existsSync(src)) throw new Error(`[copy-web] 缺少源文件或目录: ${entry}`);
  cpSync(src, resolve(www, entry), { recursive: true });
}

console.log(`[copy-web] ${ENTRIES.length} 个条目已同步到 www/`);
