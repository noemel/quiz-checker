import path from "node:path";
import type { ExamStore } from "./exam-store";
import type { ExamDraft, SavedExam } from "./exam-types";

type ExamDatabaseGlobal = typeof globalThis & {
  __examStore?: Promise<ExamStore>;
};

const databaseGlobal = globalThis as ExamDatabaseGlobal;

async function createStore(): Promise<ExamStore> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    const { createNeonExamStore } = await import("./exam-store-neon");
    return createNeonExamStore(connectionString);
  }

  const { createSqliteExamStore } = await import("./exam-store-sqlite");
  const databasePath = process.env.EXAM_DATABASE_PATH ?? path.join(process.cwd(), ".data", "exams.sqlite");
  return createSqliteExamStore(databasePath);
}

function getStore() {
  databaseGlobal.__examStore ??= createStore();
  return databaseGlobal.__examStore;
}

export async function listExams(): Promise<SavedExam[]> {
  return (await getStore()).list();
}

export async function getExam(id: string): Promise<SavedExam | null> {
  return (await getStore()).find(id);
}

export async function insertExam(draft: ExamDraft): Promise<SavedExam> {
  return (await getStore()).create(draft);
}

export async function updateExam(id: string, draft: ExamDraft): Promise<SavedExam | null> {
  return (await getStore()).replace(id, draft);
}

export async function deleteExam(id: string): Promise<boolean> {
  return (await getStore()).remove(id);
}