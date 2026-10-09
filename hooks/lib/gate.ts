import type { ArchMap, Plan } from '../../types'

import { ownersOf, reach } from './map'
import { isSafeRelative, normalize } from './paths'

export type Mode = 'on-demand' | 'auto'
export type Enforcement = 'block' | 'warn' | 'off'

export const STATE_DIR = '.archgate'

/** A plan that still governs edits: waiting, approved, or sent back. */
export function isActive(plan: Plan | null): plan is Plan {
  return plan !== null && (plan.status === 'pending' || plan.status === 'approved' || plan.status === 'rejected')
}

export type PlanInput = {
  summary?: unknown
  modules?: unknown
  files?: unknown
  checks?: unknown
}

export type PlanDraft = Pick<Plan, 'summary' | 'modules' | 'files' | 'checks' | 'impact'>

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()))]
    : []

/** Checks a submitted plan against the map; `errors` empty means it stands. */
export function checkPlan(map: ArchMap, input: PlanInput): { draft: PlanDraft; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  if (summary === '') errors.push('summary: say what will change and why.')

  const known = new Set(map.modules.map(m => m.id))
  const modules = strings(input.modules)
  if (modules.length === 0) errors.push('modules: name at least one module id from the map.')
  const unknown = modules.filter(id => !known.has(id))
  if (unknown.length > 0) {
    errors.push(`modules: unknown id(s) ${unknown.join(', ')}. Known: ${[...known].join(', ')}.`)
  }

  const files = strings(input.files).map(f => normalize(f))
  for (const file of files) {
    if (!isSafeRelative(file)) {
      errors.push(`files: "${file}" must be project-relative.`)
      continue
    }
    const owners = ownersOf(map, file)
    if (owners.length === 0) {
      warnings.push(`files: "${file}" belongs to no module; it is allowed because it is listed.`)
    } else if (!owners.some(o => modules.includes(o))) {
      errors.push(`files: "${file}" belongs to ${owners.join(', ')}, which is not in modules. Add the module or drop the file.`)
    }
  }

  const checks = strings(input.checks)
  if (checks.length === 0) warnings.push('checks: no verification command planned; the result will be reported as unverified.')

  const impact = errors.length === 0 ? reach(map, modules, 'upstream') : []
  return { draft: { summary, modules, files, checks, impact }, errors, warnings }
}

/** Whether `draft` stays inside what `approved` already covers. */
export function isWithin(map: ArchMap, draft: PlanDraft, approved: Plan): boolean {
  return (
    draft.modules.every(m => approved.modules.includes(m)) &&
    draft.files.every(f => approved.files.includes(f) || ownersOf(map, f).some(o => approved.modules.includes(o)))
  )
}

export type EditContext = {
  map: ArchMap | null
  plan: Plan | null
  mode: Mode
  enforcement: Enforcement
  isPaused: boolean
  /** The file's project-relative path; null outside the project. */
  path: string | null
}

export type EditDecision = {
  verdict: 'allow' | 'deny' | 'warn'
  owners: string[]
  isInScope: boolean
  reason?: string
}

const TOOLS = 'mcp__archgate__archgate_map / archgate_plan'

/** Whether an edit to `path` may go ahead, and why not. */
export function decideEdit(c: EditContext): EditDecision {
  const owners = c.map !== null && c.path !== null ? ownersOf(c.map, c.path) : []
  const allow: EditDecision = { verdict: 'allow', owners, isInScope: true }
  if (c.enforcement === 'off' || c.path === null) return allow

  if (c.path === STATE_DIR || c.path.startsWith(`${STATE_DIR}/`)) {
    return {
      verdict: 'deny',
      owners,
      isInScope: false,
      reason: `${STATE_DIR}/ is written by archgate itself. Use ${TOOLS} to change the map or plan.`,
    }
  }
  if (c.isPaused) return allow

  const violate = (reason: string): EditDecision => ({
    verdict: c.enforcement === 'block' ? 'deny' : 'warn',
    owners,
    isInScope: false,
    reason,
  })

  const plan = c.plan
  if (isActive(plan)) {
    if (plan.status === 'pending') {
      return violate(`Plan #${plan.id} is waiting for the user's approval. Stop and wait; do not edit until they approve it.`)
    }
    if (plan.status === 'rejected') {
      const why = plan.rejectReason ? ` Reason: ${plan.rejectReason}.` : ''
      return violate(`The user rejected plan #${plan.id}.${why} Revise it and submit a new one with archgate_plan.`)
    }
    const isInScope = plan.files.includes(c.path) || owners.some(o => plan.modules.includes(o))
    if (isInScope) return allow
    const where = owners.length > 0 ? `module ${owners.join(', ')}` : 'no module in the map'
    return violate(
      `${c.path} belongs to ${where}, outside approved plan #${plan.id} (${plan.modules.join(', ')}). ` +
        'If it is needed, submit a widened plan with archgate_plan and wait for approval.',
    )
  }

  if (c.mode === 'auto') {
    return c.map === null
      ? violate('archgate is in auto mode and this project has no map yet. Map it with archgate_map, then submit a plan.')
      : violate('archgate is in auto mode: submit a plan with archgate_plan and wait for approval before editing.')
  }
  return allow
}

const CHECK = new RegExp(
  [
    '\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|lint|typecheck|check|build)\\b',
    '\\b(?:npx\\s+)?(?:tsc|eslint|prettier\\s+--check|vitest|jest|mocha|playwright\\s+test)\\b',
    '\\b(?:python3?\\s+-m\\s+)?(?:pytest|mypy|ruff|unittest)\\b',
    '\\bcargo\\s+(?:test|check|clippy|build)\\b',
    '\\bgo\\s+(?:test|vet|build)\\b',
    '\\b(?:make|just)\\s+(?:test|check|lint)\\b',
    '\\bclaude\\s+plugin\\s+(?:test|validate)\\b',
  ].join('|'),
)

/** Whether a shell command verifies the change: a planned check or a known runner. */
export function isCheck(command: string, planned: readonly string[]): boolean {
  const text = command.trim()
  return planned.some(p => text.includes(p)) || CHECK.test(text)
}

/** The planned checks that never ran, or whose last run failed. */
export function unverified(plan: Plan): string[] {
  return plan.checks.filter(check => {
    const runs = plan.checkRuns.filter(r => r.command.includes(check))
    return runs[runs.length - 1]?.isOk !== true
  })
}
