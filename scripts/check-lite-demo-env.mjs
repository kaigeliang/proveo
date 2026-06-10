#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const envFileArg = args.find((arg) => arg.startsWith('--env-file='));
const envFile = envFileArg ? envFileArg.split('=').slice(1).join('=') : '.env.lite';

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const rows = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u);
  const env = {};
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function isTruthyEnv(value) {
  if (!value) return false;
  return !['0', 'false', 'no', 'off', 'local'].includes(String(value).trim().toLowerCase());
}

function read(key, fileEnv) {
  return process.env[key] ?? fileEnv[key] ?? '';
}

const envPath = path.resolve(process.cwd(), envFile);
const fileEnv = parseEnvFile(envPath);
const errors = [];
const warnings = [];

if (!fs.existsSync(envPath)) {
  warnings.push(`${envFile} not found; checking shell environment only.`);
}

const blockedKeys = [
  'QWEN_VL_API_KEY',
  'QINGYUN_API_KEY',
];

for (const key of blockedKeys) {
  if (isTruthyEnv(read(key, fileEnv))) {
    errors.push(`${key} is set. This VPS profile must not use Qingyun/Qwen-VL credentials.`);
  }
}

const expected = {
  TRUSTLOOP_WEB_SEARCH: ['false', '0', 'off', 'no'],
  TREND_REFRESH_ENABLED: ['false', '0', 'off', 'no'],
  VECTOR_REINDEX_ENABLED: ['false', '0', 'off', 'no'],
  VECTOR_STORE_PROVIDER: ['off', 'none', 'false'],
  CLIP_ENABLED: ['false', '0', 'off', 'no'],
  CLIP_WARMUP_ENABLED: ['false', '0', 'off', 'no'],
  PGVECTOR_ENABLED: ['false', '0', 'off', 'no'],
  QDRANT_ENABLED: ['false', '0', 'off', 'no'],
};

for (const [key, allowed] of Object.entries(expected)) {
  const value = String(read(key, fileEnv)).trim().toLowerCase();
  if (!value) {
    warnings.push(`${key} is not set; docker-compose.lite.yml will force a safe lightweight value.`);
    continue;
  }
  if (!allowed.includes(value)) {
    errors.push(`${key}=${value} is not allowed for lightweight demo; expected one of ${allowed.join(', ')}.`);
  }
}

for (const key of ['ARK_API_KEY', 'ARK_TEXT_MODEL_ID', 'ARK_VIDEO_MODEL_ID']) {
  if (!read(key, fileEnv).trim()) {
    warnings.push(`${key} is empty; the app can start, but cloud script/video generation will degrade or fail.`);
  }
}

const webBase = read('PUBLIC_WEB_BASE_URL', fileEnv).trim();
const objectBase = read('OBJECT_STORAGE_PUBLIC_BASE_URL', fileEnv).trim();
if (webBase && !/^https?:\/\//i.test(webBase)) errors.push('PUBLIC_WEB_BASE_URL must start with http:// or https://.');
if (objectBase && !/^https?:\/\//i.test(objectBase)) {
  errors.push('OBJECT_STORAGE_PUBLIC_BASE_URL must start with http:// or https://.');
}

for (const warning of warnings) console.warn(`[lite-demo] warn: ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`[lite-demo] error: ${error}`);
  process.exit(1);
}

console.log('[lite-demo] environment check passed.');
console.log('[lite-demo] Qingyun/Qwen-VL and local vector workloads are disabled for this VPS profile.');
