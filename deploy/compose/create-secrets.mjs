import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 仅创建新的本地凭据目录；目录已存在就失败，绝不轮换现有部署的密码。
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) {
  throw new Error('Usage: create-secrets.mjs [--output <new-directory>]');
}
const directory = args.length
  ? pathToFileURL(`${resolve(args[1])}/`)
  : new URL('./secrets.local/', import.meta.url);
await mkdir(directory, { mode: 0o700 });
const password = () => randomBytes(32).toString('base64url');
const appPassword = password();
const migrationPassword = password();
const values = {
  'postgres-password': password(),
  'app-password': appPassword,
  'migration-password': migrationPassword,
  'database-url': `postgresql://shiling_app:${appPassword}@postgres:5432/shiling`,
  'migration-database-url': `postgresql://shiling_migrate:${migrationPassword}@postgres:5432/shiling`,
  'setup-token': password(),
  'csrf-secret': password(),
  'delivery-secret': password(),
};
for (const [name, value] of Object.entries(values)) {
  // Compose 本地 secret 使用文件挂载；目录 0700 限制宿主访问，容器非 root 可读取文件。
  await writeFile(new URL(name, directory), `${value}\n`, { mode: 0o444, flag: 'wx' });
}
console.log(`已创建本地凭据目录：${fileURLToPath(directory)}；没有输出凭据值。`);
