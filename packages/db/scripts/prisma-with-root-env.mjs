import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function parseEnvFile(filePath) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }

  const parsed = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value.replace(/\\n/g, '\n');
  }
  return parsed;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const rootEnv = parseEnvFile(path.join(repoRoot, '.env'));
const runner = 'npx';
const result = spawnSync(runner, ['prisma', ...process.argv.slice(2)], {
  cwd: path.resolve(scriptDir, '..'),
  env: { ...rootEnv, ...process.env },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[prisma] failed to start ${runner}: ${result.error.message}`);
}

process.exit(result.status ?? 1);
