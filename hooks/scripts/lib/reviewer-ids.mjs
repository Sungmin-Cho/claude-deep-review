export const REVIEWER_IDS = Object.freeze([
  'claude-opus',
  'codex-review',
  'codex-adversarial',
  'agy',
]);

const REVIEWER_ID_SET = new Set(REVIEWER_IDS);

export function isReviewerId(value) {
  return REVIEWER_ID_SET.has(value);
}

