import { normalizeExamDraft, type ExamDraft, type SavedExam } from "./exam-types";

export interface ExamRow {
  id: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

export interface ExamStore {
  list(): Promise<SavedExam[]>;
  find(id: string): Promise<SavedExam | null>;
  create(draft: ExamDraft): Promise<SavedExam>;
  replace(id: string, draft: ExamDraft): Promise<SavedExam | null>;
  remove(id: string): Promise<boolean>;
}

export const examColumns = "id, data_json, created_at, updated_at";

export const createExamsTableSql = `
  CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export function mapExamRow(row: ExamRow): SavedExam {
  return {
    ...normalizeExamDraft(JSON.parse(row.data_json) as unknown),
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}