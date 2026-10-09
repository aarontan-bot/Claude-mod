import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { ArchMap, MapDelta, Plan, PlanStatus, TouchedFile } from '../types'
import { checkPlan, decideEdit, isActive, isCheck, isWithin, STATE_DIR, unverified } from './lib/gate'
import type { Enforcement, Mode } from './lib/gate'
import { strings, type Lang } from './lib/i18n'
import { checkMap, coverage, diffMaps, isEmptyDelta, ownersOf } from './lib/map'
import { relativeTo } from './lib/paths'
import { contextSection } from './lib/prompt'
import { moduleStates, renderReport, type ActivityEntry } from './lib/report'

type $ = EngineInterface

const PANE = 'archgate'
const MAP_FILE = `${STATE_DIR}/map.json`
const LOG_FILE = `${STATE_DIR}/activity.jsonl`
const REPORT_FILE = `${STATE_DIR}/report.html`
const MAX_LOG = 500
const MAX_EVIDENCE_READS = 60

const mapAtom = atom({ plugin: 'archgate', key: 'map' } as const, null)
const deltaAtom = atom({ plugin: 'archgate', key: 'delta' } as const, null)
const staleAtom = atom({ plugin: 'archgate', key: 'stale' } as const, null)
const planAtom = atom({ plugin: 'archgate', key: 'plan' } as const, null)
const seqAtom = atom({ plugin: 'archgate', key: 'planSeq' } as const, 0)
const pausedAtom = atom({ plugin: 'archgate', key: 'isPaused' } as const, false)

const MAP_TOOL = {
  name: 'archgate_map',
  isDeferred: false,
  description:
    'Record the architecture map of this project: its modules, the paths each owns, the evidence for it, and how modules depend on each other. ' +
    'Read the code first; every module should cite source evidence with line ranges. Replaces the whole map, so send every module each time. ' +
    'Returns a receipt: validation, evidence checks, how many tracked files the modules cover, and what changed since the last revision.',
  inputSchema: {
    type: 'object',
    required: ['project', 'modules', 'relations'],
    properties: {
      project: { type: 'string', description: 'Project name.' },
      modules: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name', 'responsibility', 'paths'],
          properties: {
            id: { type: 'string', description: 'Stable id: lowercase letters, digits, "-".' },
            name: { type: 'string', description: "Short name, in the user's language." },
            responsibility: { type: 'string', description: 'What it is responsible for, one or two sentences.' },
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Project-relative folders, files or globs it owns (a folder owns everything below it).',
            },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                required: ['path'],
                properties: {
                  path: { type: 'string' },
                  lines: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
      },
      relations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['from', 'to'],
          properties: {
            from: { type: 'string', description: 'The module that depends on / calls the other.' },
            to: { type: 'string' },
            label: { type: 'string', description: 'What flows, in a few words.' },
          },
        },
      },
    },
  },
}

const PLAN_TOOL = {
  name: 'archgate_plan',
  isDeferred: false,
  description:
    'Declare the scope of a code change before editing: the map modules it touches, the specific files if known, and the shell commands that will verify it. ' +
    'The user approves it in the archgate pane; edits outside an approved plan are refused or flagged. ' +
    'After submitting, end your turn and wait for approval. Submitting again replaces the plan; one within the approved scope is approved at once.',
  inputSchema: {
    type: 'object',
    required: ['summary', 'modules'],
    properties: {
      summary: { type: 'string', description: 'What will change, the behaviour expected, and why, in the user\'s language.' },
      modules: { type: 'array', items: { type: 'string' }, description: 'Module ids from the map that will be edited.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Project-relative files expected to change.' },
      checks: { type: 'array', items: { type: 'string' }, description: 'Shell commands that verify the change, e.g. "npm test".' },
    },
  },
}

const COMPLETE_TOOL = {
  name: 'archgate_complete',
  isDeferred: false,
  description:
    'Close the current plan once the work is done, has failed, or is abandoned. ' +
    'archgate reports planned checks that never ran or last failed as unverified.',
  inputSchema: {
    type: 'object',
    required: ['outcome'],
    properties: {
      outcome: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
      note: { type: 'string', description: 'What was done and anything left open.' },
    },
  },
}

let mode: Mode = 'on-demand'
let enforcement: Enforcement = 'block'
let lang: Lang = 'zh'
let t = strings(lang)
let root = ''

