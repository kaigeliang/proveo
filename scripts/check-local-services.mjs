import net from 'net';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });

function endpoint(name, value, defaultPort) {
  if (!value) throw new Error(`[dev] ${name} 未配置，请检查根目录 .env。`);
  const url = new URL(value);
  return {
    name,
    host: url.hostname || '127.0.0.1',
    port: Number(url.port || defaultPort),
  };
}

function checkTcp({ name, host, port }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const done = (error) => {
      socket.destroy();
      if (error) reject(new Error(`[dev] ${name} 无法连接 ${host}:${port}。`));
      else resolve();
    };
    socket.setTimeout(1500, () => done(new Error('timeout')));
    socket.once('connect', () => done());
    socket.once('error', done);
  });
}

try {
  await Promise.all([
    checkTcp(endpoint('PostgreSQL', process.env.DATABASE_URL, 5432)),
    checkTcp(endpoint('Redis', process.env.REDIS_URL, 6379)),
  ]);
  console.log('[dev] PostgreSQL / Redis connection checks passed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('[dev] 请先运行 npm run services:up，或直接运行 npm run dev:local。');
  process.exitCode = 1;
}
