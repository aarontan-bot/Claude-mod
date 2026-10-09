import { describe, expect, test } from 'claude-code/testing'

import type { ArchMap, Plan } from '../types'
import { checkPlan, decideEdit, isCheck, isWithin, unverified } from '../hooks/lib/gate'
import { checkMap, coverage, diffMaps, ownersOf, reach } from '../hooks/lib/map'
import { matchPath, normalize, relativeTo } from '../hooks/lib/paths'
import { bands, layers, moduleStates, phaseOf, renderReport } from '../hooks/lib/report'

const MAP: ArchMap = {
  version: 1,
  project: 'shop',
  revision: 1,
  updatedAt: '2026-10-09T00:00:00.000Z',
  modules: [
    { id: 'web', name: 'Web', responsibility: 'Pages', paths: ['src/web'] },
    { id: 'api', name: 'API', responsibility: 'HTTP handlers', paths: ['src/api/**/*.ts'] },
    { id: 'auth', name: 'Auth', responsibility: 'Login and tokens', paths: ['src/auth'] },
    { id: 'db', name: 'DB', responsibility: 'Persistence', paths: ['src/db', 'migrations/*.sql'] },
  ],
  relations: [
    { from: 'web', to: 'api' },
    { from: 'api', to: 'auth' },
    { from: 'api', to: 'db' },
    { from: 'auth', to: 'db' },
  ],
}

const plan = (over: Partial<Plan> = {}): Plan => ({
  id: 1,
  summary: 'rate limit login',
  modules: ['auth'],
  files: [],
  checks: ['npm test'],
  impact: ['api'],
  status: 'approved',
  createdAt: '2026-10-09T00:00:00.000Z',
  touched: [],
  checkRuns: [],
  ...over,
})

describe('paths', () => {
  test('normalises and relativises', () => {
    expect(normalize('./src//a/../b/')).toBe('src/b')
    expect(relativeTo('/repo', '/repo/src/x.ts')).toBe('src/x.ts')
    expect(relativeTo('/repo', '/repo/../etc/passwd')).toBe(null)
    expect(relativeTo('/repo', '/repository/x')).toBe(null)
  })

  test('matches plain folders and globs', () => {
    expect(matchPath('src/web', 'src/web/a/b.tsx')).toBe(true)
    expect(matchPath('src/web', 'src/webhooks/a.ts')).toBe(false)
    expect(matchPath('src/api/**/*.ts', 'src/api/a.ts')).toBe(true)
    expect(matchPath('src/api/**/*.ts', 'src/api/v1/users.ts')).toBe(true)
    expect(matchPath('src/api/**/*.ts', 'src/api/v1/users.js')).toBe(false)
    expect(matchPath('*.{json,yml}', 'package.json')).toBe(true)
  })
})

