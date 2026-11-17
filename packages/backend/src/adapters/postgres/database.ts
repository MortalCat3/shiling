import { Pool, type PoolClient } from 'pg';
import type { Database, QueryResult, Transaction } from '../../ports/database.js';

export interface DatabaseOptions {
  connectionString: string;
  applicationName?: string;
  maxConnections?: number;
}

export function createDatabase(options: DatabaseOptions): Database {
  const url = new URL(options.connectionString);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^shiling(?:_[a-z0-9_]+)?$/.test(databaseName) ||
    !url.username
  ) {
    throw new Error('必须显式使用 shiling 或 shiling_ 前缀的专用数据库和数据库角色。');
  }
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? 'shiling',
    connectionTimeoutMillis: 5000,
    options: '-c timezone=UTC -c search_path=pg_catalog,public',
  });

  async function verify(client: PoolClient): Promise<void> {
    const result = await client.query<{ database: string; superuser: boolean }>(
      'SELECT current_database() AS database, rolsuper AS superuser FROM pg_roles WHERE rolname=current_user',
    );
    const row = result.rows[0];
    if (row?.database !== databaseName || row.superuser)
      throw new Error('应用拒绝连接非预期数据库或使用超级用户。');
  }

  function transactionPort(client: PoolClient): Transaction {
    return {
      inTransaction: true,
      async query<Row extends object>(
        sql: string,
        values: readonly unknown[] = [],
      ): Promise<QueryResult<Row>> {
        const result = await client.query(sql, [...values]);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
      },
    };
  }

  return {
    async query<Row extends object>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      const client = await pool.connect();
      try {
        await verify(client);
        return await transactionPort(client).query<Row>(sql, values);
      } finally {
        client.release();
      }
    },
    async transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await verify(client);
        await client.query('BEGIN');
        try {
          const result = await work(transactionPort(client));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
