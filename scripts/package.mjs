// 商店发布包：只含运行时文件，确定性输出（固定时间戳 + 排序条目 + store 无压缩 + CRC32）。
// 用法：npm run package  ->  dist/bridge-v<manifest.version>-edge.zip
// ZIP 根目录直接就是 manifest.json，没有外层目录，可直接被 Edge/Chrome「加载解压缩的扩展」。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 运行时白名单：测试、脚本、fixtures、设计参考图、开发文档全部留在仓库，不进商店包。
const RUNTIME_FILES = [
  'manifest.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'src/archive.js',
  'src/background.js',
  'src/content.js',
  'src/db.js',
  'src/draft.js',
  'src/forge.js',
  'src/forge-lineage.js',
  'src/forge-provider.js',
  'src/markdown.js',
  'src/normalize.js',
  'src/outcome.js',
  'src/phase0.js',
  'src/rebuild.js',
  'src/recorder-bridge.js',
  'src/recorder-main.js',
  'src/transport.js',
  'src/web-forge.js',
  'sidepanel/index.html',
  'sidepanel/app.js',
  'sidepanel/style.css',
  'sidepanel/assets/background-panel.png',
  'sidepanel/assets/background-wide.png',
  'sidepanel/assets/icons-sheet.png',
  'sidepanel/assets/whale-success.png',
  'sidepanel/assets/whale-welcome.png',
  'sidepanel/assets/whale-working.png',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

// 固定 DOS 时间戳（2026-01-01 00:00:00），保证同一份输入产出同一份 zip。
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value & 0xffff, 0); return b; };
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0, 0); return b; };

function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    local.push(header, data);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ]));
    offset += header.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(local);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(localBuf.length), u16(0),
  ]);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;

const entries = RUNTIME_FILES
  .map(name => ({ name, data: readFileSync(join(root, name)) }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const byName = new Map(entries.map(entry => [entry.name, entry]));

// 发布包完整性：manifest.json 与侧栏 HTML/CSS 直接引用的每个文件都必须真的在包里。
// 这类"源码测试绿、发布包缺文件"的回归最容易漏，所以在这里硬失败而不是等 Edge 加载报错。
function collectManifestRefs(manifest) {
  const refs = new Set();
  const add = value => { if (typeof value === 'string' && value) refs.add(value); };
  add(manifest.background?.service_worker);
  add(manifest.side_panel?.default_path);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }
  for (const value of Object.values(manifest.icons || {})) add(value);
  for (const value of Object.values(manifest.action?.default_icon || {})) add(value);
  return refs;
}

function collectLocalRefs(text, base) {
  const refs = new Set();
  const isExternal = ref => /^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith('data:') || ref.startsWith('#');
  for (const match of text.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) addRef(refs, match[1], base, isExternal);
  for (const match of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) addRef(refs, match[1], base, isExternal);
  return refs;
}

function addRef(refs, ref, base, isExternal) {
  if (isExternal(ref)) return;
  refs.add(base + ref.replace(/^\.\//, ''));
}

const referenced = collectManifestRefs(manifest);
for (const name of ['sidepanel/index.html', 'sidepanel/style.css']) {
  const local = collectLocalRefs(byName.get(name).data.toString('utf8'), 'sidepanel/');
  for (const ref of local) referenced.add(ref);
}
const missing = [...referenced].filter(name => !byName.has(name)).sort();
if (missing.length) {
  console.error(`\n发布包缺少被引用的文件：\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`引用完整性：manifest 与侧栏 HTML/CSS 引用的 ${referenced.size} 个路径全部在包内`);

const zip = buildZip(entries);
const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `bridge-v${version}-edge.zip`);
writeFileSync(outFile, zip);

for (const entry of entries) console.log(`  ${String(entry.data.length).padStart(9)}  ${entry.name}`);
console.log(`\n${entries.length} files -> ${outFile}`);
console.log(`sha256 ${createHash('sha256').update(zip).digest('hex')}`);
