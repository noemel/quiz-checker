import path from "node:path";
import type { ExamStore } from "./exam-store";
import type { ExamDraft, SavedExam } from "./exam-types";

type ExamDatabaseGlobal = typeof globalThis & {
  __examStore?: Promise<ExamStore>;
};

const databaseGlobal = globalThis as ExamDatabaseGlobal;

async function createStore(): Promise<ExamStore> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const mongoConnectionString = process.env.MONGODB_URI?.trim()
    || process.env.MONGO_URL?.trim()
    || (databaseUrl?.startsWith("mongodb://") || databaseUrl?.startsWith("mongodb+srv://")
      ? databaseUrl
      : undefined);
  if (mongoConnectionString) {
    const { createMongoExamStore } = await import("./exam-store-mongo");
    return createMongoExamStore(mongoConnectionString);
  }

  const mysqlUrl = process.env.MYSQL_URL?.trim();
  const mysqlConnectionString = mysqlUrl ?? (databaseUrl?.startsWith("mysql://") ? databaseUrl : undefined);
  if (mysqlConnectionString) {
    const { createMysqlExamStore } = await import("./exam-store-mysql");
    return createMysqlExamStore(mysqlConnectionString);
  }

  if (databaseUrl) {
    const { createNeonExamStore } = await import("./exam-store-neon");
    return createNeonExamStore(databaseUrl);
  }

  if (process.env.VERCEL === "1") {
    throw new Error("MONGODB_URI, MYSQL_URL, or DATABASE_URL must be configured on Vercel.");
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