import type { ArchMap, Plan, Staleness } from '../../types'

import { ownersOf } from './map'

export type RiskLevel = 'green' | 'amber' | 'red'

export type RiskReason =
  | { code: 'out'; count: number }
  | { code: 'failed'; checks: string[] }
  | { code: 'wide'; count: number; total: number }
  | { code: 'blocked'; count: number }
  | { code: 'core'; parts: string[] }
  | { code: 'impact'; parts: string[] }
  | { code: 'noChecks' }
  | { code: 'unmapped'; count: number }
  | { code: 'stale' }
  | { code: 'small' }

export type Risk = { level: RiskLevel; reasons: RiskReason[] }

/** A part many others depend on: this many direct users or more. */
const CORE_USERS = 3

/**
 * How careful the person should be with this plan, and why: red for
 * changes outside the plan, failed checks or a plan touching half the
 * project; amber for core parts, knock-on effects, blocked attempts,
 * missing checks, unmapped files or a stale map; green otherwise.
 */
export function assessRisk(map: ArchMap, plan: Plan, stale: Staleness | null): Risk {
  const red: RiskReason[] = []
  const amber: RiskReason[] = []
  const nameOf = (id: string) => map.modules.find(m => m.id === id)?.name ?? id

  const out = plan.touched.filter(f => !f.isInScope && !f.isBlocked).length
  if (out > 0) red.push({ code: 'out', count: out })

  const failed = plan.checks.filter(c => plan.checkRuns.filter(r => r.command.includes(c)).at(-1)?.isOk === false)
  if (failed.length > 0) red.push({ code: 'failed', checks: failed })

  if (map.modules.length >= 4 && plan.modules.length * 2 >= map.modules.length) {
    red.push({ code: 'wide', count: plan.modules.length, total: map.modules.length })
  }

  const blocked = plan.touched.filter(f => f.isBlocked).length
  if (blocked > 0) amber.push({ code: 'blocked', count: blocked })

  const core = plan.modules.filter(id => map.relations.filter(r => r.to === id).length >= CORE_USERS)
  if (core.length > 0) amber.push({ code: 'core', parts: core.map(nameOf) })

  if (plan.impact.length >= 2) amber.push({ code: 'impact', parts: plan.impact.map(nameOf) })
  if (plan.checks.length === 0) amber.push({ code: 'noChecks' })

  const unmapped = plan.files.filter(f => ownersOf(map, f).length === 0).length
  if (unmapped > 0) amber.push({ code: 'unmapped', count: unmapped })
  if (stale !== null) amber.push({ code: 'stale' })

  if (red.length > 0) return { level: 'red', reasons: [...red, ...amber] }
  if (amber.length > 0) return { level: 'amber', reasons: amber }
  return { level: 'green', reasons: [{ code: 'small' }] }
}
