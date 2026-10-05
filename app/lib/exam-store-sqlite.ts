import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createExamsTableSql, mapExamRow, type ExamRow, type ExamStore } from "./exam-store";
import type { ExamDraft } from "./exam-types";

export function createSqliteExamStore(databasePath: string): ExamStore {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec(createExamsTableSql);

  function list() {
    const rows = database
      .prepare("SELECT id, data_json, created_at, updated_at FROM exams ORDER BY updated_at DESC")
      .all() as unknown as ExamRow[];
    return rows.map(mapExamRow);
  }

  function find(id: string) {
    const row = database
      .prepare("SELECT id, data_json, created_at, updated_at FROM exams WHERE id = ?")
      .get(id) as unknown as ExamRow | undefined;
    return row ? mapExamRow(row) : null;
  }

  function create(draft: ExamDraft) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    database
      .prepare("INSERT INTO exams (id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, JSON.stringify(draft), now, now);
    return find(id) as NonNullable<ReturnType<typeof find>>;
  }

  function replace(id: string, draft: ExamDraft) {
    const now = new Date().toISOString();
    const result = database
      .prepare("UPDATE exams SET data_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(draft), now, id);
    return Number(result.changes) > 0 ? find(id) : null;
  }

  function remove(id: string) {
    const result = database.prepare("DELETE FROM exams WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  return {
    list: async () => list(),
    find: async (id: string) => find(id),
    create: async (draft: ExamDraft) => create(draft),
    replace: async (id: string, draft: ExamDraft) => replace(id, draft),
    remove: async (id: string) => remove(id),
  };
}