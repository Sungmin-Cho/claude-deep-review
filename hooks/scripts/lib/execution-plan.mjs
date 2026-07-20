import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isReviewerId } from './reviewer-ids.mjs';

function requiredReviewerId(reviewerId) {
  if (!isReviewerId(reviewerId)) throw new Error(`routing plan reviewer-id is not canonical: ${reviewerId}`);
  return reviewerId;
}

export function parseExecutionPlanDocument(document, reviewerId) {
  requiredReviewerId(reviewerId);
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('routing plan must be a JSON object');
  if (document.protocol_version !== '2.0') throw new Error('routing plan protocol_version must be "2.0"');
  const routes = Array.isArray(document.routes)
    ? document.routes
    : Array.isArray(document.reviewers) ? document.reviewers : null;
  if (!routes) throw new Error('routing plan must contain routes or reviewers');
  const route = routes.find((item) => item.reviewer_id === reviewerId);
  if (!route) throw new Error(`routing plan has no reviewer route for ${reviewerId}`);
  const requested = route.requested || route;
  const resolved = route.resolved || route;
  const source = requested.source || route.source || 'auto';
  return {
    model: resolved.model ?? null,
    effort: resolved.effort ?? null,
    requestedModel: requested.model ?? null,
    requestedEffort: requested.effort ?? null,
    source,
    modelSource: requested.model_source || source,
    effortSource: requested.effort_source || source,
    allowFallback: Boolean(route.fallback?.allowed ?? route.allow_fallback),
    modelTransport: route.transports?.model || route.model_transport,
    effortTransport: route.transports?.effort || route.effort_transport,
    routingFallback: route.fallback || null,
  };
}

export function loadExecutionPlan(filePath, reviewerId) {
  let document;
  try { document = JSON.parse(readFileSync(resolve(filePath), 'utf8')); }
  catch (error) { throw new Error(`failed to read routing plan ${filePath}: ${error.message}`); }
  return parseExecutionPlanDocument(document, reviewerId);
}
