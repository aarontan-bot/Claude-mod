import type { ArchMap, Plan, Staleness } from '../../types'

import { unverified } from './gate'
import { strings, type Lang } from './i18n'
import { assessRisk, type Risk, type RiskReason } from './risk'

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

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

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

export type Band = { label?: string; ids: string[] }

/**
 * The map's rows, top to bottom: one per group when modules name groups,
 * else one per dependency layer. Callers sit above what they call; groups
 * mostly without relations sink to the bottom.
 */
export function bands(map: ArchMap): Band[] {
  const layer = layers(map)
  const linked = new Set(map.relations.flatMap(r => [r.from, r.to]))
  const byLayer = (a: string, b: string) => (layer.get(a) ?? 0) - (layer.get(b) ?? 0)
  if (!map.modules.some(m => m.group)) {
    const rows: Band[] = []
    for (const m of map.modules) {
      const at = linked.has(m.id) ? (layer.get(m.id) ?? 0) : map.modules.length
      while (rows.length <= at) rows.push({ ids: [] })
      rows[at]!.ids.push(m.id)
    }
    return rows.filter(r => r.ids.length > 0)
  }
  const groups = new Map<string, string[]>()
  for (const m of map.modules) {
    const key = m.group?.trim() || '—'
    groups.set(key, [...(groups.get(key) ?? []), m.id])
  }
  const depth = (ids: string[]) => {
    const tied = ids.filter(id => linked.has(id))
    return tied.length === 0 || tied.length * 2 < ids.length ? Infinity : Math.min(...tied.map(id => layer.get(id) ?? 0))
  }
  return [...groups.entries()]
    .map(([label, ids], order) => ({ label, ids: [...ids].sort(byLayer), order, depth: depth(ids) }))
    .sort((a, b) => a.depth - b.depth || a.order - b.order)
    .map(({ label, ids }) => ({ label, ids }))
}

const NODE_W = 236
const NODE_H = 76
const GAP_X = 20
const GAP_Y = 64
const PAD = 20
const HEAD = 34

function diagram(map: ArchMap, states: Map<string, ModuleState>, numbers: Map<string, number>, lang: Lang): string {
  const t = strings(lang).r
  const rows = bands(map)
  const hasLabels = rows.some(r => r.label !== undefined)
  const head = hasLabels ? HEAD : 0
  const perRow = Math.max(1, ...rows.map(r => r.ids.length))
  const inner = perRow * NODE_W + (perRow - 1) * GAP_X
  const width = PAD * 2 + inner + 24
  const pos = new Map<string, { x: number; y: number; row: number }>()
  rows.forEach((r, i) => {
    const y = PAD + i * (head + NODE_H + GAP_Y) + head
    r.ids.forEach((id, j) => pos.set(id, { x: PAD + 12 + j * (NODE_W + GAP_X), y, row: i }))
  })
  const height = PAD * 2 + rows.length * (head + NODE_H) + (rows.length - 1) * GAP_Y + 16

  const zones = hasLabels
    ? rows
        .map((r, i) => {
          const y = PAD + i * (head + NODE_H + GAP_Y) - 8
          return `<g class="zone"><rect x="${PAD}" y="${y}" width="${inner + 24}" height="${head + NODE_H + 22}" rx="20"/><text x="${PAD + 16}" y="${y + 24}">${esc(r.label ?? '')}</text></g>`
        })
        .join('')
    : ''

  const sameRow = new Map<number, number>()
  const edges = map.relations
    .map(r => {
      const a = pos.get(r.from)
      const b = pos.get(r.to)
      if (!a || !b) return ''
      let d: string
      const ax = a.x + NODE_W / 2
      const bx = b.x + NODE_W / 2
      if (a.row === b.row) {
        const k = (sameRow.get(a.row) ?? 0) + 1
        sameRow.set(a.row, k)
        const y = a.y + NODE_H
        const dip = y + 14 + k * 8
        d = `M${ax},${y} C${ax},${dip} ${bx},${dip} ${bx},${y}`
      } else {
        const isDown = b.row > a.row
        const y1 = isDown ? a.y + NODE_H : a.y
        const y2 = isDown ? b.y : b.y + NODE_H
        const mid = (y1 + y2) / 2
        d = `M${ax},${y1} C${ax},${mid} ${bx},${mid} ${bx},${y2}`
      }
      const title = r.label ? `<title>${esc(r.label)}</title>` : ''
      return `<path class="edge" data-a="${esc(r.from)}" data-b="${esc(r.to)}" d="${d}" marker-end="url(#ag-arrow)">${title}</path>`
    })
    .join('')

  const nodes = map.modules
    .map(m => {
      const p = pos.get(m.id)!
      const state = states.get(m.id) ?? 'other'
      const tag = state === 'other' ? '' : `<text class="tag" x="${NODE_W - 14}" y="27" text-anchor="end">${esc(t.state[state])}</text>`
      return (
        `<g class="node ${state}" data-id="${esc(m.id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(m.name)}">` +
        `<rect class="body" width="${NODE_W}" height="${NODE_H}" rx="16"/>` +
        `<circle class="badge" cx="24" cy="23" r="11"/><text class="badge-n" x="24" y="27" text-anchor="middle">${numbers.get(m.id)}</text>` +
        `<text class="nm" x="44" y="28">${esc(clip(m.name, state === 'other' ? 12 : 8))}</text>${tag}` +
        `<text class="ds" x="16" y="56">${esc(clip(m.plain ?? m.responsibility, 16))}</text></g>`
      )
    })
    .join('')

  return (
    `<svg viewBox="0 0 ${width} ${height}" style="min-width:${Math.min(width, 640)}px" role="img" aria-label="${esc(t.diagramTitle)}">` +
    '<defs><marker id="ag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M0,0 L10,5 L0,10 z"/></marker></defs>' +
    `${zones}${edges}${nodes}</svg>`
  )
}

