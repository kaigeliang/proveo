import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve('src/lib/scoring/scorer-model.json');
const target = path.resolve('dist/apps/api/src/lib/scoring/scorer-model.json');

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
