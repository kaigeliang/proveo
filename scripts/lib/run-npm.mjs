import { execFileSync } from 'node:child_process';

export function runNpm(args) {
  if (process.env.npm_execpath) {
    execFileSync(process.execPath, [process.env.npm_execpath, ...args], { stdio: 'inherit' });
    return;
  }
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { stdio: 'inherit' });
    return;
  }
  execFileSync('npm', args, { stdio: 'inherit' });
}
