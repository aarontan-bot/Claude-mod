// Finding the files a shell command changed: hash every file git reports as
// changed or new before and after the command, and compare.

import { STATE_DIR } from './gate'

/** The paths in `git status --porcelain=v1 -z` output, archgate's own left out. */
export function parsePorcelain(text: string): string[] {
  const fields = text.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const status = field.slice(0, 2)
    paths.push(field.slice(3))
    // a rename or copy is followed by the path it came from
    if (status.includes('R') || status.includes('C')) i++
  }
  return paths.filter(p => p !== STATE_DIR && !p.startsWith(`${STATE_DIR}/`))
}

/** A file's content hash, or null when the file is gone. */
export type Hashes = Map<string, string | null>

/** The paths whose content differs between two snapshots. */
export function changedPaths(before: Hashes, after: Hashes): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter(p => before.get(p) !== after.get(p)).sort()
}
