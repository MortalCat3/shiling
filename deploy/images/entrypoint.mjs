import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Compose secret 入口适配：业务配置仅接收既有环境变量，不记录文件内容。
for (const key of [
  'SHILING_DATABASE_URL',
  'SHILING_MIGRATION_DATABASE_URL',
  'SHILING_SETUP_TOKEN',
  'SHILING_CSRF_SECRET',
  'SHILING_DELIVERY_SECRET',
]) {
  const filename = process.env[`${key}_FILE`];
  if (!filename) continue;
  if (process.env[key]) throw new Error(`${key} 与 ${key}_FILE 不得同时设置`);
  const value = (await readFile(filename, 'utf8')).trim();
  if (!value) throw new Error(`${key}_FILE 不能为空`);
  process.env[key] = value;
  delete process.env[`${key}_FILE`];
}
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('缺少容器启动命令');
const child = spawn(command, args, { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => {
  console.error('容器启动命令失败');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 1);
});
