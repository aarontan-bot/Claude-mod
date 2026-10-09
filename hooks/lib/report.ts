import type { ArchMap, Plan, Staleness } from '../../types'

import { isActive, unverified } from './gate'
import { strings, type Lang } from './i18n'

export type ActivityEntry = {
  at: string
  kind: string
  evidence: 'declared' | 'observed'
  plan?: number
  text: string
}

export type ModuleState = 'out' | 'touched' | 'planned' | 'impact' | 'other'

/** How each module stands against the plan, worst first. */
export function moduleStates(map: ArchMap, plan: Plan | null): Map<string, ModuleState> {
  const states = new Map<string, ModuleState>()
  for (const m of map.modules) states.set(m.id, 'other')
  if (plan === null) return states
  for (const id of plan.impact) states.set(id, 'impact')
  for (const id of plan.modules) states.set(id, 'planned')
  for (const t of plan.touched) {
    for (const id of t.modules) {
      if (!states.has(id)) continue
      if (!t.isInScope) states.set(id, 'out')
      else if (states.get(id) !== 'out') states.set(id, 'touched')
    }
  }
  return states
}

const esc = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** Columns by dependency depth: callers left, what they call to the right. */
export function layers(map: ArchMap): Map<string, number> {
  const layer = new Map(map.modules.map(m => [m.id, 0]))
  const cap = Math.max(0, map.modules.length - 1)
  for (let pass = 0; pass < map.modules.length; pass++) {
    let isMoved = false
    for (const r of map.relations) {
      const want = Math.min(cap, (layer.get(r.from) ?? 0) + 1)
      if (want > (layer.get(r.to) ?? 0)) {
        layer.set(r.to, want)
        isMoved = true
      }
    }
    if (!isMoved) break
  }
  return layer
}

const NODE_W = 200
const NODE_H = 64
const GAP_X = 96
const GAP_Y = 28
const PAD = 24

