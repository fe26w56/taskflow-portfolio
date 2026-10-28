import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { Database, Statement } from '../src/v1/storage/d1/index.ts';
export class SQLiteD1 implements Database {
  sqlite: DatabaseSync;
  failAt: number | null = null;
  beforeBatch: (() => void) | null = null;
  constructor(all = false) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(dir).sort())
      if (
        all ||
        name.startsWith('0006') ||
        name.startsWith('0007') ||
        name.startsWith('0008') ||
        name.startsWith('0011') ||
        name.startsWith('0012')
      )
        this.sqlite.exec('BEGIN;\n' + readFileSync(new URL(name, dir), 'utf8') + '\nCOMMIT;');
  }
  prepare(sql: string): Statement {
    const db = this.sqlite;
    let values: unknown[] = [];
    return {
      bind(...args) {
        values = args;
        return this;
      },
      async first<T>() {
        return (db.prepare(sql).get(...(values as never[])) ??
          null) as T | null;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...(values as never[])) as T[] };
      },
      async run() {
        return db.prepare(sql).run(...(values as never[]));
      },
    };
  }
  async batch(statements: Statement[]) {
    const hook = this.beforeBatch;
    this.beforeBatch = null;
    hook?.();
    this.sqlite.exec('BEGIN');
    try {
      const result = [];
      for (let i = 0; i < statements.length; i++) {
        if (i === this.failAt) throw new Error('forced batch failure');
        result.push(await statements[i].run());
      }
      this.sqlite.exec('COMMIT');
      return result;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }
  count(table: string) {
    return (
      this.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;
  }
}
