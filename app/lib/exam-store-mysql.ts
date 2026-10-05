import { createPool, type ResultSetHeader } from "mysql2/promise";
import { mapExamRow, type ExamRow, type ExamStore } from "./exam-store";
import type { ExamDraft, SavedExam } from "./exam-types";

const createExamsTableSql = `
  CREATE TABLE IF NOT EXISTS exams (
    id CHAR(36) PRIMARY KEY,
    data_json LONGTEXT NOT NULL,
    created_at VARCHAR(30) NOT NULL,
    updated_at VARCHAR(30) NOT NULL,
    INDEX exams_updated_at_idx (updated_at)
  ) ENGINE=InnoDB;
`;

export function createMysqlExamStore(connectionString: string): ExamStore {
  const pool = createPool(connectionString);
  let schemaReady: Promise<void> | null = null;

  function ensureSchema() {
    schemaReady ??= pool.execute(createExamsTableSql).then(() => undefined).catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });
    return schemaReady;
  }

  async function list() {
    await ensureSchema();
    const [rows] = await pool.execute(
      "SELECT id, data_json, created_at, updated_at FROM exams ORDER BY updated_at DESC",
    );
    return (rows as unknown as ExamRow[]).map(mapExamRow);
  }

  async function find(id: string) {
    await ensureSchema();
    const [rows] = await pool.execute(
      "SELECT id, data_json, created_at, updated_at FROM exams WHERE id = ?",
      [id],
    );
    const row = (rows as unknown as ExamRow[])[0];
    return row ? mapExamRow(row) : null;
  }

  async function create(draft: ExamDraft) {
    await ensureSchema();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await pool.execute(
      "INSERT INTO exams (id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [id, JSON.stringify(draft), now, now],
    );
    return (await find(id)) as SavedExam;
  }

  async function replace(id: string, draft: ExamDraft) {
    await ensureSchema();
    const now = new Date().toISOString();
    const [result] = await pool.execute<ResultSetHeader>(
      "UPDATE exams SET data_json = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(draft), now, id],
    );
    return result.affectedRows > 0 ? find(id) : null;
  }

  async function remove(id: string) {
    await ensureSchema();
    const [result] = await pool.execute<ResultSetHeader>("DELETE FROM exams WHERE id = ?", [id]);
    return result.affectedRows > 0;
  }

  return { list, find, create, replace, remove };
}