function svg(map: ArchMap, states: Map<string, ModuleState>): string {
  const layer = layers(map)
  const columns = new Map<number, string[]>()
  for (const m of map.modules) {
    const col = layer.get(m.id) ?? 0
    columns.set(col, [...(columns.get(col) ?? []), m.id])
  }
  const pos = new Map<string, { x: number; y: number }>()
  let rows = 0
  for (const [col, ids] of columns) {
    ids.forEach((id, row) => pos.set(id, { x: PAD + col * (NODE_W + GAP_X), y: PAD + row * (NODE_H + GAP_Y) }))
    rows = Math.max(rows, ids.length)
  }
  const width = PAD * 2 + Math.max(1, columns.size) * NODE_W + Math.max(0, columns.size - 1) * GAP_X
  const height = PAD * 2 + rows * NODE_H + Math.max(0, rows - 1) * GAP_Y

  const edges = map.relations
    .map(r => {
      const a = pos.get(r.from)
      const b = pos.get(r.to)
      if (!a || !b) return ''
      const isForward = b.x > a.x
      const [x1, y1] = isForward ? [a.x + NODE_W, a.y + NODE_H / 2] : [a.x + NODE_W / 2, a.y + NODE_H]
      const [x2, y2] = isForward ? [b.x, b.y + NODE_H / 2] : [b.x + NODE_W / 2, b.y + NODE_H]
      const d = isForward
        ? `M${x1},${y1} C${x1 + GAP_X / 2},${y1} ${x2 - GAP_X / 2},${y2} ${x2},${y2}`
        : `M${x1},${y1} C${x1},${y1 + 40} ${x2},${y2 + 40} ${x2},${y2}`
      const label = r.label
        ? `<text class="edge-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}">${esc(r.label)}</text>`
        : ''
      return `<path class="edge" d="${d}" marker-end="url(#arrow)"/>${label}`
    })
    .join('')

  const nodes = map.modules
    .map(m => {
      const p = pos.get(m.id)!
      const state = states.get(m.id) ?? 'other'
      const name = m.name.length > 24 ? `${m.name.slice(0, 23)}…` : m.name
      return (
        `<g class="node ${state}" transform="translate(${p.x},${p.y})"><title>${esc(m.responsibility)}</title>` +
        `<rect width="${NODE_W}" height="${NODE_H}" rx="10"/>` +
        `<text class="name" x="14" y="27">${esc(name)}</text>` +
        `<text class="id" x="14" y="47">${esc(m.id)}</text></g>`
      )
    })
    .join('')

  return (
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-label="architecture map">` +
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker></defs>' +
    `${edges}${nodes}</svg>`
  )
}

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#d9d9d4;--planned:#2563eb;--touched:#16a34a;--out:#dc2626;--impact:#d97706;--other:#9a9a94}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--fg:#ecece8;--muted:#a3a39d;--line:#3a3a37;--planned:#60a5fa;--touched:#4ade80;--out:#f87171;--impact:#fbbf24;--other:#77776f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.muted{color:var(--muted)}.warn{border-left:3px solid var(--impact);padding:8px 12px;background:var(--card);margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
.canvas{overflow-x:auto}.legend{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0}.legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;background:var(--c)}
svg text{fill:var(--fg)}.node rect{fill:var(--card);stroke:var(--other);stroke-width:1.5}.node .name{font-weight:600;font-size:14px}.node .id{fill:var(--muted);font-size:12px;font-family:ui-monospace,monospace}
.node.planned rect{stroke:var(--planned);stroke-width:2.5}.node.touched rect{stroke:var(--touched);stroke-width:2.5}.node.out rect{stroke:var(--out);stroke-width:3;stroke-dasharray:6 3}.node.impact rect{stroke:var(--impact);stroke-width:2;stroke-dasharray:3 3}
.edge{fill:none;stroke:var(--muted);stroke-width:1.3}.arrow{fill:var(--muted)}.edge-label{fill:var(--muted);font-size:11px;text-anchor:middle}
table{width:100%;border-collapse:collapse}td,th{text-align:left;vertical-align:top;padding:8px;border-top:1px solid var(--line)}code{font-family:ui-monospace,monospace;font-size:12px}
.ok{color:var(--touched)}.bad{color:var(--out)}.chip{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--line);margin:0 4px 4px 0;font-size:12px}
ul{margin:4px 0;padding-left:20px}
`

export function renderReport(input: {
  map: ArchMap
  plan: Plan | null
  stale: Staleness | null
  activity: readonly ActivityEntry[]
  lang: Lang
  now: string
}): string {
  const t = strings(input.lang)
  const { map, plan } = input
  const states = moduleStates(map, plan)
  const chips = (ids: readonly string[]) => ids.map(id => `<span class="chip">${esc(id)}</span>`).join('') || '—'

  const legend = (
    [
      ['planned', t.legendPlanned],
      ['touched', t.legendTouched],
      ['out', t.legendOut],
      ['impact', t.legendImpact],
      ['other', t.legendOther],
    ] as const
  )
    .map(([k, label]) => `<span style="--c:var(--${k})">${esc(label)}</span>`)
    .join('')

  let planHtml = `<p class="muted">${esc(t.noPlan)}</p>`
  if (plan !== null) {
    const status = isActive(plan) && plan.status === 'approved' && plan.touched.length > 0 ? t.editing : t.status[plan.status]
    const missing = unverified(plan)
    const touched = plan.touched
      .map(f => {
        const cls = f.isInScope ? 'ok' : 'bad'
        const tag = f.isBlocked ? t.blocked : f.isInScope ? '' : t.outOfScope
        return `<li><code>${esc(f.path)}</code> <span class="${cls}">${esc(f.modules.join(', ') || '—')} ${esc(tag)}</span></li>`
      })
      .join('')
    const checks = plan.checks
      .map(c => {
        const runs = plan.checkRuns.filter(r => r.command.includes(c))
        const last = runs[runs.length - 1]
        const mark = last === undefined ? `<span class="muted">${esc(t.notRun)}</span>` : last.isOk ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'
        return `<li>${mark} <code>${esc(c)}</code></li>`
      })
      .join('')
    planHtml =
      `<p><strong>${esc(t.plan(plan.id))}</strong> · ${esc(status)}</p><p>${esc(plan.summary)}</p>` +
      `<p>${esc(t.scope)}: ${chips(plan.modules)}</p>` +
      (plan.files.length > 0 ? `<ul>${plan.files.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul>` : '') +
      `<p>${esc(t.impact)}: ${chips(plan.impact)}</p>` +
      (touched ? `<h2>${esc(t.touched)}</h2><ul>${touched}</ul>` : '') +
      (checks ? `<h2>${esc(t.checks)}</h2><ul>${checks}</ul>` : '') +
      (plan.status === 'completed' && missing.length > 0 ? `<p class="bad">${esc(t.unverified(missing.join(', ')))}</p>` : '')
  }

  const rows = map.modules
    .map(m => {
      const evidence = (m.evidence ?? [])
        .map(e => `<li><code>${esc(e.path)}${e.lines ? `:${e.lines[0]}-${e.lines[1]}` : ''}</code>${e.note ? ` ${esc(e.note)}` : ''}</li>`)
        .join('')
      return (
        `<tr><td><strong>${esc(m.name)}</strong><br><code class="muted">${esc(m.id)}</code></td>` +
        `<td>${esc(m.responsibility)}</td><td>${m.paths.map(p => `<code>${esc(p)}</code>`).join('<br>')}</td>` +
        `<td>${evidence ? `<ul>${evidence}</ul>` : '—'}</td></tr>`
      )
    })
    .join('')

  const activity = input.activity
    .slice(-60)
    .reverse()
    .map(a => `<li><span class="muted">${esc(a.at.slice(0, 19).replace('T', ' '))} · ${esc(a.evidence === 'observed' ? t.observed : t.declared)}</span> ${esc(a.text)}</li>`)
    .join('')

  const stale = input.stale
    ? `<div class="warn">${esc(t.stale(input.stale.changedFiles, input.stale.modules.join(', ') || '—'))}</div>`
    : ''
  const commit = map.commit ? ` · <code>${esc(map.commit.slice(0, 10))}${map.isDirty ? '*' : ''}</code>` : ''

  return `<!doctype html>
<html lang="${input.lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(map.project)} · archgate</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(map.project)}</h1>
<p class="muted">${esc(t.map(map.project, map.revision, map.modules.length))}${commit} · ${esc(t.generated)} ${esc(input.now.slice(0, 19).replace('T', ' '))}</p>
${stale}
<div class="card"><div class="legend">${legend}</div><div class="canvas">${svg(map, states)}</div></div>
<div class="card">${planHtml}</div>
<h2>${esc(t.modules)}</h2>
<div class="card"><table><tr><th>${esc(t.modules)}</th><th>${esc(t.responsibility)}</th><th>${esc(t.owns)}</th><th>${esc(t.evidence)}</th></tr>${rows}</table></div>
${activity ? `<h2>${esc(t.activity)}</h2><div class="card"><ul>${activity}</ul></div>` : ''}
</main></body></html>
`
}