describe('map', () => {
  test('rejects bad ids, unknown relations and absolute paths', () => {
    const { errors } = checkMap({
      modules: [
        { id: 'Bad', name: 'x', responsibility: 'x', paths: ['/etc'] },
        { id: 'ok', name: 'ok', responsibility: 'ok', paths: ['src'] },
      ],
      relations: [{ from: 'ok', to: 'missing' }],
    })
    expect(errors.some(e => e.includes('"Bad"'))).toBe(true)
    expect(errors.some(e => e.includes('/etc'))).toBe(true)
    expect(errors.some(e => e.includes('"missing"'))).toBe(true)
  })

  test('accepts a sound map and warns about missing evidence and plain sentences', () => {
    const { errors, warnings } = checkMap({ project: 'shop', modules: MAP.modules, relations: MAP.relations })
    expect(errors).toEqual([])
    expect(warnings.filter(w => w.includes('evidence')).length).toBe(4)
    expect(warnings.filter(w => w.includes('plain sentence')).length).toBe(4)
  })

  test('keeps the plain sentence and the area', () => {
    const { value } = checkMap({
      modules: [{ id: 'a', name: '门卫', responsibility: 'x', plain: ' 判断改动在不在范围里。 ', group: '规则区', paths: ['src'] }],
      relations: [],
    })
    expect(value.modules[0]?.plain).toBe('判断改动在不在范围里。')
    expect(value.modules[0]?.group).toBe('规则区')
  })

  test('finds owners and callers', () => {
    expect(ownersOf(MAP, 'src/auth/login.ts')).toEqual(['auth'])
    expect(ownersOf(MAP, 'migrations/001.sql')).toEqual(['db'])
    expect(ownersOf(MAP, 'README.md')).toEqual([])
    expect(reach(MAP, ['db'], 'upstream', 1).sort()).toEqual(['api', 'auth'])
    expect(reach(MAP, ['db'], 'upstream').sort()).toEqual(['api', 'auth', 'web'])
    expect(reach(MAP, ['web'], 'downstream', 1)).toEqual(['api'])
  })

  test('diffs revisions and measures coverage', () => {
    const next: ArchMap = {
      ...MAP,
      revision: 2,
      modules: [...MAP.modules.filter(m => m.id !== 'web'), { id: 'jobs', name: 'Jobs', responsibility: 'Cron', paths: ['src/jobs'] }],
      relations: MAP.relations.filter(r => r.from !== 'web'),
    }
    const d = diffMaps(MAP, next)
    expect(d.addedModules).toEqual(['jobs'])
    expect(d.removedModules).toEqual(['web'])
    expect(d.removedRelations).toEqual(['web->api'])

    const c = coverage(MAP, ['src/web/a.ts', 'src/auth/b.ts', 'scripts/x/y.sh', 'README.md'])
    expect(c.owned).toBe(2)
    expect(c.unownedDirs).toContain('scripts/x/ (1)')
  })
})

describe('plan', () => {
  test('rejects unknown modules and files owned elsewhere', () => {
    const { errors } = checkPlan(MAP, { summary: 'x', modules: ['auth', 'nope'], files: ['src/db/a.ts'] })
    expect(errors.some(e => e.includes('nope'))).toBe(true)
    expect(errors.some(e => e.includes('src/db/a.ts'))).toBe(true)
  })

  test('computes the callers a change may break', () => {
    const { draft, errors } = checkPlan(MAP, { summary: 'x', modules: ['auth'], checks: ['npm test'] })
    expect(errors).toEqual([])
    expect(draft.impact.sort()).toEqual(['api', 'web'])
  })

  test('a narrower plan stays within an approved one', () => {
    const approved = plan({ modules: ['auth', 'db'] })
    expect(isWithin(MAP, { ...approved, modules: ['db'], files: ['src/db/x.ts'] }, approved)).toBe(true)
    expect(isWithin(MAP, { ...approved, modules: ['api'] }, approved)).toBe(false)
  })
})

describe('gate', () => {
  const base = { map: MAP, mode: 'on-demand' as const, enforcement: 'block' as const, isPaused: false }

  test('lets everything through with no plan in on-demand mode', () => {
    expect(decideEdit({ ...base, plan: null, path: 'src/db/a.ts' }).verdict).toBe('allow')
  })

  test('auto mode needs a plan', () => {
    expect(decideEdit({ ...base, mode: 'auto', plan: null, path: 'src/db/a.ts' }).verdict).toBe('deny')
  })

  test('holds every edit while the plan waits or was rejected', () => {
    expect(decideEdit({ ...base, plan: plan({ status: 'pending' }), path: 'src/auth/a.ts' }).verdict).toBe('deny')
    const rejected = decideEdit({ ...base, plan: plan({ status: 'rejected', rejectReason: 'too wide' }), path: 'src/auth/a.ts' })
    expect(rejected.reason).toContain('too wide')
  })

  test('allows the approved scope and refuses the rest', () => {
    const p = plan({ files: ['README.md'] })
    expect(decideEdit({ ...base, plan: p, path: 'src/auth/a.ts' }).verdict).toBe('allow')
    expect(decideEdit({ ...base, plan: p, path: 'README.md' }).verdict).toBe('allow')
    const out = decideEdit({ ...base, plan: p, path: 'src/db/a.ts' })
    expect(out.verdict).toBe('deny')
    expect(out.owners).toEqual(['db'])
    expect(decideEdit({ ...base, enforcement: 'warn', plan: p, path: 'src/db/a.ts' }).verdict).toBe('warn')
    expect(decideEdit({ ...base, isPaused: true, plan: p, path: 'src/db/a.ts' }).verdict).toBe('allow')
  })

  test('protects its own folder and ignores files outside the project', () => {
    expect(decideEdit({ ...base, plan: null, path: '.archgate/map.json' }).verdict).toBe('deny')
    expect(decideEdit({ ...base, isPaused: true, plan: null, path: '.archgate/map.json' }).verdict).toBe('deny')
    expect(decideEdit({ ...base, plan: plan({ status: 'pending' }), path: null }).verdict).toBe('allow')
  })

  test('recognises checks and reports unverified ones', () => {
    expect(isCheck('npm run test -- --watch=false', [])).toBe(true)
    expect(isCheck('ls -la', [])).toBe(false)
    expect(isCheck('./scripts/verify.sh', ['./scripts/verify.sh'])).toBe(true)
    const p = plan({ checks: ['npm test', 'npm run lint'], checkRuns: [{ command: 'npm test', isOk: true, at: '' }] })
    expect(unverified(p)).toEqual(['npm run lint'])
    expect(unverified({ ...p, checkRuns: [...p.checkRuns, { command: 'npm test', isOk: false, at: '' }] })).toEqual(['npm test', 'npm run lint'])
  })
})

