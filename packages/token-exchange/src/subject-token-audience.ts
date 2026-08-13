export function parseSubjectTokenAudience(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("subjectTokenAudience is required");
  }

  if (/\r|\n|\u2028|\u2029/u.test(value)) {
    throw new TypeError("subjectTokenAudience must be an exact single-line string");
  }

  return value;
}
