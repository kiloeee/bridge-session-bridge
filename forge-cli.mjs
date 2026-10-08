#!/usr/bin/env node
// Forge 本地 companion。语义模型调用由调用方注入：--backend-module 或 --backend-cmd，
// 二者都 provider 中立，CLI 本身不内置、不硬编码任何模型或厂商。
//
// 用法：
//   node forge-cli.mjs <input.json> [--out out.json]
//     [--backend-module model.mjs | --backend-cmd "本地模型命令"]
//     [--chunk-chars N] [--max-important N] [--strict]
//
// input.json: { session_id, previous_continuity|null, messages: [{messageId, role, content}],
//               full_exact_chars?, recent_exact? }
// 输出: { session_id, continuity, important_message_ids, stats, diagnostics, packet? }

import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { rollupForge, buildForgePacket, forgeStats, excludeRecentFromImportant, DEFAULT_CHUNK_CHARS, DEFAULT_MAX_IMPORTANT } from './src/forge.js';

function parseArgs(argv) {
  const args = { input: null, out: null, backendModule: null, backendCmd: null, chunkChars: DEFAULT_CHUNK_CHARS, maxImportant: DEFAULT_MAX_IMPORTANT, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--out') args.out = argv[++i];
    else if (flag === '--backend-module') args.backendModule = argv[++i];
    else if (flag === '--backend-cmd') args.backendCmd = argv[++i];
    else if (flag === '--chunk-chars') args.chunkChars = Number(argv[++i]);
    else if (flag === '--max-important') args.maxImportant = Number(argv[++i]);
    else if (flag === '--strict') args.strict = true;
    else if (!flag.startsWith('--')) args.input = flag;
    else throw new Error(`未知参数：${flag}`);
  }
  return args;
}

// 接受侧栏导出的 {messageId, role, content}，也接受 phase0 的 {messageId, role, text}。
function toEntry(item, index) {
  if (!item || typeof item !== 'object') throw new Error(`messages[${index}] 必须是对象。`);
  const messageId = item.messageId ?? item.message_id ?? item.id;
  const role = item.role;
  const text = item.text ?? item.content;
  if (messageId == null) throw new Error(`messages[${index}] 缺少 messageId。`);
  if (role !== 'user' && role !== 'assistant') throw new Error(`messages[${index}] 的 role 必须是 user/assistant。`);
  if (typeof text !== 'string') throw new Error(`messages[${index}] 的正文必须是字符串。`);
  return { messageId: String(messageId), role, text };
}

// 本地命令 backend：把一条请求的 JSON 写进 stdin，从 stdout 读回一条 JSON 响应。
// 命令由用户自行提供，是本地 companion 的唯一固定契约。
function commandModel(command) {
  return request => new Promise((resolveResponse, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`backend 命令退出码 ${code}`));
      try { resolveResponse(JSON.parse(out)); } catch (error) { reject(new Error(`backend 未返回 JSON：${error.message}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function moduleModel(path) {
  const mod = await import(pathToFileURL(resolve(path)).href);
  const fn = mod.default || mod.model;
  if (typeof fn !== 'function') throw new Error('backend module 必须默认导出 async function(request)。');
  return fn;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error('用法：node forge-cli.mjs <input.json> [--backend-module m.mjs | --backend-cmd "cmd"] [--out out.json]');
  const input = JSON.parse(readFileSync(resolve(args.input), 'utf8'));
  if (!Array.isArray(input.messages)) throw new Error('input.messages 必须是数组。');
  const entries = input.messages.map(toEntry);

  let model;
  if (args.backendModule) model = await moduleModel(args.backendModule);
  else if (args.backendCmd) model = commandModel(args.backendCmd);
  else throw new Error('需要 --backend-module 或 --backend-cmd 指定本地语义模型；CLI 不内置任何 provider。');

  const result = await rollupForge({
    entries,
    previousContinuity: input.previous_continuity ?? null,
    model,
    chunkChars: args.chunkChars,
    maxImportant: args.maxImportant,
    strict: args.strict,
  });

  const fullExactChars = Number.isFinite(input.full_exact_chars) ? input.full_exact_chars : null;
  const recentExact = typeof input.recent_exact === 'string' ? input.recent_exact : '';
  // Recent Exact 优先：若调用方给出最近轮的 messageId，就不让 Important Exact 重复这些原文。
  const dedup = Array.isArray(input.recent_message_ids)
    ? excludeRecentFromImportant(result.importantExact, input.recent_message_ids)
    : { items: result.importantExact, excludedIds: [], excludedChars: 0 };
  const importantItems = dedup.items;
  const output = {
    session_id: input.session_id ?? null,
    continuity: result.continuity,
    important_message_ids: importantItems.map(item => item.messageId),
    stats: forgeStats({ fullExactChars, continuity: result.continuity, importantExact: importantItems, recentExact }),
    diagnostics: { ...result.diagnostics, recentOverlapExcludedIds: dedup.excludedIds, recentOverlapExcludedChars: dedup.excludedChars },
  };
  if (recentExact) {
    output.packet = buildForgePacket({ continuity: result.continuity, importantExact: importantItems, recentExact });
  }

  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (args.out) {
    writeFileSync(resolve(args.out), json, 'utf8');
    process.stderr.write(`已写出 ${args.out}\n`);
  } else {
    process.stdout.write(json);
  }
}

main().catch(error => {
  process.stderr.write(`forge-cli 失败：${error.message}\n`);
  process.exit(1);
});
