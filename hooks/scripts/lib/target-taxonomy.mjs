// Canonical artifact taxonomy and reserved routing vocabulary.
//
// Phase 1 (artifact-aware routing) uses only the target-kind taxonomy and the
// classification version. The model-tier and effort vocabularies are declared
// here per doctrine D6 (symbolic tier over exact model ID) so later phases have
// a single source of truth, but nothing in Phase 1 consumes them — they are
// reserved constants, deliberately unused.

// §8.1 Target taxonomy. `mixed` is a scope-level classification, not an
// individual artifact kind; it is included so `isTargetKind` recognises it as
// part of the vocabulary, but classifyArtifact never returns it.
export const TARGET_KINDS = Object.freeze([
  'code-change',
  'design-document',
  'implementation-plan',
  'requirements-specification',
  'architecture-decision-record',
  'test-plan',
  'runbook-operations',
  'research-note',
  'configuration-infrastructure',
  'generic-document',
  'generic-text-artifact',
  'mixed',
  'unknown',
  'unsupported-binary',
]);

const TARGET_KIND_SET = new Set(TARGET_KINDS);

// Named members used across the classifier and discovery modules.
export const SCOPE_KIND_MIXED = 'mixed';
export const CODE_CHANGE_KIND = 'code-change';
export const CONFIG_INFRA_KIND = 'configuration-infrastructure';
export const GENERIC_DOCUMENT_KIND = 'generic-document';
export const GENERIC_TEXT_KIND = 'generic-text-artifact';
export const UNKNOWN_KIND = 'unknown';
export const UNSUPPORTED_BINARY_KIND = 'unsupported-binary';

export const CLASSIFICATION_VERSION = '1.0';

// D6 (reserved, Phase 1-unused): symbolic model tiers resolved to real provider
// models later. §13.2.
export const MODEL_TIERS = Object.freeze(['fast', 'balanced', 'quality', 'maximum']);

// §13.1 canonical effort vocabulary + compatibility alias. Reserved.
export const EFFORT_LEVELS = Object.freeze([
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export const EFFORT_ALIASES = Object.freeze({ none: 'minimal' });

export function isTargetKind(value) {
  return TARGET_KIND_SET.has(value);
}
