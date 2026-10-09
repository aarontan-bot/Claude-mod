import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/repo'
const HEAD = 'a'.repeat(40)

/** A project on an in-memory disk with git answering from it. */
function world(on: On) {
  const files = new Map<string, string>([
    [`${ROOT}/src/auth/login.ts`, 'export function login() {}\n'.repeat(20)],
    [`${ROOT}/src/api/routes.ts`, 'export const routes = []\n'],
    [`${ROOT}/src/db/index.ts`, 'export const db = {}\n'],
    [`${ROOT}/README.md`, '# shop\n'],
  ])
  const toasts: string[] = []
  const prompts: string[] = []
  const edits: string[] = []
  let status: string | undefined

  mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: ROOT }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__archgate__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).join(' ')
    const stdout =
      args === 'rev-parse HEAD'
        ? `${HEAD}\n`
        : args === 'ls-files'
          ? [...files.keys()].filter(f => !f.includes('.archgate')).map(f => f.slice(ROOT.length + 1)).join('\n')
          : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', { tool: 'Edit' }, ($, e) => {
    edits.push(e.file_path)
    return { result: { filePath: e.file_path } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) =>
    e.command.includes('lint') ? { isError: true, result: 'lint failed', text: 'exit 1' } : { result: { stdout: 'ok', stderr: '', interrupted: false } },
  )

  return { files, toasts, prompts, edits, status: () => status }
}

const MAP = {
  project: 'shop',
  modules: [
    { id: 'api', name: 'API', responsibility: 'HTTP routes', paths: ['src/api'], evidence: [{ path: 'src/api/routes.ts', lines: [1, 1] }] },
    { id: 'auth', name: 'Auth', responsibility: 'Login', paths: ['src/auth'], evidence: [{ path: 'src/auth/login.ts', lines: [1, 400] }] },
    { id: 'db', name: 'DB', responsibility: 'Storage', paths: ['src/db'], evidence: [{ path: 'src/db/gone.ts' }] },
  ],
  relations: [
    { from: 'api', to: 'auth', label: 'login' },
    { from: 'auth', to: 'db' },
  ],
}

const edit = (path: string) => ({ tool: 'Edit' as const, file_path: `${ROOT}/${path}`, old_string: 'a', new_string: 'b' })

