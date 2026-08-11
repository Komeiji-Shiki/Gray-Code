/**
 * Progress 工具路径辅助函数
 */

import {
  isDesignPathAllowed,
  isPlanPathAllowed,
  isProgressPathAllowed,
  isReviewPathAllowed,
} from '../../modules/settings/modeToolsPolicy';
import {
  DESIGN_PATH_SCOPE_LABEL,
  PLAN_PATH_SCOPE_LABEL,
  REVIEW_PATH_SCOPE_LABEL,
  ensureParentDir,
  isScopedPathAllowedWithMultiRoot,
} from '../shared/pathPolicy';
import type { ProgressArtifactRef } from './schema';

export { ensureParentDir };

const PROGRESS_ARTIFACT_KEYS = ['design', 'plan', 'review'] as const;
type ProgressArtifactKey = typeof PROGRESS_ARTIFACT_KEYS[number];

function getArtifactPathValidator(kind: ProgressArtifactKey): (path: string) => boolean {
  if (kind === 'design') return isDesignPathAllowed;
  if (kind === 'plan') return isPlanPathAllowed;
  return isReviewPathAllowed;
}

function getArtifactScopeLabel(kind: ProgressArtifactKey): string {
  if (kind === 'design') return DESIGN_PATH_SCOPE_LABEL;
  if (kind === 'plan') return PLAN_PATH_SCOPE_LABEL;
  return REVIEW_PATH_SCOPE_LABEL;
}

export function isProgressModePathAllowedWithMultiRoot(pathStr: string): boolean {
  return isScopedPathAllowedWithMultiRoot(pathStr, isProgressPathAllowed);
}

export function isProgressArtifactPathAllowedWithMultiRoot(
  kind: ProgressArtifactKey,
  pathStr: string
): boolean {
  return isScopedPathAllowedWithMultiRoot(pathStr, getArtifactPathValidator(kind));
}

export function validateProgressArtifactRefInput(
  value: unknown,
  options: {
    fieldName?: string;
    allowEmptyString?: boolean;
  } = {}
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `${options.fieldName || 'artifactRef'} must be an object`;
  }

  const allowEmptyString = options.allowEmptyString ?? true;
  for (const key of PROGRESS_ARTIFACT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;

    const rawValue = (value as Record<string, unknown>)[key];
    if (typeof rawValue !== 'string') {
      return `${options.fieldName || 'artifactRef'}.${key} must be a string`;
    }

    const normalized = rawValue.trim();
    if (!normalized) {
      if (allowEmptyString) continue;
      return `${options.fieldName || 'artifactRef'}.${key} must be a non-empty string`;
    }

    if (!isProgressArtifactPathAllowedWithMultiRoot(key, normalized)) {
      return `${options.fieldName || 'artifactRef'}.${key} must point to ${getArtifactScopeLabel(key)}`;
    }
  }

  return null;
}

export function normalizeProgressArtifactRef(value: unknown): ProgressArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const next: ProgressArtifactRef = {};
  for (const key of PROGRESS_ARTIFACT_KEYS) {
    const rawValue = (value as Record<string, unknown>)[key];
    if (typeof rawValue !== 'string') continue;
    const normalized = rawValue.trim();
    if (!normalized) continue;
    next[key] = normalized;
  }

  return next;
}

export function applyProgressArtifactPatch(
  current: ProgressArtifactRef,
  patch: unknown
): ProgressArtifactRef {
  const next: ProgressArtifactRef = { ...current };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return next;
  }

  for (const key of PROGRESS_ARTIFACT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;

    const rawValue = (patch as Record<string, unknown>)[key];
    const normalized = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!normalized) {
      delete next[key];
      continue;
    }

    next[key] = normalized;
  }

  return next;
}
