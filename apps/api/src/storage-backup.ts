import { resolve } from 'node:path';
import {
  createDatabase,
  createStorage,
  readStorageConfig,
  exportStorageBackup,
  restoreStorageBackup,
} from '@shiling/backend';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.includes('--help')) {
    console.info(
      'storage-backup [export|restore] <directory> --services-stopped\n仅备份/恢复对象；必须另行配对保存/恢复停写期间的 PostgreSQL dump。restore 会执行恢复安全动作。',
    );
    return;
  }
  const [mode, directory, stopped] = args;
  if (
    !['export', 'restore'].includes(mode ?? '') ||
    !directory ||
    stopped !== '--services-stopped' ||
    args.length !== 3
  )
    throw new Error('请使用 --help 查看用法，并先停止服务。');
  const connectionString = process.env['SHILING_DATABASE_URL'];
  if (!connectionString) throw new Error('SHILING_DATABASE_URL must be configured.');
  const storage = await createStorage(readStorageConfig());
  const database = createDatabase({
    connectionString,
    applicationName: 'shiling-storage-backup',
    maxConnections: 1,
  });
  try {
    const result = await (mode === 'export' ? exportStorageBackup : restoreStorageBackup)(
      database,
      storage,
      resolve(process.env['INIT_CWD'] ?? process.cwd(), directory),
    );
    console.info(JSON.stringify({ event: `storage-backup.${mode}.completed`, ...result }));
  } finally {
    await database.close();
  }
}
void main().catch(() => {
  // File paths, database URLs and provider error objects must not reach logs.
  console.error(
    '对象备份/恢复失败。请检查停服状态、配对清单、目标新前缀、权限与备份完整性；不要启动恢复实例。',
  );
  process.exitCode = 1;
});
