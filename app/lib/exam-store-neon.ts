import { neon } from "@neondatabase/serverless";
import {
  createExamsTableSql,
  examColumns,
  mapExamRow,
  type ExamRow,
  type ExamStore,
} from "./exam-store";
import type { ExamDraft, SavedExam } from "./exam-types";

export function createNeonExamStore(connectionString: string): ExamStore {
  const sql = neon(connectionString);
  let schemaReady: Promise<unknown> | null = null;

  function prepareSchema() {
    schemaReady = sql.query(createExamsTableSql);
    return schemaReady;
  }

  async function ensureSchema() {
    if (!schemaReady) prepareSchema();
    try {
      await schemaReady;
    } catch {
      await prepareSchema();
    }
  }

  async function list() {
    await ensureSchema();
    const rows = (await sql.query(
      `SELECT ${examColumns} FROM exams ORDER BY updated_at DESC`,
    )) as unknown as ExamRow[];
    return rows.map(mapExamRow);
  }

  async function find(id: string) {
    await ensureSchema();
    const rows = (await sql.query(
      `SELECT ${examColumns} FROM exams WHERE id = $1`,
      [id],
    )) as unknown as ExamRow[];
    return rows[0] ? mapExamRow(rows[0]) : null;
  }

  async function create(draft: ExamDraft) {
    await ensureSchema();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await sql.query(
      "INSERT INTO exams (id, data_json, created_at, updated_at) VALUES ($1, $2, $3, $4)",
      [id, JSON.stringify(draft), now, now],
    );
    return (await find(id)) as SavedExam;
  }

  async function replace(id: string, draft: ExamDraft) {
    await ensureSchema();
    const now = new Date().toISOString();
    const result = await sql.query(
      "UPDATE exams SET data_json = $1, updated_at = $2 WHERE id = $3",
      [JSON.stringify(draft), now, id],
      { fullResults: true },
    );
    const rowCount = (result as unknown as { rowCount?: number | null }).rowCount ?? 0;
    return rowCount > 0 ? find(id) : null;
  }

  async function remove(id: string) {
    await ensureSchema();
    const result = await sql.query("DELETE FROM exams WHERE id = $1", [id], {
      fullResults: true,
    });
    const rowCount = (result as unknown as { rowCount?: number | null }).rowCount ?? 0;
    return rowCount > 0;
  }

  return { list, find, create, replace, remove };
}