#!/usr/bin/env node
// Auto-generate engineering docs (no heavy deps):
//   docs/api-reference.md — Mermaid ER + all Express routes grouped by module
//   docs/openapi.json    — minimal OpenAPI 3.0 paths skeleton (loadable in Swagger UI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = path.join(root, 'packages/db/prisma/schema.prisma');
const DOCS = path.join(root, 'docs');

// ── Prisma schema -> Mermaid ER ────────────────────────────────────────────────
const schema = fs.readFileSync(SCHEMA, 'utf-8');
const modelNames = new Set([...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]));
const enumNames = new Set([...schema.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]));

const SCALAR_MAP = {
  String: 'string',
  Int: 'int',
  BigInt: 'bigint',
  Float: 'float',
  Decimal: 'decimal',
  Boolean: 'bool',
  DateTime: 'datetime',
  Json: 'json',
  Bytes: 'bytes',
};

const entities = [];
const edges = [];
const pairSeen = new Set();

for (const block of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
  const name = block[1];
  const attrs = [];
  for (const raw of block[2].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
    const m = line.match(/^(\w+)\s+([\w.]+)(\[\])?(\?)?/);
    if (!m) continue;
    const [, field, baseType, isArray] = m;
    if (modelNames.has(baseType)) {
      // relation field -> edge (dedupe by unordered pair to keep the diagram readable)
      const key = [name, baseType].sort().join('::');
      if (!pairSeen.has(key)) {
        pairSeen.add(key);
        edges.push(isArray ? `  ${name} ||--o{ ${baseType} : "${field}"` : `  ${name} }o--|| ${baseType} : "${field}"`);
      }
      continue;
    }
    const type = SCALAR_MAP[baseType] || (enumNames.has(baseType) ? `enum_${baseType}` : baseType.toLowerCase());
    const isId = /@id\b/.test(line);
    const isUnique = /@unique\b/.test(line);
    attrs.push(`    ${type} ${field}${isId ? ' PK' : isUnique ? ' UK' : ''}`);
  }
  entities.push(`  ${name} {\n${attrs.join('\n')}\n  }`);
}

const erSection = `## 数据库 ER 图

_来源: \`packages/db/prisma/schema.prisma\` · ${modelNames.size} 个模型 · ${edges.length} 条关系 · 复现 \`node scripts/gen-docs.mjs\`_

关系边按无序模型对去重以保证可读性；完整字段与约束以 schema.prisma 为准。

\`\`\`mermaid
erDiagram
${edges.join('\n')}
${entities.join('\n')}
\`\`\`
`;

// ── Express routes -> API catalog + OpenAPI ────────────────────────────────────
const ROUTE_GLOBS = ['apps/api/src/routes', 'apps/api/src/lib'];
const routeFiles = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) routeFiles.push(p);
  }
};
ROUTE_GLOBS.forEach((g) => walk(path.join(root, g)));
routeFiles.push(path.join(root, 'apps/api/src/index.ts'));

const moduleLabel = (file) => {
  const rel = path.relative(root, file);
  if (rel.includes('/lib/routes/')) return path.basename(file, '.ts');
  if (rel.endsWith('routes.ts')) return path.basename(path.dirname(file));
  return path.basename(file, '.ts');
};

const byModule = new Map();
const openapiPaths = {};
const ROUTE_RE = /app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
let total = 0;

for (const file of routeFiles) {
  const src = fs.readFileSync(file, 'utf-8');
  const mod = moduleLabel(file);
  for (const m of src.matchAll(ROUTE_RE)) {
    const method = m[1].toUpperCase();
    const route = m[2];
    if (!route.startsWith('/')) continue;
    total += 1;
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod).push({ method, route });
    // OpenAPI: convert :param -> {param}
    const oaPath = route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    openapiPaths[oaPath] = openapiPaths[oaPath] || {};
    openapiPaths[oaPath][method.toLowerCase()] = {
      tags: [mod],
      summary: `${method} ${route}`,
      responses: { 200: { description: 'OK' } },
    };
  }
}

const sortedModules = [...byModule.keys()].sort();
let apiSection = `## API 接口清单

_来源: 扫描 \`apps/api/src\` 路由注册 · ${total} 个端点 · ${sortedModules.length} 个模块 · 复现 \`node scripts/gen-docs.mjs\`_

OpenAPI 3.0 骨架见 [\`docs/openapi.json\`](./openapi.json)，可直接载入 Swagger UI 浏览。

`;
for (const mod of sortedModules) {
  const rows = byModule.get(mod).sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
  apiSection += `### ${mod} (${rows.length})\n\n| Method | Path |\n|---|---|\n`;
  for (const r of rows) apiSection += `| ${r.method} | \`${r.route}\` |\n`;
  apiSection += '\n';
}

const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'CloneCast / AIGC 带货视频生成系统 API',
    version: '1.0.0',
    description: '自动生成的路径骨架；请求/响应 schema 以代码为准。',
  },
  servers: [{ url: 'http://localhost:3000' }],
  paths: openapiPaths,
};

fs.mkdirSync(DOCS, { recursive: true });
fs.writeFileSync(
  path.join(DOCS, 'api-reference.md'),
  await prettier.format(`# API 与数据库参考 (自动生成)\n\n${erSection}\n${apiSection}`, { parser: 'markdown' }),
);
fs.writeFileSync(path.join(DOCS, 'openapi.json'), await prettier.format(JSON.stringify(openapi), { parser: 'json' }));

console.log(
  JSON.stringify(
    {
      models: modelNames.size,
      enums: enumNames.size,
      relations: edges.length,
      endpoints: total,
      modules: sortedModules.length,
      outputs: ['docs/api-reference.md', 'docs/openapi.json'],
    },
    null,
    2,
  ),
);
