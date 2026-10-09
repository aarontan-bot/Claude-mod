// Path helpers: no Node here, so normalisation and globbing are done by hand.

const GLOB_CHARS = /[*?[\]{}]/

export function normalize(path: string): string {
  const isAbsolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!isAbsolute) out.push('..')
      continue
    }
    out.push(part)
  }
  return (isAbsolute ? '/' : '') + out.join('/')
}

/** The path relative to `root`, or null when it lies outside it. */
export function relativeTo(root: string, path: string): string | null {
  const base = normalize(root)
  const full = normalize(path.startsWith('/') ? path : `${base}/${path}`)
  if (full === base) return ''
  const prefix = base.endsWith('/') ? base : `${base}/`
  return full.startsWith(prefix) ? full.slice(prefix.length) : null
}

/** A project-relative path the map may name: no root, no `..`, no `.git`. */
export function isSafeRelative(path: string): boolean {
  if (path === '' || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false
  return !path
    .replace(/\\/g, '/')
    .split('/')
    .some(part => part === '..' || part === '.git')
}

function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const isSegment = glob[i + 2] === '/'
        re += isSegment ? '(?:.*/)?' : '.*'
        i += isSegment ? 2 : 1
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) {
        re += '\\{'
      } else {
        const options = glob.slice(i + 1, end).split(',').map(escape)
        re += `(?:${options.join('|')})`
        i = end
      }
    } else {
      re += escape(c)
    }
  }
  return new RegExp(`^${re}$`)
}

function escape(text: string): string {
  return text.replace(/[.+^$()|[\]\\]/g, '\\$&')
}

const cache = new Map<string, RegExp>()

/**
 * Whether `path` falls under `pattern`: a plain path owns itself and
 * everything below it; a glob (`src/**`, `*.config.ts`) must match whole.
 */
export function matchPath(pattern: string, path: string): boolean {
  const p = normalize(pattern)
  if (!GLOB_CHARS.test(p)) return path === p || path.startsWith(`${p}/`)
  let re = cache.get(p)
  if (re === undefined) {
    re = globToRegExp(p)
    cache.set(p, re)
  }
  return re.test(path)
}