test('map, plan, approve, edit, check, complete', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  // the map is checked, written, and its evidence verified
  const mapped = await $.tool.call({ tool: 'mcp__archgate__archgate_map', ...MAP })
  expect(mapped.deny).toBeUndefined()
  const receipt = String(mapped.result)
  expect(receipt).toContain('revision 1, 3 modules')
  expect(receipt).toContain('Coverage: 3/4')
  expect(receipt).toContain('src/db/gone.ts (db) does not exist')
  expect(receipt).toContain('src/auth/login.ts:1-400 (auth) runs past the end')
  expect(JSON.parse(w.files.get(`${ROOT}/.archgate/map.json`)!).commit).toBe(HEAD)

  // the map file is archgate's own
  expect((await $.tool.call(edit('.archgate/map.json'))).deny).toContain('written by archgate itself')

  // on-demand: free editing until a plan exists
  expect((await $.tool.call(edit('src/db/index.ts'))).deny).toBeUndefined()

  // a plan naming an unknown module is refused
  expect((await $.tool.call({ tool: 'mcp__archgate__archgate_plan', summary: 'x', modules: ['nope'] })).deny).toContain('unknown id')

  const planned = await $.tool.call({
    tool: 'mcp__archgate__archgate_plan',
    summary: 'Rate-limit login',
    modules: ['auth'],
    checks: ['npm test', 'npm run lint'],
  })
  expect(String(planned.result)).toContain('waiting for the user')
  expect(String(planned.result)).toContain('may be affected and are not in scope: api')
  expect(w.toasts.some(t => t.includes('#1'))).toBe(true)

  // nothing is edited while the plan waits
  expect((await $.tool.call(edit('src/auth/login.ts'))).deny).toContain('waiting for the user')

  // the model cannot approve through the command
  const sneaky = await $.command.run({
    command: 'archgate',
    args: 'approve',
    origin: { kind: 'sdk' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(sneaky.text).toContain('only the person')

  // the person approves from the pane
  const pane = await $.ui.mount({ plugin: 'archgate', surface: 'terminal', component: 'Pane', requestId: 'archgate', props: {} as never })
  await pane.press({ key: 'approve' })
  expect(w.prompts.some(p => p.includes('approved plan #1'))).toBe(true)

  // inside the scope goes through; outside is refused and recorded
  expect((await $.tool.call(edit('src/auth/login.ts'))).deny).toBeUndefined()
  const outside = await $.tool.call(edit('src/db/index.ts'))
  expect(outside.deny).toContain('outside approved plan #1')
  expect(w.toasts.some(t => t.includes('src/db/index.ts'))).toBe(true)

  // a narrower plan is approved at once
  const narrower = await $.tool.call({ tool: 'mcp__archgate__archgate_plan', summary: 'Only login.ts', modules: ['auth'], files: ['src/auth/login.ts'], checks: ['npm test', 'npm run lint'] })
  expect(String(narrower.result)).toContain('so it is approved')

  // real check outcomes are recorded
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const done = await $.tool.call({ tool: 'mcp__archgate__archgate_complete', outcome: 'completed', note: 'done' })
  expect(String(done.result)).toContain('Unverified: npm run lint')
  expect(w.status()).toContain('r1')

  const report = w.files.get(`${ROOT}/.archgate/report.html`)!
  expect(report).toContain('<svg')
  expect(report).toContain('src/db/index.ts')

  const log = w.files.get(`${ROOT}/.archgate/activity.jsonl`)!.trim().split('\n').map(l => JSON.parse(l))
  expect(log.map(e => e.kind)).toEqual(['map', 'plan', 'approve', 'edit', 'blocked', 'plan', 'check', 'check', 'completed'])
  expect(log.find(e => e.kind === 'check' && e.text.includes('lint')).text).toContain('failed')
  await pane.unmount()
})

test('auto mode and warn enforcement', { options: { mode: 'auto', enforcement: 'warn' } }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  // auto mode wants a map and a plan; warn lets the edit through but tells the model
  const unmapped = await $.tool.call(edit('src/db/index.ts'))
  expect(unmapped.deny).toBeUndefined()
  expect(unmapped.context?.join('\n')).toContain('no map yet')
  expect(w.edits.length).toBe(1)

  await $.tool.call({ tool: 'mcp__archgate__archgate_map', ...MAP })
  const unplanned = await $.tool.call(edit('src/db/index.ts'))
  expect(unplanned.context?.join('\n')).toContain('submit a plan')

  await $.tool.call({ tool: 'mcp__archgate__archgate_plan', summary: 'x', modules: ['auth'] })
  const early = await $.tool.call(edit('src/auth/login.ts'))
  expect(early.context?.join('\n')).toContain('waiting for the user')
  expect(w.edits.length).toBe(3)

  // a plan never approved can only be cancelled
  expect((await $.tool.call({ tool: 'mcp__archgate__archgate_complete', outcome: 'completed' })).deny).toContain('never approved')
  expect(String((await $.tool.call({ tool: 'mcp__archgate__archgate_complete', outcome: 'cancelled' })).result)).toContain('cancelled')
})

test('the prompt section reflects the plan', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const before = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const intro = before.sections.find(s => s.id === 'archgate:context')!
  expect(intro.text).toContain('archgate_map')
  expect(intro.text).not.toContain('Workflow')

  await $.tool.call({ tool: 'mcp__archgate__archgate_map', ...MAP })
  await $.tool.call({ tool: 'mcp__archgate__archgate_plan', summary: 'x', modules: ['auth'] })
  const after = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const text = after.sections.find(s => s.id === 'archgate:context')!.text
  expect(text).toContain('- auth: Auth [src/auth]')
  expect(text).toContain('Plan #1: pending')
  expect(after.sections[0]!.id).toBe('intro')
})

test('the pane draws on terminal and desktop', async ($, on) => {
  world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const PANE = { plugin: 'archgate', component: 'Pane', requestId: 'archgate', props: {} as never } as const

  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ ...PANE, surface })
    expect(await empty.find({ type: 'Text', text: /archgate_map/ })).toBeDefined()
    await empty.unmount()
  }

  await $.tool.call({ tool: 'mcp__archgate__archgate_map', ...MAP })
  await $.tool.call({ tool: 'mcp__archgate__archgate_plan', summary: '限流登录接口', modules: ['auth'], checks: ['npm test'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /限流登录接口/ })).toBeDefined()
    expect(await pane.find({ key: 'approve' })).toBeDefined()
    expect(await pane.find({ key: 'reject' })).toBeDefined()
    await pane.unmount()
  }
})
