export const examTypes = [
  "multiple-choice",
  "true-false",
  "identification",
  "matching",
] as const;

export type ExamType = (typeof examTypes)[number];
export type ExamTypeCounts = Record<ExamType, number>;

export interface ExamQuestion {
  id: string;
  type: ExamType;
  prompt: string;
  choices: string[];
  correctAnswer: string;
}

export interface ExamDraft {
  title: string;
  typeCounts: ExamTypeCounts;
  itemCount: number;
  instructions: string;
  matchingChoices: string[];
  questions: ExamQuestion[];
}

export interface SavedExam extends ExamDraft {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export function normalizeExamDraft(value: unknown): ExamDraft {
  const source = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  const legacyType = examTypes.includes(source.type as ExamType)
    ? source.type as ExamType
    : "multiple-choice";
  const rawQuestions = Array.isArray(source.questions) ? source.questions : [];
  const questions = rawQuestions.map((rawQuestion, index): ExamQuestion => {
    const question = typeof rawQuestion === "object" && rawQuestion !== null
      ? rawQuestion as Record<string, unknown>
      : {};
    const type = examTypes.includes(question.type as ExamType)
      ? question.type as ExamType
      : legacyType;
    return {
      id: typeof question.id === "string" ? question.id : `question-${index + 1}`,
      type,
      prompt: typeof question.prompt === "string" ? question.prompt : "",
      choices: Array.isArray(question.choices)
        ? question.choices.filter((choice): choice is string => typeof choice === "string")
        : type === "multiple-choice" ? ["", "", "", ""] : [],
      correctAnswer: typeof question.correctAnswer === "string" ? question.correctAnswer : "",
    };
  });

  const typeCounts = {} as ExamTypeCounts;
  for (const type of examTypes) {
    const count = typeof source.typeCounts === "object" && source.typeCounts !== null
      ? (source.typeCounts as Record<string, unknown>)[type]
      : undefined;
    typeCounts[type] = Number.isInteger(count) && typeof count === "number" && count >= 0
      ? count
      : source.typeCounts === undefined && type === legacyType && Number.isInteger(source.itemCount) && typeof source.itemCount === "number"
        ? source.itemCount
        : questions.filter((question) => question.type === type).length;
  }

  return {
    title: typeof source.title === "string" ? source.title : "",
    typeCounts,
    itemCount: Object.values(typeCounts).reduce((total, count) => total + count, 0),
    instructions: typeof source.instructions === "string" ? source.instructions : "",
    matchingChoices: Array.isArray(source.matchingChoices)
      ? source.matchingChoices.filter((choice): choice is string => typeof choice === "string")
      : ["", ""],
    questions,
  };
}