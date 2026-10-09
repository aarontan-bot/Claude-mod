import type { ArchMap, Plan, Staleness } from '../../types'

import { isActive, type Enforcement, type Mode } from './gate'

const MAX_MODULES = 40

/** The system prompt section that tells the model how archgate stands now. */
export function contextSection(c: {
  map: ArchMap | null
  plan: Plan | null
  stale: Staleness | null
  mode: Mode
  enforcement: Enforcement
  isPaused: boolean
}): string {
  const lines = ['# archgate']
  const gate =
    c.enforcement === 'off' || c.isPaused
      ? 'The gate is not enforcing right now; still follow the workflow when it applies.'
      : c.enforcement === 'block'
        ? 'Edits (Edit, Write, NotebookEdit) outside an approved plan are refused.'
        : 'Edits outside an approved plan are allowed but flagged to the user.'

  if (c.map === null && c.mode === 'on-demand' && !isActive(c.plan)) {
    lines.push(
      'The archgate mod can map this project into modules and gate edits behind a plan the user approves.',
      'Use it when the user asks for archgate, an architecture map, or to review the scope before changes:',
      'call archgate_map, then archgate_plan, then wait for approval.',
    )
    return lines.join('\n')
  }

  lines.push(
    `Mode: ${c.mode}. ${gate}`,
    'Workflow:',
    '1. Map: read the code, then call archgate_map with modules (id, everyday name, responsibility, plain sentence, area, owned paths, evidence with line ranges) and relations (from depends on/calls to). Re-map when responsibilities or ownership change.',
    `2. Plan: ${c.mode === 'auto' ? 'before any code edit' : 'when archgate is in use for the task'}, call archgate_plan with the modules, files and verification commands. Then stop and wait: the user approves in the archgate pane or with /archgate approve. Never approve for them or treat silence as approval.`,
    '3. Edit only inside the approved scope. If more is needed, call archgate_plan again; a plan within the approved scope is approved at once.',
    '4. Run the planned checks with Bash (archgate records their real outcome), then call archgate_complete.',
    'Files under .archgate/ are archgate\'s own; do not edit them.',
    'Files changed by shell commands are detected and held to the plan like any other edit. Only the user can undo a plan (/archgate undo); never run it or restore files from refs/archgate/ yourself.',
    'The user may not read code. Write to them in short, plain sentences: one fact or one action per sentence, no jargon. Show them .archgate/report.html as a rendered page when the plan or its state changes.',
  )

  if (c.map === null) {
    lines.push('', 'No map exists yet.')
  } else {
    const shown = c.map.modules.slice(0, MAX_MODULES)
    lines.push('', `Map ${c.map.project} r${c.map.revision} (.archgate/map.json), modules:`)
    for (const m of shown) lines.push(`- ${m.id}: ${m.name} [${m.paths.join(', ')}]`)
    if (c.map.modules.length > shown.length) lines.push(`- … ${c.map.modules.length - shown.length} more in .archgate/map.json`)
    if (c.map.relations.length > 0) {
      lines.push(`Relations: ${c.map.relations.slice(0, 80).map(r => `${r.from}->${r.to}`).join(', ')}`)
    }
  }
  if (c.stale !== null) {
    lines.push(`The map is stale: ${c.stale.changedFiles} files changed since it was drawn (${c.stale.modules.join(', ') || 'unowned files'}). Re-map before planning.`)
  }

  if (c.plan !== null) {
    const p = c.plan
    lines.push('', `Plan #${p.id}: ${p.status}. Scope: ${p.modules.join(', ')}.${p.files.length > 0 ? ` Files: ${p.files.join(', ')}.` : ''}`)
    if (p.status === 'rejected' && p.rejectReason) lines.push(`Rejected because: ${p.rejectReason}`)
    if (p.impact.length > 0) lines.push(`Callers that may be affected: ${p.impact.join(', ')}.`)
  }
  return lines.join('\n')
}
