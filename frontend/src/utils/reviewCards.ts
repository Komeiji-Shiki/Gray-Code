import { extractPreviewText, isReviewDocPath } from './taskCards'

export type ReviewToolName =
  | 'create_review'
  | 'record_review_milestone'
  | 'finalize_review'
  | 'validate_review_document'

export type ReviewCardStatus = 'in_progress' | 'completed'
export type ReviewCardOverallDecision =
  | 'accepted'
  | 'conditionally_accepted'
  | 'rejected'
  | 'needs_follow_up'
  | null
export type ReviewCardDetectedFormat = 'unknown' | 'v2' | 'v3'

export interface ReviewCardIssue {
  severity?: 'error' | 'warning'
  code?: string
  message: string
}

export interface ReviewCardData {
  path?: string
  title?: string
  date?: string
  status?: ReviewCardStatus
  overallDecision?: ReviewCardOverallDecision
  totalMilestones?: number
  completedMilestones?: number
  currentProgress?: string
  reviewedModules?: string[]
  reviewedModulesCount?: number
  totalFindings?: number
  highCount?: number
  mediumCount?: number
  lowCount?: number
  latestConclusion?: string
  latestConclusionPreview?: string
  recommendedNextAction?: string
  recommendedNextActionPreview?: string
  isValid?: boolean
  issueCount?: number
  errorCount?: number
  warningCount?: number
  detectedFormat?: ReviewCardDetectedFormat
  canAutoUpgrade?: boolean
  issues?: ReviewCardIssue[]
  sourceTool: ReviewToolName
}

type LooseRecord = Record<string, unknown>
type SeverityCounts = { high: number; medium: number; low: number }

const REVIEW_TOOL_NAMES = new Set<ReviewToolName>([
  'create_review',
  'record_review_milestone',
  'finalize_review',
  'validate_review_document'
])

function asRecord(value: unknown): LooseRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as LooseRecord
    : undefined
}

function asRecordArray(value: unknown): LooseRecord[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .map((item) => asRecord(item))
    .filter((item): item is LooseRecord => !!item)
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asString(item))
    .filter((item): item is string => !!item)
}

function normalizeStatus(value: unknown): ReviewCardStatus | undefined {
  return value === 'in_progress' || value === 'completed'
    ? value
    : undefined
}

function normalizeDecision(value: unknown): ReviewCardOverallDecision | undefined {
  if (value === null) return null
  return value === 'accepted'
    || value === 'conditionally_accepted'
    || value === 'rejected'
    || value === 'needs_follow_up'
    ? value
    : undefined
}

function normalizeDetectedFormat(value: unknown): ReviewCardDetectedFormat | undefined {
  return value === 'unknown' || value === 'v2' || value === 'v3'
    ? value
    : undefined
}

function normalizeIssues(value: unknown): ReviewCardIssue[] {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => asRecord(item))
    .filter((item): item is LooseRecord => !!item && !!asString(item.message))
    .map((item) => ({
      severity: item.severity === 'error' || item.severity === 'warning'
        ? item.severity
        : undefined,
      code: asString(item.code),
      message: asString(item.message) || ''
    }))
}

function getSeverityCountsFromRecord(value: unknown): SeverityCounts | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  return {
    high: asNumber(record.high) || 0,
    medium: asNumber(record.medium) || 0,
    low: asNumber(record.low) || 0
  }
}

function getSeverityCountsFromFindings(findings: unknown): SeverityCounts | undefined {
  const records = asRecordArray(findings)
  if (!records) return undefined

  const counts: SeverityCounts = { high: 0, medium: 0, low: 0 }
  for (const item of records) {
    const severity = item.severity
    if (severity === 'high' || severity === 'medium' || severity === 'low') {
      counts[severity] += 1
    }
  }
  return counts
}

function countCompletedMilestones(milestones: unknown): number | undefined {
  const records = asRecordArray(milestones)
  if (!records) return undefined
  return records.filter((item) => item.status === 'completed').length
}

function countItems(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined
}

function deriveTitleFromPath(path?: string): string | undefined {
  const normalized = asString(path)
  if (!normalized) return undefined
  const segments = normalized.replace(/\\/g, '/').split('/')
  const fileName = segments[segments.length - 1] || normalized
  return fileName.replace(/\.md$/i, '').trim() || undefined
}

function getResultData(result: unknown): LooseRecord {
  const resultRecord = asRecord(result)
  return asRecord(resultRecord?.data) || {}
}

function buildValidationFallbackContent(data: LooseRecord): string {
  const issues = normalizeIssues(data.issues)
  const isValid = asBoolean(data.isValid)
  const lines = [
    `Valid: ${isValid === undefined ? 'unknown' : (isValid ? 'true' : 'false')}`,
    `Detected format: ${asString(data.detectedFormat) || 'unknown'}`,
    `Format version: ${data.formatVersion ?? 'unknown'}`,
    `Issues: ${issues.length}`
  ]

  for (const issue of issues) {
    lines.push(`- [${issue.severity || 'warning'}] ${issue.message}`)
  }

  return lines.join('\n')
}

export function isReviewToolName(name: string): name is ReviewToolName {
  return REVIEW_TOOL_NAMES.has(name as ReviewToolName)
}