async function cwd($: $) {
  if (root === '') root = await $.session.cwd()
  return root
}
async function now($: $): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

async function git($: $, args: string[]): Promise<string | null> {
  try {
    const run = await $.process.run(['git', ...args], { cwd: await cwd($), timeoutMs: 15_000 })
    return run.exitCode === 0 ? run.stdout : null
  } catch {
    return null
  }
}

async function readActivity($: $): Promise<ActivityEntry[]> {
  const text = await $.fs.read(`${await cwd($)}/${LOG_FILE}`).catch(() => '')
  const entries: ActivityEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as ActivityEntry)
    } catch {
      // a hand-edited line; skip it
    }
  }
  return entries
}

async function log($: $, entry: Omit<ActivityEntry, 'at'>) {
  const entries = [...(await readActivity($)), { at: await now($), ...entry }].slice(-MAX_LOG)
  await $.fs
    .write(`${await cwd($)}/${LOG_FILE}`, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
    .catch(() => undefined)
}

function statusLine(map: ArchMap | null, plan: Plan | null, isPaused: boolean): string | undefined {
  if (isPaused) return `archgate: ${t.paused}`
  if (plan !== null && isActive(plan)) {
    const phase = plan.status === 'approved' && plan.touched.length > 0 ? t.editing : t.status[plan.status]
    const out = plan.touched.filter(f => !f.isInScope).length
    return `archgate #${plan.id}: ${phase}${out > 0 ? ` · ${t.outOfScope} ${out}` : ''}`
  }
  return map === null ? undefined : `archgate: r${map.revision} · ${map.modules.length} ${t.modules}`
}

/** Redraws what is derived from state: the status line and the report. */
async function refresh($: $) {
  const [map, plan, stale, isPaused] = await Promise.all([
    read($, mapAtom),
    read($, planAtom),
    read($, staleAtom),
    read($, pausedAtom),
  ])
  $.ui.status(statusLine(map, plan, isPaused))
  if (map === null) return
  const html = renderReport({ map, plan, stale, activity: await readActivity($), lang, now: await now($) })
  await $.fs.write(`${await cwd($)}/${REPORT_FILE}`, html).catch(() => undefined)
}

async function loadMap($: $): Promise<ArchMap | null> {
  try {
    const raw = JSON.parse(await $.fs.read(`${await cwd($)}/${MAP_FILE}`)) as ArchMap
    const checked = checkMap(raw)
    if (checked.errors.length > 0) return null
    return {
      ...checked.value,
      revision: Number.isInteger(raw.revision) ? raw.revision : 1,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      ...(typeof raw.commit === 'string' ? { commit: raw.commit } : {}),
      ...(raw.isDirty === true ? { isDirty: true } : {}),
    }
  } catch {
    return null
  }
}

async function checkStale($: $, map: ArchMap) {
  if (map.commit === undefined) return null
  const head = (await git($, ['rev-parse', 'HEAD']))?.trim()
  if (!head || head === map.commit) return null
  const changed = (await git($, ['diff', '--name-only', map.commit]))?.split('\n').filter(Boolean)
  if (!changed || changed.length === 0) return null
  const modules = [...new Set(changed.flatMap(f => ownersOf(map, f)))]
  return { commit: map.commit, head, changedFiles: changed.length, modules }
}

const setPlan = (status: PlanStatus, at: string, reason?: string) => (p: Plan | null) =>
  p === null ? p : { ...p, status, decidedAt: at, ...(reason ? { rejectReason: reason } : {}) }

/** The person approves the waiting plan; the model is told to go on. */
async function approve($: $): Promise<string> {
  const plan = await read($, planAtom)
  if (plan === null || (plan.status !== 'pending' && plan.status !== 'rejected')) {
    return lang === 'zh' ? '没有等待确认的计划。' : 'No plan is waiting for approval.'
  }
  await update($, planAtom, setPlan('approved', await now($)))
  await log($, { kind: 'approve', evidence: 'observed', plan: plan.id, text: `plan #${plan.id} approved by the user` })
  await refresh($)
  $.ui.toast(t.toastApproved(plan.id))
  void $.prompt
    .submit({ text: `archgate: the user approved plan #${plan.id}. Go ahead within its scope (${plan.modules.join(', ')}).` })
    .catch(() => undefined)
  return t.toastApproved(plan.id)
}

async function reject($: $, reason: string): Promise<string> {
  const plan = await read($, planAtom)
  if (plan === null || plan.status !== 'pending') {
    return lang === 'zh' ? '没有等待确认的计划。' : 'No plan is waiting for approval.'
  }
  await update($, planAtom, setPlan('rejected', await now($), reason))
  await log($, { kind: 'reject', evidence: 'observed', plan: plan.id, text: `plan #${plan.id} rejected${reason ? `: ${reason}` : ''}` })
  await refresh($)
  return `archgate: the user rejected plan #${plan.id}${reason ? `: ${reason}` : ''}. Revise it with archgate_plan.`
}

async function touch($: $, file: TouchedFile) {
  await update($, planAtom, p =>
    p === null ? p : { ...p, touched: [...p.touched.filter(f => f.path !== file.path), file] },
  )
}

async function guard($: $, path: string, run: () => Promise<ToolCallResult>): Promise<ToolCallResult> {
  const rel = relativeTo(await cwd($), path)
  const [map, plan, isPaused] = await Promise.all([read($, mapAtom), read($, planAtom), read($, pausedAtom)])
  const decision = decideEdit({ map, plan, mode, enforcement, isPaused, path: rel })
  const isTracked = rel !== null && isActive(plan) && !rel.startsWith(`${STATE_DIR}/`)

  if (decision.verdict === 'deny') {
    if (isTracked && plan.status === 'approved') {
      await touch($, { path: rel, modules: decision.owners, isInScope: false, isBlocked: true })
      await log($, { kind: 'blocked', evidence: 'observed', plan: plan.id, text: `blocked ${rel}` })
      await refresh($)
      $.ui.toast(t.toastBlocked(rel))
    }
    return { deny: `archgate: ${decision.reason}` }
  }

  const ran = await run()
  if (ran.deny !== undefined || ran.isError === true) return ran
  const isInScope = decision.verdict === 'allow'
  if (isTracked) {
    await touch($, { path: rel, modules: decision.owners, isInScope, isBlocked: false })
    await log($, {
      kind: 'edit',
      evidence: 'observed',
      plan: plan.id,
      text: `edited ${rel}${decision.owners.length ? ` (${decision.owners.join(', ')})` : ''}${isInScope ? '' : ' OUT OF SCOPE'}`,
    })
    await refresh($)
  }
  if (isInScope) return ran
  $.ui.toast(t.toastWarned(rel ?? path))
  return { ...ran, context: [...(ran.context ?? []), `archgate: ${decision.reason}`] }
}

/** The pane's content as plain text, for clients that draw no pane. */
async function describe($: $): Promise<string> {
  const [map, plan, stale, isPaused] = await Promise.all([
    read($, mapAtom),
    read($, planAtom),
    read($, staleAtom),
    read($, pausedAtom),
  ])
  if (map === null) return `${t.title}\n${t.noMap}`
  const lines = [t.title, t.map(map.project, map.revision, map.modules.length)]
  if (isPaused) lines.push(t.paused)
  if (stale !== null) lines.push(t.stale(stale.changedFiles, stale.modules.join(', ') || '—'))
  if (plan === null) return [...lines, '', t.noPlan].join('\n')

  const phase = plan.status === 'approved' && plan.touched.length > 0 ? t.editing : t.status[plan.status]
  lines.push('', `${t.plan(plan.id)} · ${phase}`, plan.summary, `${t.scope}: ${plan.modules.join(', ')}`)
  if (plan.files.length > 0) lines.push(plan.files.join('  '))
  if (plan.impact.length > 0) lines.push(`${t.impact}: ${plan.impact.join(', ')}`)
  for (const f of plan.touched) {
    const tag = f.isBlocked ? ` ${t.blocked}` : f.isInScope ? '' : ` ${t.outOfScope}`
    lines.push(`${f.isInScope ? '●' : '✗'} ${f.path}${tag}`)
  }
  if (plan.checks.length > 0) {
    lines.push(`${t.checks}:`)
    for (const c of plan.checks) {
      const runs = plan.checkRuns.filter(r => r.command.includes(c))
      const last = runs[runs.length - 1]
      lines.push(`  ${last === undefined ? '○' : last.isOk ? '✓' : '✗'} ${c}`)
    }
  }
  const missing = unverified(plan)
  if (plan.status === 'completed' && missing.length > 0) lines.push(t.unverified(missing.join(', ')))
  if (plan.status === 'pending' || plan.status === 'rejected') lines.push('', t.howToApprove)
  return lines.join('\n')
}

/** Opens the pane and remembers whether any client drew it. */
async function openPane($: $): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'archgate' }).catch(() => ({ isPlaced: false as const }))
  return opened.isPlaced
}