type Phase =
  | 'noMap'
  | 'none'
  | 'pending'
  | 'rejected'
  | 'editing'
  | 'checking'
  | 'completed'
  | 'unverified'
  | 'failed'
  | 'cancelled'
  | 'undone'

export function phaseOf(map: ArchMap | null, plan: Plan | null): Phase {
  if (map === null) return 'noMap'
  if (plan === null) return 'none'
  switch (plan.status) {
    case 'cancelled':
      return plan.undoneAt ? 'undone' : 'cancelled'
    case 'pending':
    case 'rejected':
    case 'failed':
      return plan.status
    case 'approved':
      return plan.checkRuns.length > 0 ? 'checking' : 'editing'
    case 'completed':
      return unverified(plan).length > 0 ? 'unverified' : 'completed'
  }
}

/** Which of the six steps is done, current, or still ahead. */
function stepStates(phase: Phase): ('done' | 'now' | 'bad' | 'todo')[] {
  const at: Record<Phase, number> = {
    noMap: 0, none: 1, pending: 2, rejected: 2, editing: 3, checking: 4, completed: 6, unverified: 5, failed: 5, cancelled: 2, undone: 3,
  }
  const current = at[phase]
  const isBad = phase === 'rejected' || phase === 'failed' || phase === 'unverified' || phase === 'cancelled' || phase === 'undone'
  return [0, 1, 2, 3, 4, 5].map(i => (i < current ? 'done' : i === current ? (isBad ? 'bad' : 'now') : 'todo'))
}

/** One risk reason as a plain sentence. */
export function riskText(reason: RiskReason, lang: Lang): string {
  const r = strings(lang).risk
  const list = (items: string[]) => items.join(lang === 'zh' ? '、' : ', ')
  switch (reason.code) {
    case 'out':
      return r.out(reason.count)
    case 'failed':
      return r.failed(list(reason.checks))
    case 'wide':
      return r.wide(reason.count, reason.total)
    case 'blocked':
      return r.blocked(reason.count)
    case 'core':
      return r.core(list(reason.parts))
    case 'impact':
      return r.impact(list(reason.parts))
    case 'noChecks':
      return r.noChecks
    case 'unmapped':
      return r.unmapped(reason.count)
    case 'stale':
      return r.stale
    case 'small':
      return r.small
  }
}

