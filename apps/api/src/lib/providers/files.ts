import fs from 'fs';

export function localPathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function ensureLocalDir(folder: string): void {
  fs.mkdirSync(folder, { recursive: true });
}

export function listLocalDir(folder: string): string[] {
  return fs.readdirSync(folder);
}

export function statLocalPath(filePath: string): fs.Stats {
  return fs.statSync(filePath);
}

export function localFileSize(filePath: string): number {
  return fs.statSync(filePath).size;
}

export function readLocalText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function readLocalBinary(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

export function writeLocalText(filePath: string, data: string): void {
  fs.writeFileSync(filePath, data, 'utf-8');
}

export function writeLocalBinary(filePath: string, data: NodeJS.ArrayBufferView): void {
  fs.writeFileSync(filePath, data);
}

export function renameLocalPath(source: string, target: string): void {
  fs.renameSync(source, target);
}

export function copyLocalFile(source: string, target: string): void {
  fs.copyFileSync(source, target);
}

export function removeLocalPath(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}
