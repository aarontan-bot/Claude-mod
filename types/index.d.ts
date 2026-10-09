export type Evidence = {
  path: string
  lines?: [number, number]
  note?: string
}

export type ArchModule = {
  id: string
  /** An everyday name a non-programmer understands ("门卫规则", "Gatekeeper"). */
  name: string
  responsibility: string
  /** One plain sentence for someone who has never seen code. */
  plain?: string
  /** The area it belongs to, drawn as one row of the map ("规则区"). */
  group?: string
  paths: string[]
  evidence?: Evidence[]
}

export type Relation = {
  from: string
  to: string
  label?: string
}

export type ArchMap = {
  version: 1
  project: string
  revision: number
  commit?: string
  isDirty?: boolean
  updatedAt: string
  modules: ArchModule[]
  relations: Relation[]
}

export type MapDelta = {
  from: number
  to: number
  addedModules: string[]
  removedModules: string[]
  changedModules: string[]
  addedRelations: string[]
  removedRelations: string[]
}

export type Staleness = {
  commit: string
  head: string
  changedFiles: number
  modules: string[]
}

export type PlanStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type TouchedFile = {
  path: string
  modules: string[]
  isInScope: boolean
  isBlocked: boolean
  /** Changed by a shell command rather than by an edit tool. */
  isShell?: boolean
}

/** A snapshot of the whole worktree, kept as a git commit under refs/archgate/. */
export type RestorePoint = {
  commit: string
  ref: string
}

export type CheckRun = {
  command: string
  isOk: boolean
  at: string
}

export type Plan = {
  id: number
  summary: string
  modules: string[]
  files: string[]
  checks: string[]
  impact: string[]
  status: PlanStatus
  createdAt: string
  decidedAt?: string
  rejectReason?: string
  note?: string
  touched: TouchedFile[]
  checkRuns: CheckRun[]
  /** Taken when the person approves; /archgate undo restores the plan's files from it. */
  restorePoint?: RestorePoint
  /** When /archgate undo put the plan's files back. */
  undoneAt?: string
}

declare module 'claude-code' {
  interface PluginState {
    archgate: {
      map: ArchMap | null
      delta: MapDelta | null
      stale: Staleness | null
      plan: Plan | null
      planSeq: number
      isPaused: boolean
    }
  }
}