/** Commands typed by the person: at the terminal, through Remote Control, or by the app hosting the session. */
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

export const register: Register = (on, options) => {
  mode = options.mode === 'auto' ? 'auto' : 'on-demand'
  enforcement = options.enforcement === 'warn' || options.enforcement === 'off' ? options.enforcement : 'block'
  lang = options.language === 'en' ? 'en' : 'zh'
  t = strings(lang)
  root = ''

  on('session.start', async ($, e, next) => {
    root = e.cwd
    await $.tool.register(MAP_TOOL)
    await $.tool.register(PLAN_TOOL)
    await $.tool.register(COMPLETE_TOOL)
    await $.command.register({
      name: 'archgate',
      description: lang === 'zh' ? '架构闸门：打开面板 / 确认或驳回计划 / 生成报告' : 'Architecture gate: pane, approve or reject the plan, report',
      argumentHint: '[approve | reject <reason> | status | report | on | off]',
    })

    const map = (await read($, mapAtom)) ?? (await loadMap($))
    await update($, mapAtom, () => map)
    if (map !== null) {
      const stale = await checkStale($, map)
      await update($, staleAtom, () => stale)
      if (stale !== null) $.ui.toast(t.stale(stale.changedFiles, stale.modules.join(', ') || '—'))
    }
    await refresh($)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const [map, plan, stale, isPaused] = await Promise.all([
      read($, mapAtom),
      read($, planAtom),
      read($, staleAtom),
      read($, pausedAtom),
    ])
    const text = contextSection({ map, plan, stale, mode, enforcement, isPaused })
    return { sections: [...composed.sections, { id: 'archgate:context', text, scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'mcp__archgate__archgate_map' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const checked = checkMap(input)
    if (checked.errors.length > 0) {
      return { deny: `archgate: the map was not saved.\n- ${checked.errors.slice(0, 25).join('\n- ')}` }
    }
    const warnings = [...checked.warnings]
    const previous = await read($, mapAtom)
    const commit = (await git($, ['rev-parse', 'HEAD']))?.trim()
    const porcelain = await git($, ['status', '--porcelain'])
    const map: ArchMap = {
      ...checked.value,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: await now($),
      ...(commit ? { commit } : {}),
      ...(porcelain ? { isDirty: true } : {}),
    }

    const base = await cwd($)
    let reads = 0
    for (const m of map.modules) {
      for (const ev of m.evidence ?? []) {
        if (reads++ >= MAX_EVIDENCE_READS) break
        const text = await $.fs.read(`${base}/${ev.path}`).catch(() => null)
        if (text === null) warnings.push(`Evidence ${ev.path} (${m.id}) does not exist or cannot be read.`)
        else if (ev.lines && ev.lines[1] > text.split('\n').length) {
          warnings.push(`Evidence ${ev.path}:${ev.lines[0]}-${ev.lines[1]} (${m.id}) runs past the end of the file.`)
        }
      }
    }

    const tracked = (await git($, ['ls-files']))?.split('\n').filter(Boolean)
    const cover = tracked ? coverage(map, tracked) : null
    const delta = previous === null ? null : diffMaps(previous, map)

    try {
      await $.fs.write(`${base}/${MAP_FILE}`, JSON.stringify(map, null, 2) + '\n')
    } catch (error) {
      return { deny: `archgate: could not write ${MAP_FILE}: ${String(error)}` }
    }
    await update($, mapAtom, () => map)
    await update($, deltaAtom, () => delta)
    await update($, staleAtom, () => null)

    const plan = await read($, planAtom)
    if (isActive(plan)) {
      const gone = plan.modules.filter(id => !map.modules.some(m => m.id === id))
      if (gone.length > 0) warnings.push(`Plan #${plan.id} names modules no longer in the map: ${gone.join(', ')}. Submit a new plan.`)
    }

    const lines = [
      `Map saved to ${MAP_FILE}: revision ${map.revision}, ${map.modules.length} modules, ${map.relations.length} relations${commit ? `, at ${commit.slice(0, 10)}${porcelain ? ' (dirty worktree)' : ''}` : ''}.`,
    ]
    if (cover) {
      const pct = cover.total === 0 ? 100 : Math.round((cover.owned / cover.total) * 100)
      lines.push(`Coverage: ${cover.owned}/${cover.total} tracked files (${pct}%) belong to a module.`)
      if (cover.unownedDirs.length > 0) lines.push(`Unowned: ${cover.unownedDirs.join(', ')}.`)
    }
    if (delta && !isEmptyDelta(delta)) {
      const parts = [
        delta.addedModules.length ? `+modules ${delta.addedModules.join(', ')}` : '',
        delta.removedModules.length ? `-modules ${delta.removedModules.join(', ')}` : '',
        delta.changedModules.length ? `~modules ${delta.changedModules.join(', ')}` : '',
        delta.addedRelations.length ? `+relations ${delta.addedRelations.join(', ')}` : '',
        delta.removedRelations.length ? `-relations ${delta.removedRelations.join(', ')}` : '',
      ].filter(Boolean)
      lines.push(`Changes since r${delta.from}: ${parts.join('; ')}.`)
    }
    if (warnings.length > 0) lines.push('Warnings:', ...warnings.slice(0, 30).map(w => `- ${w}`))
    lines.push(`Report: ${REPORT_FILE}. Show the user the map and its uncertain parts before planning.`)

    await log($, { kind: 'map', evidence: 'declared', text: `map r${map.revision}: ${map.modules.length} modules` })
    await refresh($)
    return { result: lines.join('\n') }
  }).catch(() => ({ deny: 'archgate: archgate_map failed inside the mod; nothing was recorded.' }))

  on('tool.call', { tool: 'mcp__archgate__archgate_plan' }, async ($, e) => {
    const map = await read($, mapAtom)
    if (map === null) return { deny: 'archgate: there is no map yet. Read the code and call archgate_map first.' }
    const { draft, errors, warnings } = checkPlan(map, e as unknown as Record<string, unknown>)
    if (errors.length > 0) return { deny: `archgate: the plan was not accepted.\n- ${errors.join('\n- ')}` }

    const previous = await read($, planAtom)
    const isRefinement = previous !== null && previous.status === 'approved' && isWithin(map, draft, previous)
    const at = await now($)
    await update($, seqAtom, n => (n ?? 0) + 1)
    const id = await read($, seqAtom)
    const plan: Plan = {
      id,
      ...draft,
      status: isRefinement ? 'approved' : 'pending',
      createdAt: at,
      ...(isRefinement ? { decidedAt: at } : {}),
      touched: isRefinement ? previous.touched : [],
      checkRuns: isRefinement ? previous.checkRuns : [],
    }
    await update($, planAtom, () => plan)
    await log($, {
      kind: 'plan',
      evidence: 'declared',
      plan: id,
      text: `plan #${id} (${plan.modules.join(', ')}): ${plan.summary}${isRefinement ? ' [within approved scope]' : ''}`,
    })
    await refresh($)

    const lines: string[] = []
    if (isRefinement) {
      lines.push(`Plan #${id} stays within approved plan #${previous.id}, so it is approved. Go ahead.`)
    } else {
      const isShown = await openPane($)
      $.ui.toast(t.toastPlan(id))
      lines.push(
        `Plan #${id} is waiting for the user's approval (archgate pane, or /archgate approve).`,
        'End your turn now: summarise the plan for the user and ask them to approve it. Edits are refused until they do.',
      )
      if (!isShown) {
        lines.push('The archgate pane is not shown in this client: tell the user to type /archgate approve (or /archgate reject <reason>), and /archgate to see the plan.')
      }
    }
    if (plan.impact.length > 0) {
      lines.push(`Callers that may be affected and are not in scope: ${plan.impact.join(', ')}. Mention them, and check them during verification.`)
    }
    if (warnings.length > 0) lines.push('Warnings:', ...warnings.map(w => `- ${w}`))
    return { result: lines.join('\n') }
  }).catch(() => ({ deny: 'archgate: archgate_plan failed inside the mod; nothing was recorded.' }))

  on('tool.call', { tool: 'mcp__archgate__archgate_complete' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const outcome = input.outcome as PlanStatus
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') {
      return { deny: 'archgate: outcome must be completed, failed or cancelled.' }
    }
    const plan = await read($, planAtom)
    if (!isActive(plan)) return { deny: 'archgate: there is no open plan to close.' }
    if (outcome === 'completed' && plan.status !== 'approved') {
      return { deny: `archgate: plan #${plan.id} was never approved, so it cannot be completed. Use cancelled.` }
    }
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    const at = await now($)
    await update($, planAtom, p => (p === null ? p : { ...p, status: outcome, decidedAt: at, ...(note ? { note } : {}) }))
    const missing = unverified(plan)
    const out = plan.touched.filter(f => !f.isInScope && !f.isBlocked).map(f => f.path)
    await log($, {
      kind: outcome,
      evidence: 'declared',
      plan: plan.id,
      text: `plan #${plan.id} ${outcome}${note ? `: ${note}` : ''}${missing.length > 0 ? ` (unverified: ${missing.join(', ')})` : ''}`,
    })
    await refresh($)

    const lines = [`Plan #${plan.id} closed as ${outcome}. Report: ${REPORT_FILE}.`]
    if (outcome === 'completed' && missing.length > 0) {
      lines.push(`Unverified: ${missing.join(', ')} never ran or last failed. Tell the user the change is not verified.`)
    }
    if (out.length > 0) lines.push(`Edited outside the approved scope: ${out.join(', ')}. Tell the user.`)
    return { result: lines.join('\n') }
  }).catch(() => ({ deny: 'archgate: archgate_complete failed inside the mod; nothing was recorded.' }))

  const refuse = 'archgate: the scope check failed, so the edit was refused. Run /archgate off to pause the gate.'
  on('tool.call', { tool: 'Edit' }, ($, e, next) => guard($, e.file_path, () => next(e))).catch(($, e, next) =>
    next.called ? next(e) : { deny: refuse },
  )
  on('tool.call', { tool: 'Write' }, ($, e, next) => guard($, e.file_path, () => next(e))).catch(($, e, next) =>
    next.called ? next(e) : { deny: refuse },
  )
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => guard($, e.notebook_path, () => next(e))).catch(
    ($, e, next) => (next.called ? next(e) : { deny: refuse }),
  )

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const plan = await read($, planAtom)
    if (plan === null || plan.status !== 'approved' || ran.deny !== undefined || !isCheck(e.command, plan.checks)) {
      return ran
    }
    const isOk = ran.isError !== true && ran.result?.interrupted !== true
    const command = e.command.trim().slice(0, 300)
    const at = await now($)
    await update($, planAtom, p => (p === null ? p : { ...p, checkRuns: [...p.checkRuns, { command, isOk, at }].slice(-50) }))
    await log($, { kind: 'check', evidence: 'observed', plan: plan.id, text: `${isOk ? 'passed' : 'failed'}: ${command}` })
    await refresh($)
    return ran
  })

  on('command.run', { command: 'archgate' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const kind = e.origin?.kind ?? 'unknown'
    const isPerson = PERSON_ORIGINS.has(kind)

    if (verb === 'approve' || verb === 'reject' || verb === 'on' || verb === 'off') {
      if (!isPerson) return { text: t.notPerson(kind) }
    }
    switch (verb) {
      case 'approve':
        return { text: await approve($) }
      case 'reject':
        return { text: await reject($, rest.join(' ')) }
      case 'off':
      case 'on': {
        await update($, pausedAtom, () => verb === 'off')
        await log($, { kind: verb === 'off' ? 'pause' : 'resume', evidence: 'observed', text: `gate ${verb === 'off' ? 'paused' : 'resumed'} by the user` })
        await refresh($)
        return { text: verb === 'off' ? `archgate: ${t.paused}` : 'archgate: gate on.' }
      }
      case 'report': {
        await refresh($)
        const map = await read($, mapAtom)
        return { text: map === null ? t.noMap : t.reportWritten(`${await cwd($)}/${REPORT_FILE}`) }
      }
      default: {
        const isShown = await openPane($)
        const text = await describe($)
        return { text: isShown ? text : `${text}\n\n${t.paneHidden}` }
      }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [map, plan, stale, delta, isPaused] = await Promise.all([
      read($, mapAtom),
      read($, planAtom),
      read($, staleAtom),
      read($, deltaAtom),
      read($, pausedAtom),
    ])
    if (map === null) {
      return (
        <Box flexDirection="column">
          <Text bold>{t.title}</Text>
          <Text dimColor>{t.noMap}</Text>
        </Box>
      )
    }

    const states = moduleStates(map, plan)
    const mark = { out: '✗', touched: '●', planned: '◆', impact: '△', other: '·' } as const
    const color = { out: 'error', touched: 'success', planned: 'suggestion', impact: 'warning', other: 'inactive' } as const
    const isWaiting = plan !== null && (plan.status === 'pending' || plan.status === 'rejected')
    const shown = [...map.modules].sort((a, b) => order(states.get(a.id)) - order(states.get(b.id)))
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 14)
    const missing = plan !== null ? unverified(plan) : []

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{t.title}</Text>
          <Text dimColor>{t.map(map.project, map.revision, map.modules.length)}</Text>
          {isPaused && <Text color="warning">{t.paused}</Text>}
          {stale !== null && <Text color="warning">{t.stale(stale.changedFiles, stale.modules.join(', ') || '—')}</Text>}
          {delta !== null && <Text dimColor>{t.delta(delta.from, delta.to, deltaText(delta))}</Text>}
        </Box>

        {plan === null ? (
          <Text dimColor>{t.noPlan}</Text>
        ) : (
          <Box flexDirection="column">
            <Text bold>
              {t.plan(plan.id)} ·{' '}
              <Text color={plan.status === 'rejected' || plan.status === 'failed' ? 'error' : isWaiting ? 'warning' : 'success'}>
                {plan.status === 'approved' && plan.touched.length > 0 ? t.editing : t.status[plan.status]}
              </Text>
            </Text>
            <Text wrap="wrap">{plan.summary}</Text>
            {plan.files.length > 0 && <Text dimColor wrap="wrap">{plan.files.join('  ')}</Text>}
            {plan.status === 'completed' && missing.length > 0 && <Text color="error">{t.unverified(missing.join(', '))}</Text>}
          </Box>
        )}

        <Box flexDirection="column">
          {shown.slice(0, room).map(m => {
            const state = states.get(m.id) ?? 'other'
            const files = plan?.touched.filter(f => f.modules.includes(m.id)).length ?? 0
            return (
              <Text key={m.id} color={color[state]} dimColor={state === 'other'} wrap="truncate-end">
                {mark[state]} {m.name} <Text dimColor>{m.id}{files > 0 ? ` · ${files}` : ''}</Text>
              </Text>
            )
          })}
          {shown.length > room && <Text dimColor>… {shown.length - room}</Text>}
        </Box>

        {plan !== null && plan.touched.some(f => !f.isInScope) && (
          <Box flexDirection="column">
            {plan.touched
              .filter(f => !f.isInScope)
              .slice(-5)
              .map(f => (
                <Text key={f.path} color="error" wrap="truncate-start">
                  ✗ {f.path} {f.isBlocked ? t.blocked : t.outOfScope}
                </Text>
              ))}
          </Box>
        )}

        {plan !== null && plan.checks.length > 0 && (
          <Box flexDirection="column">
            <Text bold>{t.checks}</Text>
            {plan.checks.map(c => {
              const runs = plan.checkRuns.filter(r => r.command.includes(c))
              const last = runs[runs.length - 1]
              return (
                <Text key={c} color={last === undefined ? 'inactive' : last.isOk ? 'success' : 'error'} wrap="truncate-end">
                  {last === undefined ? '○' : last.isOk ? '✓' : '✗'} {c}
                </Text>
              )
            })}
          </Box>
        )}

        <Box gap={1}>
          {plan !== null && isWaiting && (
            <Button key="approve" label={t.approve} hotkey="y" variant="primary" onPress={() => approve($)} />
          )}
          {plan !== null && plan.status === 'pending' && (
            <Button key="reject" label={t.reject} hotkey="n" onPress={() => reject($, '')} />
          )}
          <Button
            key="report"
            label={t.report}
            hotkey="r"
            onPress={async () => {
              await refresh($)
              $.ui.toast(t.reportWritten(REPORT_FILE))
            }}
          />
        </Box>
      </Box>
    )
  })
}

function order(state: string | undefined): number {
  return ['out', 'touched', 'planned', 'impact', 'other'].indexOf(state ?? 'other')
}

function deltaText(d: MapDelta): string {
  const parts = [
    d.addedModules.length ? `+${d.addedModules.length}` : '',
    d.removedModules.length ? `-${d.removedModules.length}` : '',
    d.changedModules.length ? `~${d.changedModules.length}` : '',
    d.addedRelations.length + d.removedRelations.length ? `↔${d.addedRelations.length + d.removedRelations.length}` : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : '='
}
