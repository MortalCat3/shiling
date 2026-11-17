import { Client } from 'pg';
import { PgBoss } from 'pg-boss';
import { TASK_NAMES } from '../../ports/tasks.js';

export interface QueueMigrationOptions {
  readonly connectionString: string;
  readonly ownerRole: string;
  readonly runtimeRole: string;
}

function validateTarget(
  connectionString: string,
  ownerRole: string,
  runtimeRole: string,
): { databaseName: string } {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(ownerRole)) {
    throw new Error('数据库 ownerRole 必须是有效的小写 PostgreSQL 角色标识。');
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole) || runtimeRole === ownerRole) {
    throw new Error('数据库 runtimeRole 必须是与 ownerRole 不同的有效小写角色标识。');
  }
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^shiling(?:_[a-z0-9_]+)?$/.test(databaseName) ||
    !url.username
  ) {
    throw new Error('队列迁移只允许连接显式的拾灵专用数据库和迁移角色。');
  }
  return { databaseName };
}

/** Explicit migration operation. API and worker runtime must never call this function. */
export async function runQueueMigrations(options: QueueMigrationOptions): Promise<{
  schemaVersion: number;
  queues: readonly string[];
}> {
  const { databaseName } = validateTarget(
    options.connectionString,
    options.ownerRole,
    options.runtimeRole,
  );
  const client = new Client({
    connectionString: options.connectionString,
    application_name: 'shiling-queue-migrate',
    options: '-c timezone=UTC -c search_path=pg_catalog,public',
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  let boss: PgBoss | undefined;
  try {
    const connected = await client.query<{
      database: string;
      session_user: string;
      superuser: boolean;
      can_create_database_objects: boolean;
    }>(
      `SELECT current_database() AS database, session_user,
        (SELECT rolsuper FROM pg_roles WHERE rolname=session_user) AS superuser,
        has_database_privilege(session_user,current_database(),'CREATE') AS can_create_database_objects`,
    );
    const connection = connected.rows[0];
    if (connection?.database !== databaseName || connection.superuser || !connection.session_user) {
      throw new Error('队列迁移拒绝非预期数据库、超级用户或匿名连接。');
    }
    const schema = await client.query<{ owner: string }>(
      `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='pgboss'`,
    );
    const schemaOwner = schema.rows[0]?.owner;
    if (schemaOwner !== undefined && schemaOwner !== options.ownerRole) {
      const membership = await client.query<{ member: boolean }>(
        "SELECT pg_has_role(session_user,$1,'MEMBER') AS member",
        [options.ownerRole],
      );
      if (schemaOwner !== connection.session_user || !membership.rows[0]?.member) {
        throw new Error('既有 pgboss schema 不属于迁移连接或配置的对象所有者，拒绝接管。');
      }
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(connection.session_user)) {
        throw new Error('迁移连接角色名不是受支持的简单标识符。');
      }
      const temporaryCreate = !connection.can_create_database_objects;
      if (temporaryCreate) {
        await client.query(`SET ROLE "${options.ownerRole}"`);
        await client.query(
          `GRANT CREATE ON DATABASE "${databaseName}" TO "${connection.session_user}"`,
        );
        await client.query('RESET ROLE');
      }
      try {
        await client.query(`ALTER SCHEMA pgboss OWNER TO "${options.ownerRole}"`);
      } finally {
        if (temporaryCreate) {
          await client.query(`SET ROLE "${options.ownerRole}"`);
          await client.query(
            `REVOKE CREATE ON DATABASE "${databaseName}" FROM "${connection.session_user}"`,
          );
          await client.query('RESET ROLE');
        }
      }
    }
    await client.query(`SET ROLE "${options.ownerRole}"`);
    const role = await client.query<{ role: string }>('SELECT current_user AS role');
    if (role.rows[0]?.role !== options.ownerRole) {
      throw new Error('迁移连接未能切换到受控对象所有者角色。');
    }

    boss = new PgBoss({
      db: {
        async executeSql(text, values = []) {
          const result = await client.query(text, values);
          const results = Array.isArray(result) ? result : [result];
          return { rows: results.flatMap((entry) => entry.rows ?? []) };
        },
      },
      schema: 'pgboss',
      migrate: true,
      createSchema: true,
      schedule: false,
      supervise: false,
      reindex: false,
      registerInstance: false,
      openTelemetry: { enabled: false },
    });
    let queueError: unknown;
    boss.on('error', (error: unknown) => {
      queueError ??= error;
    });
    await boss.start();
    await boss.createQueue(TASK_NAMES.verify, {
      retryLimit: 2,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 15 * 60,
      retentionSeconds: 14 * 24 * 60 * 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
    });
    await boss.createQueue(TASK_NAMES.process, {
      retryLimit: 2,
      retryDelay: 10,
      retryBackoff: true,
      expireInSeconds: 20 * 60,
      retentionSeconds: 14 * 24 * 60 * 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
    });
    await boss.createQueue(TASK_NAMES.cleanup, {
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 15 * 60,
      retentionSeconds: 7 * 24 * 60 * 60,
      deleteAfterSeconds: 3 * 24 * 60 * 60,
    });
    const runtime = await client.query<{ superuser: boolean }>(
      'SELECT rolsuper AS superuser FROM pg_roles WHERE rolname=$1',
      [options.runtimeRole],
    );
    if (runtime.rows[0] === undefined || runtime.rows[0].superuser) {
      throw new Error('配置的运行角色不存在或是超级用户，拒绝授予队列权限。');
    }
    await client.query(`REVOKE CREATE ON SCHEMA pgboss FROM "${options.runtimeRole}"`);
    await client.query(`GRANT USAGE ON SCHEMA pgboss TO "${options.runtimeRole}"`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA pgboss TO "${options.runtimeRole}"`,
    );
    await client.query(
      `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO "${options.runtimeRole}"`,
    );
    await client.query(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO "${options.runtimeRole}"`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${options.ownerRole}" IN SCHEMA pgboss
       GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO "${options.runtimeRole}"`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${options.ownerRole}" IN SCHEMA pgboss
       GRANT USAGE,SELECT ON SEQUENCES TO "${options.runtimeRole}"`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${options.ownerRole}" IN SCHEMA pgboss
       GRANT EXECUTE ON FUNCTIONS TO "${options.runtimeRole}"`,
    );
    const schemaVersion = await boss.schemaVersion();
    if (schemaVersion === null)
      throw new Error('pg-boss schema migration did not record a version.');
    if (queueError !== undefined) throw queueError;
    return { schemaVersion, queues: Object.values(TASK_NAMES) };
  } finally {
    if (boss !== undefined) {
      await boss.stop({ close: false, graceful: true, timeout: 10_000 }).catch(() => undefined);
    }
    await client.query('RESET ROLE').catch(() => undefined);
    await client.end();
  }
}
