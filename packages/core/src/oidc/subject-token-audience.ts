declare const subjectTokenAudience: unique symbol;

export type SubjectTokenAudience = string & {
  readonly [subjectTokenAudience]: true;
};

export function parseSubjectTokenAudience(value: unknown): SubjectTokenAudience {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Subject-Token Audience is required");
  }

  if (/\r|\n|\u2028|\u2029/u.test(value)) {
    throw new TypeError("Subject-Token Audience must be an exact single-line string");
  }

  return value as SubjectTokenAudience;
}
