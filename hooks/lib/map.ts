import type { ArchMap, ArchModule, Evidence, MapDelta, Relation } from '../../types'

import { isSafeRelative, matchPath, normalize } from './paths'

const ID = /^[a-z][a-z0-9-]{0,63}$/

export type MapInput = {
  project?: unknown
  modules?: unknown
  relations?: unknown
}

export type Checked<T> = { value: T; errors: string[]; warnings: string[] }

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/** Checks a submitted map; `errors` empty means it can be written. */
export function checkMap(input: MapInput): Checked<Omit<ArchMap, 'revision' | 'updatedAt'>> {
  const errors: string[] = []
  const warnings: string[] = []
  const modules: ArchModule[] = []
  const relations: Relation[] = []
  const project = isText(input.project) ? input.project.trim() : 'project'

  const rawModules = Array.isArray(input.modules) ? input.modules : []
  if (rawModules.length === 0) errors.push('modules: give at least one module.')

  const ids = new Set<string>()
  rawModules.forEach((raw, index) => {
    const at = `modules[${index}]`
    const m = (raw ?? {}) as Record<string, unknown>
    const id = typeof m.id === 'string' ? m.id : ''
    if (!ID.test(id)) {
      errors.push(`${at}.id "${id}": use lowercase letters, digits and "-", starting with a letter.`)
    } else if (ids.has(id)) {
      errors.push(`${at}.id "${id}" is used twice.`)
    }
    ids.add(id)
    if (!isText(m.name)) errors.push(`${at}.name is required.`)
    if (!isText(m.responsibility)) errors.push(`${at}.responsibility is required.`)

    const paths = Array.isArray(m.paths) ? m.paths.filter(isText).map(p => normalize(p)) : []
    if (paths.length === 0) errors.push(`${at}.paths: list the files, folders or globs "${id}" owns.`)
    for (const path of paths) {
      if (!isSafeRelative(path)) errors.push(`${at}.paths "${path}" must be project-relative.`)
    }

    const evidence: Evidence[] = []
    if (Array.isArray(m.evidence)) {
      for (const rawEvidence of m.evidence) {
        const e = (rawEvidence ?? {}) as Record<string, unknown>
        if (!isText(e.path) || !isSafeRelative(normalize(e.path))) {
          errors.push(`${at}.evidence: each entry needs a project-relative "path".`)
          continue
        }
        const item: Evidence = { path: normalize(e.path) }
        const lines = e.lines
        if (Array.isArray(lines) && lines.length === 2 && lines.every(n => Number.isInteger(n) && n >= 1)) {
          const [start, end] = lines as [number, number]
          if (end < start) errors.push(`${at}.evidence "${item.path}": lines end before they start.`)
          item.lines = [start, end]
        }
        if (isText(e.note)) item.note = e.note
        evidence.push(item)
      }
    }
    if (evidence.length === 0) warnings.push(`Module "${id}" cites no evidence.`)

    modules.push({
      id,
      name: isText(m.name) ? m.name.trim() : id,
      responsibility: isText(m.responsibility) ? m.responsibility.trim() : '',
      paths,
      ...(evidence.length > 0 ? { evidence } : {}),
    })
  })

  const seen = new Set<string>()
  const rawRelations = Array.isArray(input.relations) ? input.relations : []
  rawRelations.forEach((raw, index) => {
    const at = `relations[${index}]`
    const r = (raw ?? {}) as Record<string, unknown>
    const from = typeof r.from === 'string' ? r.from : ''
    const to = typeof r.to === 'string' ? r.to : ''
    if (!ids.has(from)) errors.push(`${at}.from "${from}" is not a module id.`)
    if (!ids.has(to)) errors.push(`${at}.to "${to}" is not a module id.`)
    if (from === to) errors.push(`${at}: a module cannot depend on itself.`)
    const key = `${from}->${to}`
    if (seen.has(key)) warnings.push(`Relation ${key} is listed twice; kept once.`)
    else {
      seen.add(key)
      relations.push({ from, to, ...(isText(r.label) ? { label: r.label.trim() } : {}) })
    }
  })

  for (const a of modules) {
    for (const b of modules) {
      if (a.id >= b.id) continue
      const shared = a.paths.filter(p => b.paths.includes(p))
      if (shared.length > 0) warnings.push(`"${a.id}" and "${b.id}" both own ${shared.join(', ')}.`)
    }
  }

  return { value: { version: 1, project, modules, relations }, errors, warnings }
}

/** The modules owning `path`: every module one of whose paths covers it. */
export function ownersOf(map: ArchMap, path: string): string[] {
  return map.modules.filter(m => m.paths.some(p => matchPath(p, path))).map(m => m.id)
}

/**
 * Modules reached from `start` along the relations, up to `depth` hops,
 * `start` excluded. `upstream` walks to the callers (who depends on them):
 * the ones a change may break.
 */
export function reach(
  map: ArchMap,
  start: readonly string[],
  direction: 'upstream' | 'downstream',
  depth = 2,
): string[] {
  const found = new Set<string>()
  let frontier = new Set(start)
  for (let hop = 0; hop < depth && frontier.size > 0; hop++) {
    const next = new Set<string>()
    for (const r of map.relations) {
      const [here, there] = direction === 'upstream' ? [r.to, r.from] : [r.from, r.to]
      if (frontier.has(here) && !start.includes(there) && !found.has(there)) {
        found.add(there)
        next.add(there)
      }
    }
    frontier = next
  }
  return [...found]
}

/** What changed between two revisions of the map. */
export function diffMaps(before: ArchMap, after: ArchMap): MapDelta {
  const byId = new Map(before.modules.map(m => [m.id, m]))
  const afterIds = new Set(after.modules.map(m => m.id))
  const edges = (map: ArchMap) => new Set(map.relations.map(r => `${r.from}->${r.to}`))
  const beforeEdges = edges(before)
  const afterEdges = edges(after)
  return {
    from: before.revision,
    to: after.revision,
    addedModules: after.modules.filter(m => !byId.has(m.id)).map(m => m.id),
    removedModules: before.modules.filter(m => !afterIds.has(m.id)).map(m => m.id),
    changedModules: after.modules
      .filter(m => {
        const old = byId.get(m.id)
        return old !== undefined && (old.paths.join('\n') !== m.paths.join('\n') || old.responsibility !== m.responsibility)
      })
      .map(m => m.id),
    addedRelations: [...afterEdges].filter(e => !beforeEdges.has(e)),
    removedRelations: [...beforeEdges].filter(e => !afterEdges.has(e)),
  }
}

export function isEmptyDelta(delta: MapDelta): boolean {
  return (
    delta.addedModules.length +
      delta.removedModules.length +
      delta.changedModules.length +
      delta.addedRelations.length +
      delta.removedRelations.length ===
    0
  )
}

export type Coverage = { total: number; owned: number; unownedDirs: string[] }

/** How many tracked files some module owns, and where the rest sit. */
export function coverage(map: ArchMap, files: readonly string[]): Coverage {
  let owned = 0
  const dirs = new Map<string, number>()
  for (const file of files) {
    if (ownersOf(map, file).length > 0) {
      owned++
      continue
    }
    const parts = file.split('/')
    const dir = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : file
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
  }
  const unownedDirs = [...dirs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([dir, count]) => `${dir} (${count})`)
  return { total: files.length, owned, unownedDirs }
}
