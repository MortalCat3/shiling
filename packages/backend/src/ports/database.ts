export interface QueryResult<Row extends object = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface Queryable {
  query<Row extends object = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface Transaction extends Queryable {
  readonly inTransaction: true;
}

export interface Database extends Queryable {
  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