function riskCard(risk: Risk, lang: Lang): string {
  const r = strings(lang).risk
  return (
    `<div class="risk ${risk.level}"><span class="lamp" aria-hidden="true"></span><div>` +
    `<b>${esc(r.title)} · ${esc(r.level[risk.level])}</b>` +
    `<ul>${risk.reasons.map(x => `<li>${esc(riskText(x, lang))}</li>`).join('')}</ul></div></div>`
  )
}

const CSS = `
:root{--bg:#f5f5f7;--card:#fff;--fg:#1d1d1f;--sub:#6e6e73;--line:#d2d2d7;--fill:#f0f0f3;
--blue:#0071e3;--blue-t:#0066cc;--green:#34c759;--green-t:#248a3d;--orange:#ff9500;--orange-t:#b25000;--red:#ff3b30;--red-t:#d70015;
--orange-bg:#fff4e5;--blue-bg:#e8f2fd;--shadow:0 1px 2px rgba(0,0,0,.04),0 6px 24px rgba(0,0,0,.06)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#000;--card:#1c1c1e;--fg:#f5f5f7;--sub:#98989d;--line:#38383a;--fill:#2c2c2e;
--blue:#0a84ff;--blue-t:#409cff;--green:#30d158;--green-t:#30d158;--orange:#ff9f0a;--orange-t:#ffb340;--red:#ff453a;--red-t:#ff6961;
--orange-bg:#2b1d05;--blue-bg:#0b2340;--shadow:none;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#000;--card:#1c1c1e;--fg:#f5f5f7;--sub:#98989d;--line:#38383a;--fill:#2c2c2e;
--blue:#0a84ff;--blue-t:#409cff;--green:#30d158;--green-t:#30d158;--orange:#ff9f0a;--orange-t:#ffb340;--red:#ff453a;--red-t:#ff6961;
--orange-bg:#2b1d05;--blue-bg:#0b2340;--shadow:none;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.47 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:980px;margin:0 auto;padding:56px 20px 96px;display:grid;gap:48px}
code,.mono{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:.86em}
.hero{display:grid;gap:10px}
.eyebrow{color:var(--sub);font-weight:600;font-size:17px}
h1{margin:0;font:700 clamp(40px,7vw,64px)/1.06 -apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC",sans-serif;letter-spacing:-.025em}
h1.now{color:var(--fg)}h1.bad{color:var(--red-t)}h1.ok{color:var(--green-t)}
.lede{margin:0;color:var(--sub);font-size:21px;line-height:1.4;max-width:42em}
.steps{list-style:none;margin:8px 0 0;padding:4px;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px;background:var(--fill);border-radius:999px}
.steps li{text-align:center;padding:9px 4px;border-radius:999px;font-size:14px;font-weight:600;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.steps li.done{color:var(--green-t)}.steps li.done::before{content:"✓ "}
.steps li.now{background:var(--card);color:var(--fg);box-shadow:var(--shadow)}
.steps li.bad{background:var(--card);color:var(--red-t);box-shadow:var(--shadow)}
section{display:grid;gap:14px;min-width:0}
h2{margin:0 0 2px 4px;font-size:28px;font-weight:700;letter-spacing:-.015em}
.group{background:var(--card);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}
.row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 20px;position:relative;min-height:52px}
.row+.row::before{content:"";position:absolute;top:0;left:20px;right:0;border-top:.5px solid var(--line)}
.row .k{color:var(--fg)}.row .v{color:var(--sub);text-align:right;font-weight:500}
.v.now{color:var(--orange-t)}.v.ok{color:var(--green-t)}.v.bad{color:var(--red-t)}
.row.act{background:var(--blue-bg)}.row.act .k{font-weight:600}
.pill{display:inline-flex;align-items:center;gap:10px;background:var(--blue);color:#fff;border-radius:999px;padding:7px 8px 7px 16px;font:600 15px "SF Mono",ui-monospace,Menlo,monospace}
.pill button{all:unset;cursor:pointer;background:rgba(255,255,255,.22);border-radius:999px;padding:3px 10px;font:600 13px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.pill button:focus-visible{outline:2px solid #fff}
.callout{display:grid;grid-template-columns:28px 1fr;gap:12px;align-items:start;border-radius:18px;padding:16px 20px;background:var(--card);box-shadow:var(--shadow)}
.callout .ic{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:800;font-size:16px}
.callout.warn{background:var(--orange-bg)}.callout.warn .ic{background:var(--orange)}
.callout.info .ic{background:var(--sub)}
.callout b{display:block;font-size:15px;margin-bottom:2px}
.callout ol{margin:4px 0 0;padding-left:20px;color:var(--fg)}
.callout p{margin:0}
.legend{display:flex;flex-wrap:wrap;gap:8px 20px;padding:0 4px;font-size:14px;color:var(--sub)}
.legend span{display:inline-flex;align-items:center;gap:8px}
.legend i{width:22px;height:14px;border-radius:5px;border:2px solid var(--c);display:inline-block}
.legend i.dash{border-style:dashed}
.map{padding:8px}
.canvas{overflow-x:auto;border-radius:12px}
.canvas svg{display:block;width:100%;height:auto}
svg text{fill:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.zone rect{fill:var(--fill);stroke:none}.zone text{fill:var(--sub);font-size:13px;font-weight:600}
.edge{fill:none;stroke:var(--line);stroke-width:1.6;transition:stroke .15s,opacity .15s}
marker path{fill:var(--sub)}
.node{cursor:pointer;transition:opacity .15s}.node:focus{outline:none}
.node .body{fill:var(--card);stroke:var(--line);stroke-width:1}
.node .badge{fill:var(--fill)}.node .badge-n{fill:var(--sub);font:600 12px "SF Mono",ui-monospace,Menlo,monospace}
.node .nm{font-weight:600;font-size:15px}.node .ds{fill:var(--sub);font-size:12.5px}
.node .tag{font-size:12px;font-weight:600}
.node.planned .body{stroke:var(--blue);stroke-width:2.5}.node.planned .badge{fill:var(--blue)}.node.planned .badge-n{fill:#fff}.node.planned .tag{fill:var(--blue-t)}
.node.touched .body{stroke:var(--green);stroke-width:2.5}.node.touched .badge{fill:var(--green)}.node.touched .badge-n{fill:#fff}.node.touched .tag{fill:var(--green-t)}
.node.out .body{stroke:var(--red);stroke-width:2.5;stroke-dasharray:7 4}.node.out .badge{fill:var(--red)}.node.out .badge-n{fill:#fff}.node.out .tag{fill:var(--red-t)}
.node.impact .body{stroke:var(--orange);stroke-width:2;stroke-dasharray:4 4}.node.impact .tag{fill:var(--orange-t)}
.node.sel .body,.node:focus-visible .body{stroke:var(--blue);stroke-width:3.5;stroke-dasharray:none}
.edge.hot{stroke:var(--blue);stroke-width:2.6}.dim{opacity:.25}
.detail{padding:18px 20px 20px;border-top:.5px solid var(--line);display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px 24px;font-size:15px}
.detail .lead{grid-column:1/-1}.detail .hint{grid-column:1/-1;color:var(--sub);margin:0}
.detail h3{margin:2px 0 4px;font-size:22px;letter-spacing:-.01em}
.detail .l{font-size:12px;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
.detail p{margin:0}.detail code{word-break:break-all}
.parts .row{align-items:flex-start;justify-content:flex-start}
.parts .n{flex:none;width:26px;height:26px;border-radius:50%;background:var(--fill);color:var(--sub);display:grid;place-items:center;font:600 12px "SF Mono",ui-monospace,Menlo,monospace;margin-top:1px}
.parts .n.planned{background:var(--blue);color:#fff}.parts .n.touched{background:var(--green);color:#fff}.parts .n.out{background:var(--red);color:#fff}
.parts .body{flex:1;min-width:0}.parts .body b{font-weight:600}.parts .body p{margin:2px 0 0;color:var(--sub);font-size:15px}
.parts .s{flex:none;font-size:14px;font-weight:600;color:var(--sub)}
.s.planned{color:var(--blue-t)}.s.touched{color:var(--green-t)}.s.out{color:var(--red-t)}.s.impact{color:var(--orange-t)}
.files .row{justify-content:flex-start;gap:12px}.files .row code{flex:1;min-width:0;word-break:break-all}
.terms{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.term{background:var(--card);border-radius:16px;padding:14px 16px;box-shadow:var(--shadow);font-size:15px;color:var(--sub)}
.term b{display:block;color:var(--fg);font-size:16px;margin-bottom:2px}
details{background:var(--card);border-radius:18px;box-shadow:var(--shadow);padding:4px 0}
summary{cursor:pointer;padding:12px 20px;font-weight:600}
details ul{list-style:none;margin:0;padding:0 20px 12px;display:grid;gap:8px;font-size:14px}
details li span{color:var(--sub)}
footer{color:var(--sub);font-size:13px;text-align:center}
.risk{display:grid;grid-template-columns:22px 1fr;gap:12px;align-items:start;background:var(--card);border-radius:18px;padding:14px 20px;box-shadow:var(--shadow);margin-top:6px}
.risk .lamp{width:16px;height:16px;border-radius:50%;margin-top:4px;background:var(--c);box-shadow:0 0 0 4px color-mix(in srgb,var(--c) 22%,transparent)}
.risk.green{--c:var(--green)}.risk.amber{--c:var(--orange)}.risk.red{--c:var(--red)}
.risk b{font-size:16px}.risk ul{margin:2px 0 0;padding-left:18px;color:var(--sub);font-size:15px}
@media (max-width:720px){main{padding-top:36px;gap:36px}.steps{grid-template-columns:repeat(3,minmax(0,1fr));border-radius:18px}.terms{grid-template-columns:minmax(0,1fr)}.detail{grid-template-columns:minmax(0,1fr)}.row{flex-wrap:wrap}.row .v{text-align:left}}
@media (prefers-reduced-motion:reduce){.edge,.node{transition:none}}
`

