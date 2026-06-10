import fs from 'fs';
import { execFileSync } from 'child_process';
import prettier from 'prettier';

const supported = /\.(?:ts|tsx|js|json|css|md|yml|yaml)$/i;
const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
  encoding: 'utf8',
});
const files = output.split('\0').filter((file) => file && supported.test(file) && fs.existsSync(file));
const unformatted = [];

for (const file of files) {
  const info = await prettier.getFileInfo(file, { ignorePath: '.prettierignore' });
  if (info.ignored || !info.inferredParser) continue;
  const source = fs.readFileSync(file, 'utf8');
  const config = (await prettier.resolveConfig(file)) || {};
  const formatted = await prettier.format(source, { ...config, filepath: file });
  if (source !== formatted) unformatted.push(file);
}

if (unformatted.length) {
  console.error('Staged files need Prettier formatting:');
  unformatted.forEach((file) => console.error(`- ${file}`));
  process.exitCode = 1;
} else {
  console.log(`Prettier check passed for ${files.length} staged file(s).`);
}
