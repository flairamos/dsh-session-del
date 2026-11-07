/**
 * Host half of the session-cleanup bundle.
 *
 * DSH has no delete verb for a Session, so this plugin removes one the only way
 * that keeps every durable invariant: it detaches the Session from its Workspace,
 * drops its archive bookkeeping through `workspaceRegistry`, and moves the
 * Session log directory plus its projection cache into a restorable trash.
 *
 * The browser half reaches these operations over one same-origin JSON route
 * registered on `ctx.webServer`, so the route lives exactly as long as this
 * plugin row. Nothing here touches project source files.
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Same-origin JSON endpoint the Client half calls. */
const ROUTE_PATH = '/dsh-session-cleanup/rpc'
/** Subdirectory of `<home>/trash` this plugin owns. */
const TRASH_KEY = 'session-cleanup'
/** Scratch directories the Harness creates under the OS temp directory. */
const TEMP_PREFIX = /^dsh-(?:spill|workspace-changes|subprocess)-/
/** Scratch data younger than this stays untouched: a live process may hold it. */
const TEMP_AGE_MS = 6 * 60 * 60 * 1000
/** Largest accepted request body. */
const MAX_BODY_BYTES = 1 << 20
/** Upper bound on descendant traversal, so a corrupt lineage cannot spin. */
const MAX_DESCENDANTS = 2000

const SESSION_ID = /^session-[0-9a-z-]+$/i
const BATCH_ID = /^[0-9A-Za-z-]+$/

export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry']

/**
 * Register the JSON route for the lifetime of this plugin row.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const runtime = createRuntime(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (req, res) => runtime.handle(req, res),
  }))
}

/**
 * Build the operation surface. All state lives in this closure, so a reload
 * starts from disk rather than from a stale cache.
 * @param ctx - plugin context carrying webServer, sessionPersistence and workspaceRegistry.
 */
