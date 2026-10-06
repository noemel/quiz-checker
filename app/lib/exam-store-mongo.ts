import { MongoClient, type Collection, type Document, type ObjectId } from "mongodb";
import { mapExamRow, type ExamRow, type ExamStore } from "./exam-store";
import type { ExamDraft, SavedExam } from "./exam-types";

interface MongoExamDocument extends Document {
  _id?: ObjectId;
  id: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

export function createMongoExamStore(connectionString: string): ExamStore {
  const client = new MongoClient(connectionString, { maxPoolSize: 5 });
  let collectionPromise: Promise<Collection<MongoExamDocument>> | null = null;

  function getCollection() {
    collectionPromise ??= (async () => {
      await client.connect();
      const databaseName = process.env.MONGODB_DATABASE?.trim();
      const collection = client.db(databaseName || undefined).collection<MongoExamDocument>("exams");
      await collection.createIndex({ id: 1 }, { unique: true });
      return collection;
    })().catch((error: unknown) => {
      collectionPromise = null;
      throw error;
    });
    return collectionPromise;
  }

  async function list() {
    const collection = await getCollection();
    const rows = await collection.find().sort({ updated_at: -1 }).toArray();
    return rows.map((row) => mapExamRow(row as ExamRow));
  }

  async function find(id: string) {
    const collection = await getCollection();
    const row = await collection.findOne({ id });
    return row ? mapExamRow(row as ExamRow) : null;
  }

  async function create(draft: ExamDraft) {
    const collection = await getCollection();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await collection.insertOne({
      id,
      data_json: JSON.stringify(draft),
      created_at: now,
      updated_at: now,
    });
    return (await find(id)) as SavedExam;
  }

  async function replace(id: string, draft: ExamDraft) {
    const collection = await getCollection();
    const now = new Date().toISOString();
    const result = await collection.updateOne(
      { id },
      { $set: { data_json: JSON.stringify(draft), updated_at: now } },
    );
    return result.matchedCount > 0 ? find(id) : null;
  }

  async function remove(id: string) {
    const collection = await getCollection();
    const result = await collection.deleteOne({ id });
    return result.deletedCount > 0;
  }

  return { list, find, create, replace, remove };
}