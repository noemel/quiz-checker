import { examTypes, type ValidationIssue } from "./exam-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateExamDraft(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return [{ field: "exam", message: "Exam data must be an object." }];
  }

  if (!isNonEmptyString(value.title)) {
    issues.push({ field: "title", message: "Enter an exam title." });
  } else if (value.title.trim().length > 120) {
    issues.push({ field: "title", message: "Exam titles must be 120 characters or fewer." });
  }

  const itemCount = value.itemCount;
  if (!Number.isInteger(itemCount) || typeof itemCount !== "number" || itemCount < 1 || itemCount > 100) {
    issues.push({ field: "itemCount", message: "Item count must be a whole number from 1 to 100." });
  }

  const legacyType = typeof value.type === "string" && examTypes.includes(value.type as (typeof examTypes)[number])
    ? value.type as (typeof examTypes)[number]
    : null;
  const suppliedTypeCounts = isRecord(value.typeCounts) ? value.typeCounts : null;
  const typeCounts = {} as Record<(typeof examTypes)[number], number>;
  for (const type of examTypes) {
    const count = suppliedTypeCounts?.[type] ?? (legacyType === type && typeof itemCount === "number" ? itemCount : 0);
    if (!Number.isInteger(count) || typeof count !== "number" || count < 0 || count > 100) {
      issues.push({ field: `typeCounts.${type}`, message: `${type} item count must be a whole number from 0 to 100.` });
      typeCounts[type] = 0;
    } else {
      typeCounts[type] = count;
    }
  }
  const countedItems = examTypes.reduce((total, type) => total + typeCounts[type], 0);
  if (countedItems < 1) {
    issues.push({ field: "typeCounts", message: "Assign at least one item to an exam type." });
  }
  if (typeof itemCount === "number" && countedItems !== itemCount) {
    issues.push({ field: "typeCounts", message: `Per-type counts total ${countedItems}; they must add up to ${itemCount}.` });
  }

  const questions = Array.isArray(value.questions) ? value.questions : [];
  if (!Array.isArray(value.questions)) {
    issues.push({ field: "questions", message: "Add the exam questions." });
  } else if (typeof itemCount === "number" && questions.length !== itemCount) {
    issues.push({
      field: "questions",
      message: `Create exactly ${itemCount} questions. There are currently ${questions.length}.`,
    });
  }

  if (typeCounts.matching > 0) {
    if (!isNonEmptyString(value.instructions)) {
      issues.push({ field: "instructions", message: "Add instructions for the matching section." });
    }
    const matchingChoices = Array.isArray(value.matchingChoices) ? value.matchingChoices : [];
    if (matchingChoices.length < 2 || matchingChoices.some((choice) => !isNonEmptyString(choice))) {
      issues.push({ field: "matchingChoices", message: "Add at least two non-empty matching choices." });
    } else if (new Set(matchingChoices.map((choice) => (choice as string).trim().toLowerCase())).size !== matchingChoices.length) {
      issues.push({ field: "matchingChoices", message: "Matching choices must be unique." });
    }
  }

  const actualCounts = Object.fromEntries(examTypes.map((type) => [type, 0])) as Record<(typeof examTypes)[number], number>;
  questions.forEach((question, index) => {
    const base = `questions.${index}`;
    if (!isRecord(question)) {
      issues.push({ field: base, message: `Question ${index + 1} is invalid.` });
      return;
    }

    if (!isNonEmptyString(question.id)) {
      issues.push({ field: `${base}.id`, message: `Question ${index + 1} needs an identifier.` });
    }
    if (!isNonEmptyString(question.prompt)) {
      issues.push({ field: `${base}.prompt`, message: `Enter question ${index + 1}.` });
    } else if (question.prompt.trim().length > 1000) {
      issues.push({ field: `${base}.prompt`, message: `Question ${index + 1} must be 1,000 characters or fewer.` });
    }

    const questionType = typeof question.type === "string" && examTypes.includes(question.type as (typeof examTypes)[number])
      ? question.type as (typeof examTypes)[number]
      : legacyType;
    if (!questionType) {
      issues.push({ field: `${base}.type`, message: `Choose an exam type for question ${index + 1}.` });
      return;
    }
    actualCounts[questionType] += 1;

    if (questionType === "multiple-choice") {
      const choices = Array.isArray(question.choices) ? question.choices : [];
      if (choices.length !== 4 || choices.some((choice) => !isNonEmptyString(choice))) {
        issues.push({ field: `${base}.choices`, message: `Complete choices A–D for question ${index + 1}.` });
      }
      if (!(["A", "B", "C", "D"] as unknown[]).includes(question.correctAnswer)) {
        issues.push({ field: `${base}.correctAnswer`, message: `Choose the correct answer for question ${index + 1}.` });
      }
    } else if (questionType === "true-false") {
      if (question.correctAnswer !== "True" && question.correctAnswer !== "False") {
        issues.push({ field: `${base}.correctAnswer`, message: `Choose True or False for question ${index + 1}.` });
      }
    } else if (questionType === "identification") {
      if (!isNonEmptyString(question.correctAnswer)) {
        issues.push({ field: `${base}.correctAnswer`, message: `Enter the correct answer for question ${index + 1}.` });
      }
    } else if (questionType === "matching") {
      const matchingChoices = Array.isArray(value.matchingChoices) ? value.matchingChoices : [];
      if (!isNonEmptyString(question.correctAnswer) || !matchingChoices.includes(question.correctAnswer)) {
        issues.push({ field: `${base}.correctAnswer`, message: `Select a matching choice for question ${index + 1}.` });
      }
    }
  });

  for (const type of examTypes) {
    if (actualCounts[type] !== typeCounts[type]) {
      issues.push({
        field: "questions",
        message: `${getTypeLabel(type)} requires ${typeCounts[type]} questions; ${actualCounts[type]} have been created.`,
      });
    }
  }

  return issues;
}

function getTypeLabel(type: (typeof examTypes)[number]) {
  switch (type) {
    case "multiple-choice": return "Multiple Choice";
    case "true-false": return "True or False";
    case "identification": return "Identification";
    case "matching": return "Matching Type";
  }
}