export function formatReviewToolFallbackContent(
  toolName: ReviewToolName,
  args: Record<string, unknown> = {},
  result?: Record<string, unknown>
): string {
  const data = getResultData(result)

  if (toolName === 'create_review') {
    return asString(data.content) || asString(args.review) || ''
  }

  if (toolName === 'record_review_milestone') {
    return asString(data.content) || asString(args.summary) || ''
  }

  if (toolName === 'finalize_review') {
    return asString(data.content) || asString(args.conclusion) || ''
  }

  return buildValidationFallbackContent(data)
}

export function extractReviewCardData(
  toolName: ReviewToolName,
  args: Record<string, unknown> = {},
  result?: Record<string, unknown>
): ReviewCardData | null {
  const data = getResultData(result)
  const metadata = asRecord(data.metadata)
  const metadataMilestones = asRecordArray(metadata?.milestones)
  const metadataFindings = asRecordArray(metadata?.findings)
  const structuredFindings = asRecordArray(data.structuredFindings)
  const issues = normalizeIssues(data.issues)

  const rawPath = asString(data.path) || asString(args.path)
  const path = rawPath && isReviewDocPath(rawPath) ? rawPath : undefined

  const title =
    asString(data.title)
    || asString(args.title)
    || deriveTitleFromPath(path)

  const status =
    normalizeStatus(data.status)
    || normalizeStatus(data.currentStatus)
    || normalizeStatus(metadata?.status)
    || (toolName === 'create_review'
      ? 'in_progress'
      : toolName === 'finalize_review'
        ? 'completed'
        : undefined)

  const overallDecision =
    normalizeDecision(data.overallDecision)
    ?? normalizeDecision(metadata?.overallDecision)
    ?? (toolName === 'create_review' ? null : undefined)

  const totalMilestones =
    asNumber(data.totalMilestones)
    ?? asNumber(data.milestoneCount)
    ?? countItems(metadataMilestones)
    ?? (toolName === 'create_review' ? 0 : undefined)

  const completedMilestones =
    asNumber(data.completedMilestones)
    ?? countCompletedMilestones(metadataMilestones)
    ?? (toolName === 'create_review' ? 0 : undefined)

  const findingsBySeverity =
    getSeverityCountsFromRecord(data.findingsBySeverity)
    || getSeverityCountsFromFindings(structuredFindings)
    || getSeverityCountsFromFindings(metadataFindings)
    || (toolName === 'create_review'
      ? { high: 0, medium: 0, low: 0 }
      : undefined)

  const totalFindings =
    asNumber(data.totalFindings)
    ?? countItems(structuredFindings)
    ?? countItems(metadataFindings)
    ?? (findingsBySeverity
      ? findingsBySeverity.high + findingsBySeverity.medium + findingsBySeverity.low
      : undefined)
    ?? (toolName === 'create_review' ? 0 : undefined)

  const reviewedModules = asStringArray(data.reviewedModules).length > 0
    ? asStringArray(data.reviewedModules)
    : asStringArray(metadata?.reviewedModules)

  const latestConclusion = asString(data.latestConclusion) || asString(metadata?.latestConclusion)
  const recommendedNextAction = asString(data.recommendedNextAction) || asString(metadata?.recommendedNextAction)

  const latestConclusionPreview = latestConclusion
    ? extractPreviewText(latestConclusion, { maxLines: 3, maxChars: 220 })
    : undefined

  const recommendedNextActionPreview = recommendedNextAction
    ? extractPreviewText(recommendedNextAction, { maxLines: 2, maxChars: 140 })
    : undefined

  const issueCount = asNumber(data.issueCount) ?? (toolName === 'validate_review_document' ? issues.length : undefined)
  const errorCount = asNumber(data.errorCount)
    ?? (toolName === 'validate_review_document'
      ? issues.filter((issue) => issue.severity === 'error').length
      : undefined)
  const warningCount = asNumber(data.warningCount)
    ?? (toolName === 'validate_review_document'
      ? issues.filter((issue) => issue.severity === 'warning').length
      : undefined)

  const card: ReviewCardData = {
    path,
    title,
    date: asString(data.date),
    status,
    overallDecision,
    totalMilestones,
    completedMilestones,
    currentProgress: asString(data.currentProgress),
    reviewedModules,
    reviewedModulesCount: reviewedModules.length,
    totalFindings,
    highCount: findingsBySeverity?.high,
    mediumCount: findingsBySeverity?.medium,
    lowCount: findingsBySeverity?.low,
    latestConclusion,
    latestConclusionPreview,
    recommendedNextAction,
    recommendedNextActionPreview,
    isValid: asBoolean(data.isValid),
    issueCount,
    errorCount,
    warningCount,
    detectedFormat: normalizeDetectedFormat(data.detectedFormat),
    canAutoUpgrade: asBoolean(data.canAutoUpgrade),
    issues: issues.length > 0 ? issues : undefined,
    sourceTool: toolName
  }

  const hasMeaningfulData = Boolean(
    card.path
    || card.title
    || card.status
    || typeof card.totalMilestones === 'number'
    || typeof card.totalFindings === 'number'
    || typeof card.issueCount === 'number'
  )

  return hasMeaningfulData ? card : null
}