describe('report', () => {
  test('lays callers left of what they call', () => {
    const l = layers(MAP)
    expect(l.get('web')).toBe(0)
    expect(l.get('api')).toBe(1)
    expect(l.get('db')).toBe(3)
  })

  test('marks out-of-scope edits worst', () => {
    const p = plan({
      touched: [
        { path: 'src/auth/a.ts', modules: ['auth'], isInScope: true, isBlocked: false },
        { path: 'src/db/a.ts', modules: ['db'], isInScope: false, isBlocked: true },
      ],
    })
    const s = moduleStates(MAP, p)
    expect(s.get('auth')).toBe('touched')
    expect(s.get('db')).toBe('out')
    expect(s.get('api')).toBe('impact')
    expect(s.get('web')).toBe('other')
  })

  test('renders a standalone page that escapes text', () => {
    const html = renderReport({
      map: { ...MAP, project: '<shop>' },
      plan: plan(),
      stale: null,
      activity: [],
      lang: 'en',
      now: '2026-10-09T00:00:00.000Z',
    })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('&lt;shop&gt;')
    expect(html).not.toContain('<shop>')
    expect(html).toContain('<svg')
  })

  test('stacks areas top to bottom, callers first, unlinked areas last', () => {
    const grouped: ArchMap = {
      ...MAP,
      modules: [
        { id: 'docs', name: 'Docs', responsibility: 'x', group: 'Papers', paths: ['docs'] },
        ...MAP.modules.map(m => ({ ...m, group: m.id === 'web' ? 'Front' : m.id === 'db' ? 'Storage' : 'Server' })),
      ],
    }
    expect(bands(grouped).map(b => b.label)).toEqual(['Front', 'Server', 'Storage', 'Papers'])
    expect(bands(MAP).map(b => b.ids)).toEqual([['web'], ['api'], ['auth'], ['db']])
  })

  test('the headline says where the work stands', () => {
    expect(phaseOf(MAP, null)).toBe('none')
    expect(phaseOf(MAP, plan({ status: 'pending' }))).toBe('pending')
    expect(phaseOf(MAP, plan())).toBe('editing')
    expect(phaseOf(MAP, plan({ checkRuns: [{ command: 'npm test', isOk: true, at: '' }] }))).toBe('checking')
    expect(phaseOf(MAP, plan({ status: 'completed' }))).toBe('unverified')
    const html = renderReport({ map: MAP, plan: plan({ status: 'pending' }), stale: null, activity: [], lang: 'zh', now: '2026-10-09T00:00:00.000Z' })
    expect(html).toContain('<h1 class="now">等你确认</h1>')
    expect(html).toContain('id="ag-copy"')
    expect(html).toContain('你确认之前，Claude 不能改代码。')
  })
})
