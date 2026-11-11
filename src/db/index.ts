import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config";
import { SCHEMA } from "./schema";

type DB = Database.Database;
const g = globalThis as unknown as { __minichatDb?: { path: string; db: DB } };

/** One connection per process (kept on globalThis so Next.js dev reloads reuse it). Migrates on first use. */
export function db(): DB {
  const path = resolve(config().dbPath);
  if (g.__minichatDb?.path === path) return g.__minichatDb.db;
  g.__minichatDb?.db.close();
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Database(path);
  conn.exec(SCHEMA);
  g.__minichatDb = { path, db: conn };
  return conn;
}