const SCRIPT = `
(function(){
  var data = JSON.parse(document.getElementById('ag-data').textContent);
  var svg = document.querySelector('.canvas svg'), detail = document.getElementById('ag-detail');
  if (!svg) return;
  var nodes = svg.querySelectorAll('.node'), edges = svg.querySelectorAll('.edge');
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function select(id){
    var p = data.parts[id]; if (!p) return;
    var near = {}; near[id] = 1;
    edges.forEach(function(e){ var hot = e.dataset.a === id || e.dataset.b === id; if (hot){ near[e.dataset.a] = 1; near[e.dataset.b] = 1; } e.classList.toggle('hot', hot); e.classList.toggle('dim', !hot); });
    nodes.forEach(function(n){ n.classList.toggle('sel', n.dataset.id === id); n.classList.toggle('dim', !near[n.dataset.id]); });
    var t = data.t;
    detail.innerHTML = '<div class="lead"><div class="l">' + esc(p.label) + '</div><h3>' + esc(p.name) + '</h3><p>' + esc(p.plain) + '</p></div>' +
      '<div><div class="l">' + esc(t.thisTime) + '</div><p>' + esc(p.state) + '</p></div>' +
      '<div><div class="l">' + esc(t.uses) + '</div><p>' + esc(p.uses.join('、') || t.none) + '</p></div>' +
      '<div><div class="l">' + esc(t.users) + '</div><p>' + esc(p.users.join('、') || t.none) + '</p></div>' +
      '<div><div class="l">' + esc(t.files) + '</div><p><code>' + esc(p.files) + '</code></p></div>';
  }
  nodes.forEach(function(n){
    n.addEventListener('click', function(){ select(n.dataset.id); });
    n.addEventListener('keydown', function(ev){ if (ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); select(n.dataset.id); } });
  });
  var copy = document.getElementById('ag-copy');
  if (copy) copy.addEventListener('click', function(){
    var done = function(){ copy.textContent = data.t.copied; };
    try { navigator.clipboard.writeText(copy.dataset.text).then(done, function(){}); } catch (e) {}
  });
})();
`