function createRuntime(ctx) {
  let queue = Promise.resolve()

  /** Run one mutating operation at a time; reads may interleave. */
  function serialize(task) {
    const next = queue.then(() => task())
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  async function handle(req, res) {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      if (req.headers['x-dsh-cleanup'] !== '1') {
        sendJson(res, 403, { ok: false, error: 'This endpoint only accepts the Harness web page.' })
        return
      }
      const body = await readJsonBody(req)
      const action = typeof body?.action === 'string' ? body.action : ''
      const payload = body?.payload ?? {}
      sendJson(res, 200, { ok: true, value: await dispatch(action, payload) })
    } catch (error) {
      try {
        sendJson(res, 200, { ok: false, error: messageOf(error) })
      } catch {
        res.destroy()
      }
    }
  }

  async function dispatch(action, payload) {
    switch (action) {
      case 'state':
        return state()
      case 'deleteSessions':
        return serialize(() => deleteSessions(payload))
      case 'restore':
        return serialize(() => restore(payload))
      case 'emptyTrash':
        return serialize(() => emptyTrash())
      case 'purgeTemp':
        return serialize(() => purgeTemp(payload))
      default:
        throw new Error(`Unknown action ${JSON.stringify(action)}`)
    }
  }

  /** @returns every root this plugin reads plus the full cleanup inventory. */
  async function state() {
    const roots = await resolveRoots(ctx)
    const [archived, trash, temp] = await Promise.all([
      listArchived(ctx, roots),
      listTrash(roots.trashRoot),
      scanTemp(),
    ])
    return {
      roots: { home: roots.home, sessions: roots.sessionsRoot, trash: roots.trashRoot, temp: tmpdir() },
      archived,
      trash,
      temp,
      tempAgeHours: Math.round(TEMP_AGE_MS / 3_600_000),
    }
  }

  /**
   * Move archived Sessions, together with their subagent descendants, into the trash.
   * @param payload - `{ ids, requireArchived }`.
   */
  async function deleteSessions(payload) {
    const requested = Array.isArray(payload?.ids) ? payload.ids.filter(isSessionId) : []
    const requireArchived = payload?.requireArchived !== false
    if (requested.length === 0) throw new Error('Select at least one Session to delete.')

    const roots = await resolveRoots(ctx)
    const store = await readWorkspaceStore(roots.home)
    const snapshots = await listSnapshots(ctx)
    const children = new Map()
    for (const snapshot of snapshots) {
      const parent = snapshot?.header?.parentSession
      if (typeof parent !== 'string') continue
      const list = children.get(parent) ?? []
      list.push(snapshot.header.id)
      children.set(parent, list)
    }

    const targets = []
    const skipped = []
    for (const id of requested) {
      if (requireArchived && !store.archived.includes(id)) {
        skipped.push({ id, reason: 'This Session is not archived, so it stays.' })
        continue
      }
      if (!targets.includes(id)) targets.push(id)
      const pending = [id]
      let visited = 0
      while (pending.length > 0 && visited < MAX_DESCENDANTS) {
        visited += 1
        const parent = pending.pop()
        for (const child of children.get(parent) ?? []) {
          if (targets.includes(child)) continue
          targets.push(child)
          pending.push(child)
        }
      }
    }
    if (targets.length === 0) return { deleted: [], skipped }

    const live = await liveSessionIds(ctx)
    const removable = []
    for (const id of targets) {
      if (live.has(id)) {
        skipped.push({ id, reason: 'This Session is live in this process; stop it first.' })
        continue
      }
      removable.push(id)
    }

    const batchId = timestampId()
    const batchDir = join(roots.trashRoot, batchId)
    const manifest = { version: 1, kind: 'sessions', batchId, createdAt: new Date().toISOString(), entries: [] }
    const deleted = []

    for (const id of removable) {
      const workspaceId = store.owner.get(id)
      const siblings = workspaceId === undefined ? undefined : store.order.get(workspaceId)
      const at = siblings === undefined ? -1 : siblings.indexOf(id)
      const entry = {
        sessionId: id,
        workspaceId,
        siblingId: at >= 0 && at + 1 < siblings.length ? siblings[at + 1] : undefined,
        wasArchived: store.archived.includes(id),
        sessionDir: undefined,
        sessionTrash: undefined,
        cachePath: undefined,
        cacheTrash: undefined,
        bytes: 0,
      }
      await detachEverywhere(ctx, id)
      await unarchive(ctx, id)

      const sessionDir = await findSessionDir(ctx, roots, id)
      if (sessionDir !== undefined) {
        entry.bytes = (await measure(sessionDir)).bytes
        entry.sessionDir = sessionDir
        entry.sessionTrash = join(batchDir, 'sessions', id)
        await movePath(sessionDir, entry.sessionTrash)
      }
      const cachePath = join(roots.home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
      if (await pathInfo(cachePath) !== undefined) {
        entry.cachePath = cachePath
        entry.cacheTrash = join(batchDir, 'projcache', `${id}.json`)
        await movePath(cachePath, entry.cacheTrash)
      }
      manifest.entries.push(entry)
      deleted.push({
        id,
        bytes: entry.bytes,
        log: entry.sessionDir !== undefined,
        cache: entry.cachePath !== undefined,
      })
    }

    if (manifest.entries.length > 0) {
      await mkdir(batchDir, { recursive: true })
      await writeFile(join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    }
    return {
      batchId: manifest.entries.length > 0 ? batchId : undefined,
      deleted,
      skipped,
    }
  }

  /** Put a trash batch back where it came from. */
  async function restore(payload) {
    const batchId = typeof payload?.batchId === 'string' ? payload.batchId : ''
    if (!BATCH_ID.test(batchId)) throw new Error('That trash batch id is not valid.')
    const roots = await resolveRoots(ctx)
    const batchDir = join(roots.trashRoot, batchId)
    const manifest = JSON.parse(await readFile(join(batchDir, 'manifest.json'), 'utf8'))
    const restored = []
    const failed = []

    for (const entry of manifest.entries ?? []) {
      try {
        if (typeof entry.sessionDir === 'string' && typeof entry.sessionTrash === 'string'
          && inside(roots.sessionsRoot, entry.sessionDir)
          && await pathInfo(entry.sessionTrash) !== undefined) {
          await movePath(entry.sessionTrash, entry.sessionDir)
        }
        if (typeof entry.cachePath === 'string' && typeof entry.cacheTrash === 'string'
          && await pathInfo(entry.cacheTrash) !== undefined) {
          await movePath(entry.cacheTrash, entry.cachePath)
        }
        await reattach(ctx, entry.workspaceId, entry.sessionId)
        if (typeof entry.workspaceId === 'string' && typeof entry.siblingId === 'string') {
          try {
            await ctx.workspaceRegistry.get(entry.workspaceId)?.insertSessionBefore(entry.sessionId, entry.siblingId)
          } catch {
            // A missing sibling only costs the original position, not the log.
          }
        }
        if (entry.wasArchived === true) await rearchive(ctx, entry.sessionId)
        restored.push(entry.sessionId)
      } catch (error) {
        failed.push({ id: entry.sessionId, reason: messageOf(error) })
      }
    }
    for (const entry of manifest.temp ?? []) {
      try {
        if (typeof entry.from === 'string' && typeof entry.to === 'string'
          && inside(tmpdir(), entry.from)
          && await pathInfo(entry.to) !== undefined) {
          await movePath(entry.to, entry.from)
          restored.push(entry.name)
        }
      } catch (error) {
        failed.push({ id: entry.name, reason: messageOf(error) })
      }
    }
    await rm(batchDir, { recursive: true, force: true })
    return { batchId, restored, failed }
  }

  /** Delete every trash batch permanently. */
  async function emptyTrash() {
    const roots = await resolveRoots(ctx)
    const batches = await listTrash(roots.trashRoot)
    let bytes = 0
    for (const batch of batches) bytes += batch.bytes
    await rm(roots.trashRoot, { recursive: true, force: true })
    return { batches: batches.length, bytes }
  }

  /** Move the selected stale scratch directories into a trash batch. */
  async function purgeTemp(payload) {
    const wanted = Array.isArray(payload?.names) ? payload.names : []
    const roots = await resolveRoots(ctx)
    const available = await scanTemp()
    const selected = available.filter(item => wanted.includes(item.name))
    if (selected.length === 0) return { batchId: undefined, moved: [] }

    const batchId = timestampId()
    const batchDir = join(roots.trashRoot, batchId)
    const manifest = { version: 1, kind: 'temp', batchId, createdAt: new Date().toISOString(), entries: [], temp: [] }
    const moved = []
    for (const item of selected) {
      const target = join(batchDir, 'temp', item.name)
      await movePath(item.path, target)
      manifest.temp.push({ name: item.name, from: item.path, to: target, bytes: item.bytes })
      moved.push({ name: item.name, bytes: item.bytes })
    }
    await mkdir(batchDir, { recursive: true })
    await writeFile(join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return { batchId, moved }
  }

  return { handle }
}

/**
 * Ids of the Sessions this process is actively driving. A resident but idle
 * agent is not activity: the Desktop keeps agents warm after their tab closes.
 * @param ctx - plugin context.
 * @returns the ids of Sessions with running work.
 */
async function liveSessionIds(ctx) {
  const ids = new Set()
  try {
    const agents = ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) {
      const id = agent?.id ?? agent?.session?.id
      if (typeof id !== 'string') continue
      let status = 'idle'
      try {
        status = agent.status
      } catch {
        status = 'idle'
      }
      if (status === 'running') ids.add(id)
    }
  } catch {
    // Without an agent registry no Session is known to be running here.
  }
  return ids
}

/** Detach the Session from every Workspace that still reports it. */async function detachEverywhere(ctx, id) {
  let workspaces = []
  try {
    workspaces = ctx.workspaceRegistry.list()
  } catch {
    return
  }
  for (const workspace of workspaces) {
    let owns = false
    try {
      owns = workspace.sessionIds.includes(id)
    } catch {
      owns = false
    }
    if (!owns) continue
    try {
      await workspace.detachSession(id)
    } catch {
      // A Workspace that refuses the detach keeps its row; the log still moves.
    }
  }
}

async function unarchive(ctx, id) {
  try {
    await ctx.workspaceRegistry.unarchiveSession(id)
  } catch {
    // Already absent from the archive set is the outcome this wants anyway.
  }
}

async function reattach(ctx, workspaceId, id) {
  if (typeof workspaceId !== 'string') return
  try {
    const workspace = ctx.workspaceRegistry.get(workspaceId)
    await workspace?.attachSession(id)
  } catch {
    // The Workspace may be gone; the restored log is what matters.
  }
}

async function rearchive(ctx, id) {
  try {
    await ctx.workspaceRegistry.archiveSession(id)
  } catch {
    // Keeping a restored log visible beats failing the whole restore.
  }
}

async function listSnapshots(ctx) {
  try {
    return await ctx.sessionPersistence.list()
  } catch {
    return []
  }
}

/**
 * Resolve `<home>` and its well-known child directories.
 * @param ctx - plugin context.
 */
async function resolveRoots(ctx) {
  const home = await resolveHome(ctx)
  return {
    home,
    sessionsRoot: join(home, 'sessions'),
    trashRoot: join(home, 'trash', TRASH_KEY),
  }
}

/**
 * Find the Harness home directory from durable evidence, then the environment.
 * @param ctx - plugin context.
 */
async function resolveHome(ctx) {
  for (const snapshot of await listSnapshots(ctx)) {
    const path = snapshot?.location?.path
    if (typeof path === 'string' && path.length > 0) {
      return dirname(dirname(dirname(dirname(resolve(path)))))
    }
  }
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.length > 0) return resolve(profileDir, '..', '..')
  const explicit = process.env.DSH_HOME
  if (typeof explicit === 'string' && explicit.length > 0) return resolve(explicit)
  return join(homedir(), '.dsh')
}

/**
 * Read the archived Session ids and the Workspace owning each Session.
 * @param home - Harness home directory.
 */
async function readWorkspaceStore(home) {
  const result = { archived: [], owner: new Map(), order: new Map() }
  try {
    const parsed = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
    const archived = parsed?.global?.archivedSessionIds
    if (Array.isArray(archived)) {
      for (const id of archived) if (isSessionId(id)) result.archived.push(id)
    }
    const tables = parsed?.tables?.workspaces
    if (tables !== null && typeof tables === 'object') {
      for (const [workspaceId, record] of Object.entries(tables)) {
        const ids = record?.sessionIds
        if (!Array.isArray(ids)) continue
        const kept = ids.filter(id => typeof id === 'string')
        result.order.set(workspaceId, kept)
        for (const id of kept) result.owner.set(id, workspaceId)
      }
    }
  } catch {
    // Without the registry file there is nothing this plugin may delete safely.
  }
  return result
}

/**
 * Locate one Session's log directory, preferring the persistence location.
 * @param ctx - plugin context.
 * @param roots - resolved roots.
 * @param id - Session id.
 */
async function findSessionDir(ctx, roots, id) {
  for (const snapshot of await listSnapshots(ctx)) {
    if (snapshot?.header?.id !== id) continue
    const path = snapshot?.location?.path
    if (typeof path === 'string' && path.length > 0) {
      const candidate = dirname(resolve(path))
      if (basename(candidate) === id) return candidate
    }
  }
  try {
    const folders = await readdir(roots.sessionsRoot, { withFileTypes: true })
    for (const folder of folders) {
      if (!folder.isDirectory()) continue
      const candidate = join(roots.sessionsRoot, folder.name, id)
      const info = await pathInfo(candidate)
      if (info?.isDirectory() === true) return candidate
    }
  } catch {
    // No sessions root means no Session log to remove.
  }
  return undefined
}

/** List archived Sessions with the size each one occupies. */
async function listArchived(ctx, roots) {
  const store = await readWorkspaceStore(roots.home)
  const entries = []
  for (const id of store.archived) {
    const sessionDir = await findSessionDir(ctx, roots, id)
    const cachePath = join(roots.home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
    const cacheInfo = await pathInfo(cachePath)
    const summary = cacheInfo === undefined ? undefined : await readCacheSummary(cachePath)
    const measured = sessionDir === undefined ? { bytes: 0 } : await measure(sessionDir)
    entries.push({
      id,
      title: summary?.title,
      cwd: summary?.cwd,
      createdAt: summary?.createdAt,
      sessionDir,
      cachePath: cacheInfo === undefined ? undefined : cachePath,
      bytes: measured.bytes + (cacheInfo?.size ?? 0),
      workspaceId: store.owner.get(id),
    })
  }
  entries.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
  return entries
}

/** @returns the title, cwd and creation time a projection cache records. */
async function readCacheSummary(cachePath) {
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8'))
    const identity = parsed?.record?.identity ?? {}
    const title = parsed?.record?.rows?.title?.val
    return {
      title: typeof title === 'string' && title.length > 0 ? title : undefined,
      cwd: typeof identity.cwd === 'string' ? identity.cwd : undefined,
      createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : undefined,
    }
  } catch {
    return { title: undefined, cwd: undefined, createdAt: undefined }
  }
}

/** List trash batches with their contents and sizes. */
async function listTrash(trashRoot) {
  let folders = []
  try {
    folders = await readdir(trashRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const batches = []
  for (const folder of folders) {
    if (!folder.isDirectory()) continue
    const dir = join(trashRoot, folder.name)
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    } catch {
      continue
    }
    batches.push({
      batchId: folder.name,
      kind: manifest?.kind === 'temp' ? 'temp' : 'sessions',
      createdAt: typeof manifest?.createdAt === 'string' ? manifest.createdAt : undefined,
      sessions: Array.isArray(manifest?.entries)
        ? manifest.entries.map(entry => ({ id: entry.sessionId, bytes: entry.bytes ?? 0, cwd: entry.sessionDir }))
        : [],
      temp: Array.isArray(manifest?.temp)
        ? manifest.temp.map(entry => ({ name: entry.name, bytes: entry.bytes ?? 0 }))
        : [],
      bytes: (await measure(dir)).bytes,
    })
  }
  batches.sort((left, right) => String(right.batchId).localeCompare(String(left.batchId)))
  return batches
}

/** List stale Harness scratch directories under the OS temp directory. */
async function scanTemp() {
  const root = tmpdir()
  const now = Date.now()
  let folders = []
  try {
    folders = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const entries = []
  for (const folder of folders) {
    if (!folder.isDirectory() || !TEMP_PREFIX.test(folder.name)) continue
    const path = join(root, folder.name)
    const info = await pathInfo(path)
    if (info === undefined || now - info.mtimeMs < TEMP_AGE_MS) continue
    const measured = await measure(path)
    entries.push({ name: folder.name, path, bytes: measured.bytes, files: measured.files, mtime: info.mtimeMs })
  }
  entries.sort((left, right) => right.bytes - left.bytes)
  return entries
}

/** Sum the bytes and file count below one directory. */
async function measure(root) {
  let bytes = 0
  let files = 0
  const pending = [root]
  let guard = 0
  while (pending.length > 0 && guard < 20000) {
    guard += 1
    const current = pending.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) {
        files += 1
        bytes += (await pathInfo(path))?.size ?? 0
      }
    }
  }
  return { bytes, files }
}

/** `stat` without throwing. */
async function pathInfo(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/** Move a file or directory, falling back to copy-and-remove across volumes. */
async function movePath(from, to) {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  await cp(from, to, { recursive: true, force: true })
  await rm(from, { recursive: true, force: true })
}

/** Read and parse a bounded JSON request body. */
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('The request body is too large.')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  return JSON.parse(text)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value)
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Whether `child` stays inside `parent`. */
function inside(parent, child) {
  const root = resolve(parent)
  const target = resolve(child)
  return target === root || target.startsWith(root + sep)
}
