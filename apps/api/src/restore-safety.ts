import {
  checkDatabaseReady,
  createDatabase,
  runRestoreSafety,
  type RestoreSafetyResult,
} from '@shiling/backend';

function usage(): string {
  return [
    '用法：pnpm --filter @shiling/api restore-safety [--apply|--verify]',
    '',
    '默认仅输出 dry-run 摘要；--apply 执行安全动作；--verify 只验证当前是否处于安全姿态。',
    '数据库连接只从 SHILING_DATABASE_URL 读取，且必须是 shiling 或 shiling_* 专用数据库。',
  ].join('\n');
}

function selectedMode(args: string[]): 'dry-run' | 'apply' | 'verify' | 'help' {
  const allowed = new Set(['--', '--apply', '--verify', '--help', '-h']);
  const unknown = args.filter((argument) => !allowed.has(argument));
  if (unknown.length) throw new Error(`不支持的参数：${unknown.join(' ')}`);
  if (args.includes('--help') || args.includes('-h')) return 'help';
  if (args.includes('--apply') && args.includes('--verify'))
    throw new Error('--apply 与 --verify 不能同时使用。');
  if (args.includes('--apply')) return 'apply';
  if (args.includes('--verify')) return 'verify';
  return 'dry-run';
}

function report(result: RestoreSafetyResult): Record<string, unknown> {
  return {
    event: 'restore-safety.result',
    mode: result.mode,
    changed: result.changed,
    safe: result.after.safe,
    before: {
      publicEnabled: result.before.publicEnabled,
      previewEnabled: result.before.previewEnabled,
      counts: result.before.counts,
    },
    after: {
      publicEnabled: result.after.publicEnabled,
      previewEnabled: result.after.previewEnabled,
      counts: result.after.counts,
      runtimeEpochRotated: result.before.runtimeEpoch !== result.after.runtimeEpoch,
      publicAccessEpochAdvanced:
        BigInt(result.after.publicAccessEpoch) > BigInt(result.before.publicAccessEpoch),
      previewAccessEpochAdvanced:
        BigInt(result.after.previewAccessEpoch) > BigInt(result.before.previewAccessEpoch),
    },
  };
}

async function main(): Promise<void> {
  const mode = selectedMode(process.argv.slice(2));
  if (mode === 'help') {
    console.info(usage());
    return;
  }
  const databaseUrl = process.env['SHILING_DATABASE_URL'];
  if (!databaseUrl) throw new Error('SHILING_DATABASE_URL 必须显式配置。');
  const database = createDatabase({
    connectionString: databaseUrl,
    applicationName: 'shiling-restore-safety',
    maxConnections: 1,
  });
  try {
    if (!(await checkDatabaseReady(database)))
      throw new Error('数据库迁移未达到当前版本，必须先执行 migrate。');
    const result = await runRestoreSafety(database, { mode });
    console.info(JSON.stringify(report(result)));
    if ((mode === 'apply' || mode === 'verify') && !result.after.safe) process.exitCode = 2;
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '灾备安全动作失败。');
  process.exitCode = 1;
});