export function renderReport(input: {
  map: ArchMap
  plan: Plan | null
  stale: Staleness | null
  activity: readonly ActivityEntry[]
  lang: Lang
  now: string
}): string {
  const all = strings(input.lang)
  const t = all.r
  const { map, plan, stale } = input
  const states = moduleStates(map, plan)
  const numbers = new Map(map.modules.map((m, i) => [m.id, i + 1]))
  const nameOf = (id: string) => map.modules.find(m => m.id === id)?.name ?? id
  const phase = phaseOf(map, plan)
  const tone = phase === 'completed' ? 'ok' : ['rejected', 'failed', 'unverified', 'cancelled', 'undone'].includes(phase) ? 'bad' : 'now'
  const risk = plan !== null ? riskCard(assessRisk(map, plan, stale), input.lang) : ''

  const steps = stepStates(phase)
    .map((s, i) => `<li class="${s}"${s === 'now' || s === 'bad' ? ' aria-current="step"' : ''}>${esc(t.steps[i] ?? '')}</li>`)
    .join('')

  // the checklist
  const rows: string[] = []
  const row = (k: string, v: string, cls = '') => rows.push(`<div class="row"><span class="k">${esc(k)}</span><span class="v ${cls}">${v}</span></div>`)
  let action = ''
  const callouts: string[] = []
  const warn = (text: string) => callouts.push(`<div class="callout warn"><span class="ic">!</span><div><b>${esc(t.caution)}</b><p>${esc(text)}</p></div></div>`)
  if (stale !== null) warn(all.stale(stale.changedFiles, stale.modules.map(nameOf).join('、') || all.none))

  if (plan !== null) {
    const missing = unverified(plan)
    const out = plan.touched.filter(f => !f.isInScope)
    const blocked = out.filter(f => f.isBlocked).length
    const ran = plan.checks.map(c => plan.checkRuns.filter(r => r.command.includes(c)).at(-1))
    row(t.rowPlan, esc(`#${plan.id} · ${all.status[plan.status]}`), tone)
    row(t.rowParts, esc(`${all.partsCount(plan.modules.length)}：${plan.modules.map(nameOf).join('、')}`))
    row(t.rowFiles, esc(plan.files.length > 0 ? all.partsCount(plan.files.length) : t.filesUnknown))
    row(t.rowImpact, esc(plan.impact.length > 0 ? plan.impact.map(nameOf).join('、') : all.none), plan.impact.length > 0 ? 'now' : 'ok')
    if (plan.touched.length > 0) row(t.rowTouched, esc(t.touchedVal(plan.touched.filter(f => !f.isBlocked).length, out.length)), out.length > 0 ? 'bad' : 'ok')
    row(
      t.rowChecks,
      esc(t.checksVal(ran.filter(r => r?.isOk).length, ran.filter(r => r && !r.isOk).length, ran.filter(r => !r).length)),
      ran.some(r => r && !r.isOk) ? 'bad' : ran.length > 0 && ran.every(r => r?.isOk) ? 'ok' : '',
    )

    if (plan.status === 'pending') {
      action = `<span class="pill">${esc(t.actApprove)}<button id="ag-copy" type="button" data-text="${esc(t.actApprove)}">${esc(t.copy)}</button></span>`
      warn(t.cautionPending)
    } else if (plan.status === 'rejected') {
      action = esc(t.actWait)
      warn(t.cautionRejected(plan.rejectReason ?? ''))
    } else {
      action = esc(t.actNone)
    }
    if (blocked > 0) warn(t.cautionBlocked(blocked))
    if (out.length - blocked > 0) warn(t.cautionWarned(out.length - blocked))
    if (plan.status === 'completed' && missing.length > 0) warn(t.cautionUnverified(missing.join('、')))
    if (plan.status === 'approved' && plan.restorePoint) {
      callouts.push(`<div class="callout info"><span class="ic">↺</span><div><p>${esc(all.undo.hint)}</p></div></div>`)
    }
  } else {
    action = esc(t.actNone)
  }
  if (stale !== null && (plan === null || plan.status !== 'pending')) action = esc(t.actRemap)
  rows.push(`<div class="row act"><span class="k">${esc(all.youDo)}</span><span class="v">${action}</span></div>`)

  const note =
    plan?.status === 'pending'
      ? `<div class="callout info"><span class="ic">i</span><div><b>${esc(t.noteTitle)}</b><ol>${t.noteSteps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div></div>`
      : ''

  const touched =
    plan !== null && plan.touched.length > 0
      ? `<section><h2>${esc(t.touchedTitle)}</h2><div class="group files">${plan.touched
          .map(f => {
            const cls = f.isInScope ? 'touched' : 'out'
            const tag = (f.isBlocked ? all.blocked : f.isInScope ? t.state.touched : all.outOfScope) + (f.isShell ? all.shellNote : '')
            return `<div class="row"><code>${esc(f.path)}</code><span class="s ${cls}">${esc(tag)}</span></div>`
          })
          .join('')}</div></section>`
      : ''

  // the diagram's data, for the selection panel
  const parts: Record<string, unknown> = {}
  for (const m of map.modules) {
    const state = states.get(m.id) ?? 'other'
    parts[m.id] = {
      label: t.part(numbers.get(m.id) ?? 0),
      name: m.name,
      plain: m.plain ?? m.responsibility,
      state: t.state[state],
      uses: map.relations.filter(r => r.from === m.id).map(r => nameOf(r.to)),
      users: map.relations.filter(r => r.to === m.id).map(r => nameOf(r.from)),
      files: m.paths.join(' · '),
    }
  }
  const data = JSON.stringify({ parts, t: { thisTime: t.thisTime, uses: t.uses, users: t.users, files: t.files, none: all.none, copied: t.copied } }).replace(
    /</g,
    '\\u003c',
  )

  const legend = (
    [
      ['planned', 'var(--blue)', ''],
      ['touched', 'var(--green)', ''],
      ['out', 'var(--red)', 'dash'],
      ['impact', 'var(--orange)', 'dash'],
      ['other', 'var(--line)', ''],
    ] as const
  )
    .map(([k, c, dash]) => `<span><i class="${dash}" style="--c:${c}"></i>${esc(t.legend[k])}</span>`)
    .join('')

  const partsList = map.modules
    .map(m => {
      const state = states.get(m.id) ?? 'other'
      return (
        `<div class="row"><span class="n ${state}">${numbers.get(m.id)}</span>` +
        `<div class="body"><b>${esc(m.name)}</b><p>${esc(m.plain ?? m.responsibility)}</p></div>` +
        `<span class="s ${state}">${esc(t.state[state])}</span></div>`
      )
    })
    .join('')

  const activity = input.activity.slice(-80).reverse()
  const activityHtml =
    activity.length > 0
      ? `<details><summary>${esc(t.activityTitle(activity.length))}</summary><ul>${activity
          .map(a => `<li><span>${esc(a.at.slice(0, 16).replace('T', ' '))} · ${esc(a.evidence === 'observed' ? t.observed : t.declared)}</span><br>${esc(a.text)}</li>`)
          .join('')}</ul></details>`
      : ''

  const lede = plan !== null ? plan.summary : t.noPlanLede
  const commit = map.commit ? `${map.commit.slice(0, 7)}${map.isDirty ? '*' : ''}` : ''

  return `<!doctype html>
<html lang="${input.lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(map.project)} · archgate</title><style>${CSS}</style></head>
<body><main>
<header class="hero">
<div class="eyebrow">${esc(t.head)} · ${esc(map.project)}</div>
<h1 class="${tone}">${esc(t.headline[phase])}</h1>
<p class="lede">${esc(lede)}</p>
<ol class="steps">${steps}</ol>
${risk}
</header>
<section><h2>${esc(t.statusTitle)}</h2><div class="group">${rows.join('')}</div>${callouts.join('')}${note}</section>
${touched}
<section><h2>${esc(t.diagramTitle)}</h2>
<div class="callout info"><span class="ic">i</span><div><b>${esc(t.howTitle)}</b><ol>${t.how.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div></div>
<div class="legend">${legend}</div>
<div class="group map"><div class="canvas">${diagram(map, states, numbers, input.lang)}</div><div class="detail" id="ag-detail" aria-live="polite"><p class="hint">${esc(t.hint)}</p></div></div>
</section>
<section><h2>${esc(t.partsTitle)}</h2><div class="group parts">${partsList}</div></section>
<section><h2>${esc(t.termsTitle)}</h2><div class="terms">${t.terms.map(([k, v]) => `<div class="term"><b>${esc(k)}</b>${esc(v)}</div>`).join('')}</div></section>
${activityHtml}
<footer>${esc(t.foot(map.revision, commit, input.now.slice(0, 16).replace('T', ' ')))}</footer>
</main>
<script type="application/json" id="ag-data">${data}</script>
<script>${SCRIPT}</script>
</body></html>
`
}
