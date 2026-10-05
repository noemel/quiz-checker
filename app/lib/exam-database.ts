import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeExamDraft, type ExamDraft, type SavedExam } from "./exam-types";

type ExamDatabaseGlobal = typeof globalThis & {
  __examDatabase?: DatabaseSync;
};

interface ExamRow {
  id: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

const databaseGlobal = globalThis as ExamDatabaseGlobal;

function getDatabase() {
  if (databaseGlobal.__examDatabase) return databaseGlobal.__examDatabase;

  const databasePath = process.env.EXAM_DATABASE_PATH ?? path.join(process.cwd(), ".data", "exams.sqlite");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS exams (
      id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  databaseGlobal.__examDatabase = database;
  return database;
}

function mapRow(row: ExamRow): SavedExam {
  return {
    ...normalizeExamDraft(JSON.parse(row.data_json) as unknown),
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listExams() {
  const rows = getDatabase()
    .prepare("SELECT id, data_json, created_at, updated_at FROM exams ORDER BY updated_at DESC")
    .all() as unknown as ExamRow[];
  return rows.map(mapRow);
}

export function getExam(id: string) {
  const row = getDatabase()
    .prepare("SELECT id, data_json, created_at, updated_at FROM exams WHERE id = ?")
    .get(id) as unknown as ExamRow | undefined;
  return row ? mapRow(row) : null;
}

export function insertExam(draft: ExamDraft) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  database.prepare(
    "INSERT INTO exams (id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, JSON.stringify(draft), now, now);
  return getExam(id);
}

export function updateExam(id: string, draft: ExamDraft) {
  const database = getDatabase();
  const now = new Date().toISOString();
  const result = database.prepare(
    "UPDATE exams SET data_json = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(draft), now, id);
  return Number(result.changes) > 0 ? getExam(id) : null;
}

export function deleteExam(id: string) {
  const result = getDatabase().prepare("DELETE FROM exams WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}