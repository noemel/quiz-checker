import { examTypes, type ExamDraft, type ExamQuestion, type ExamType, type ExamTypeCounts } from "./exam-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string" ? record[key] : "";
}

function createQuestion(
  number: number,
  type: ExamType,
  prompt: string,
  choices: string[],
  correctAnswer: string,
): ExamQuestion {
  return {
    id: `imported-question-${number}`,
    type,
    prompt,
    choices,
    correctAnswer,
  };
}

function ordinal(value: number) {
  const words: Record<number, string> = {
    1: "First",
    2: "Second",
    3: "Third",
    4: "Fourth",
    5: "Fifth",
    6: "Sixth",
    7: "Seventh",
    8: "Eighth",
    9: "Ninth",
    10: "Tenth",
  };
  if (words[value]) return words[value];

  const suffix = value % 100 >= 11 && value % 100 <= 13
    ? "th"
    : value % 10 === 1
      ? "st"
      : value % 10 === 2
        ? "nd"
        : value % 10 === 3
          ? "rd"
          : "th";
  return `${value}${suffix}`;
}

export function convertStructuredExam(value: unknown): ExamDraft | null {
  if (!isRecord(value) || !isRecord(value.parts)) return null;

  const parts = value.parts;
  const partNames = ["part_1_multiple_choice", "part_2_identification", "part_3_matching_type"];
  if (!partNames.some((name) => name in parts)) return null;

  const questions: ExamQuestion[] = [];
  let nextNumber = 1;
  const multipleChoice = isRecord(parts.part_1_multiple_choice) ? parts.part_1_multiple_choice : {};
  const multipleChoiceItems = Array.isArray(multipleChoice.items) ? multipleChoice.items : [];

  for (const rawItem of multipleChoiceItems) {
    const item = isRecord(rawItem) ? rawItem : {};
    const choices = isRecord(item.choices) ? item.choices : {};
    const number = typeof item.number === "number" && Number.isInteger(item.number) ? item.number : nextNumber;
    questions.push(createQuestion(
      number,
      "multiple-choice",
      readString(item, "question"),
      ["A", "B", "C", "D"].map((letter) => readString(choices, letter)),
      readString(item, "answer").toUpperCase(),
    ));
    nextNumber = Math.max(nextNumber, number + 1);
  }

  const identification = isRecord(parts.part_2_identification) ? parts.part_2_identification : {};
  const identificationItems = Array.isArray(identification.items) ? identification.items : [];
  for (const rawItem of identificationItems) {
    const item = isRecord(rawItem) ? rawItem : {};
    const number = typeof item.number === "number" && Number.isInteger(item.number) ? item.number : nextNumber;
    questions.push(createQuestion(
      number,
      "identification",
      readString(item, "question"),
      [],
      readString(item, "answer"),
    ));
    nextNumber = Math.max(nextNumber, number + 1);
  }

  const matching = isRecord(parts.part_3_matching_type) ? parts.part_3_matching_type : {};
  const columnA = isRecord(matching.column_a) ? matching.column_a : {};
  const columnB = isRecord(matching.column_b) ? matching.column_b : {};
  const answers = isRecord(matching.answers) ? matching.answers : {};
  const matchingChoices = Object.entries(columnB)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, choice]) => typeof choice === "string" ? choice : "");

  Object.entries(columnA)
    .sort(([left], [right]) => Number(left) - Number(right))
    .forEach(([rawNumber, prompt]) => {
      const number = Number(rawNumber);
      const answer = isRecord(answers[rawNumber]) ? answers[rawNumber] : {};
      const letter = readString(answer, "letter").toUpperCase();
      const correctAnswer = readString(answer, "answer") || readString(columnB, letter);
      questions.push(createQuestion(
        Number.isInteger(number) ? number : nextNumber,
        "matching",
        typeof prompt === "string" ? prompt : "",
        [],
        correctAnswer,
      ));
      nextNumber += 1;
    });

  questions.sort((left, right) => {
    const leftNumber = Number(left.id.replace("imported-question-", ""));
    const rightNumber = Number(right.id.replace("imported-question-", ""));
    return leftNumber - rightNumber;
  });

  const typeCounts = Object.fromEntries(examTypes.map((type) => [type, 0])) as ExamTypeCounts;
  for (const question of questions) typeCounts[question.type] += 1;

  const subject = readString(value, "subject").trim();
  const grade = typeof value.grade === "number" || typeof value.grade === "string" ? `Grade ${value.grade}` : "";
  const identity = [subject, grade].filter(Boolean).join(" ");
  const term = typeof value.term === "number"
    ? `${ordinal(value.term)} Term`
    : readString(value, "term").trim();
  const examType = readString(value, "exam_type").trim();
  const schoolYear = value.school_year === undefined ? "" : String(value.school_year);
  const titleDetails = [identity, [term, examType].filter(Boolean).join(" ")].filter(Boolean).join(" — ");
  const title = readString(value, "title").trim()
    || `${titleDetails}${titleDetails && schoolYear ? ` (${schoolYear})` : ""}`
    || "Imported Exam";
  const instructions = readString(value, "general_directions").trim()
    || "Match each item in Column A with the correct choice in Column B.";

  return {
    title,
    typeCounts,
    itemCount: questions.length,
    instructions,
    matchingChoices: matchingChoices.length > 0 ? matchingChoices : ["", ""],
    questions,
  };
}
