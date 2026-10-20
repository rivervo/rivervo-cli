#!/usr/bin/env node
/*
 * rivervo — the command line for Rivervo Applications.
 * One file, no dependencies (Node 22+): it talks to the public API (/api/v1) with a
 * personal API token from Account settings → API tokens.
 *
 *   rivervo login | logout | apps | services [ls] | services info | services set-public | services add | link | unlink
 *           | deploy | logs | env ls|set|rm [--shared] | usage | rollback | open | shell
 *           | storage ls | storage import [status|pause|resume|abort|stop-gradual]
 *
 * Importable for tests: main(argv, io) runs one command and resolves its exit code.
 */
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export const VERSION = '1.5.0'
const DEFAULT_API = 'https://api.rivervo.com/api/v1'

const HELP = `rivervo ${VERSION} — Rivervo Applications from the command line

Usage
  rivervo login [--token <token>] [--api <url>]   save a personal API token
  rivervo logout                                  forget the saved token
  rivervo apps                                    your applications and their services (also: rivervo services)
  rivervo services info [app]                     a service: status, public and internal address, repository, resources
  rivervo services set-public [app] on|off [-y]   a web service's public address on, or off (internal only: reached
                                                  by the application's other services alone); asks first when turning
                                                  it off (-y: do not ask). Needs a full token and the Administrator role
  rivervo services add [application] [flags] [-y]
                                                  add a service to an application: asks what the flags leave out
                                                  (in a terminal), shows the price, adds it once you confirm.
                                                  Needs a full token and the Administrator role (see below)
  rivervo link [app]                              link this directory to a service (saved in .rivervo)
  rivervo unlink                                  remove this directory's link
  rivervo deploy [app] [--no-build] [--detach]    deploy: build the latest commit (or, with --no-build,
                                                  the running version again) and follow its progress
  rivervo logs [app] [-f] [-n <lines>] [--process web|cron|w1]
                                                  the app's output; -f keeps following it
  rivervo env ls [app] [--reveal]                 variables (values hidden unless --reveal)
  rivervo env set [app] KEY=value … [--target all|production|preview]
  rivervo env rm [app] KEY …
  rivervo env ls|set|rm --shared [application] …  the application's shared variables (every code service gets them)
  rivervo usage [application] [--month YYYY-MM]   what the application spent this month, the forecast, the next payment
  rivervo rollback [app] [deployment]             back to an earlier version (default: the previous one)
  rivervo open [app]                              open the app in the browser (an internal-only one has no address)
  rivervo shell [app] [--process web|i2|w1]       an interactive shell in the running service (tinker, psql…);
                                                  web is its first instance, i2… the others, w1… a worker
  rivervo storage ls [app]                        the application's object storage buckets
  rivervo storage import [app] <bucket> --mode copy|gradual --provider s3|gcs|s3-compatible
          --source-bucket <name> [--region <r>] [--endpoint <https://…>] [--prefix <folder/>] [--overwrite] [-y]
                                                  move files into a bucket from another storage: copy everything
                                                  now, or gradually (copied on first read). Asks for the old
                                                  storage's key (hidden) or reads it from the environment (below);
                                                  asks before starting (-y: do not ask). Full token, Administrator
  rivervo storage import status [app] <bucket> [--watch]
                                                  the copy's progress and gradual moving; --watch follows the copy
  rivervo storage import pause|resume|abort|stop-gradual [app] <bucket> [-y]

[app] is a service: application/service (shop/worker), a service's id, its address (slug) or name;
an application alone (shop) when it has one code service. Without it: --app, the RIVERVO_APP
variable, the directory's link (rivervo link), or your only application's only service.
[application] is an application's short name or name (or any of its services).

rivervo services add flags (in a terminal, what is left out is asked)
  --type web|worker|cron|postgres|mysql|redis|nats|rabbitmq|kafka   --name <name>   --public | --internal (web: one is required)
           nats, rabbitmq: message brokers (internal only); kafka: one Kafka broker from a template
  --source project|repo|image (web, worker; cron runs the application's code)
  project: --from <service> --command <command>     repo: --repo owner/name [--branch <branch>]
  image:   --image <ref> [--port <n>] [--command <command>] [--registry-user <u> --registry-password <p>]
  cron:    --schedule '<5 cron fields, UTC>'        --memory <MB> --cpus <n> --disk <GB>   --var KEY=value …
  Without a terminal, --yes adds it at the price shown; without --yes only the price is shown.

Options
  --account <id>   work in another account you are a team member of
  --json           print the API's JSON instead of text
  -y, --yes        do not ask for confirmation (services set-public … off, services add)
  -h, --help       this help        -v, --version

Environment
  RIVERVO_TOKEN    a token to use instead of the saved one (CI)
  RIVERVO_API_URL  the API (default ${DEFAULT_API})
  RIVERVO_LANG     language of messages from the API: en (default), az, ru
  RIVERVO_IMPORT_ACCESS_KEY_ID, RIVERVO_IMPORT_SECRET_ACCESS_KEY   storage import: the old storage's key (S3 and
                   S3-compatible) — a key that can only list and read that bucket; never pass it as a flag
  RIVERVO_IMPORT_GCS_KEY_FILE   storage import from Google Cloud Storage: path to the service account's JSON key
`

// ── arguments ────────────────────────────────────────────────────────────

const FLAGS_WITH_VALUE = new Set(['token', 'api', 'app', 'account', 'lines', 'n', 'process', 'target', 'month',
  'type', 'name', 'source', 'from', 'command', 'repo', 'branch', 'image', 'port', 'schedule', 'memory', 'cpus', 'disk', 'var',
  'registry-user', 'registry-password', 'mode', 'provider', 'source-bucket', 'region', 'endpoint', 'prefix', 'gcs-key-file',
  'access-key-id', 'secret-access-key'])
/** Flags that may be given more than once (a list). */
const FLAGS_REPEATED = new Set(['var'])

export function parseArgs (argv) {
  const pos = []
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { pos.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2)
      if (k.startsWith('no-')) opt[k.slice(3)] = false
      else if (FLAGS_REPEATED.has(k)) (opt[k] ??= []).push(v !== undefined ? v : argv[++i])
      else if (v !== undefined) opt[k] = v
      else if (FLAGS_WITH_VALUE.has(k)) opt[k] = argv[++i]
      else opt[k] = true
    } else if (a.length > 1 && a.startsWith('-') && !/^-\d/.test(a)) {
      const k = { f: 'follow', n: 'lines', h: 'help', v: 'version', y: 'yes' }[a.slice(1)] ?? a.slice(1)
      if (k === 'lines') opt[k] = argv[++i]
      else opt[k] = true
    } else pos.push(a)
  }
  return { pos, opt }
}

// ── config ───────────────────────────────────────────────────────────────

export function configDir (env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'rivervo')
}

async function loadConfig (env) {
  try {
    return JSON.parse(await readFile(join(configDir(env), 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function saveConfig (env, cfg) {
  const dir = configDir(env)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  await chmod(file, 0o600).catch(() => {})
  return file
}

// ── API ──────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor (status, body) {
    super(body?.message || `HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

function client ({ api, token, account, lang }) {
  const base = api.replace(/\/+$/, '')
  return async function call (method, path, { body, query } = {}) {
    const url = new URL(base + path)
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}`, Locale: lang, 'User-Agent': `rivervo-cli/${VERSION}` }
    if (account) headers['X-Account'] = String(account)
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let res
    try {
      res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
    } catch (e) {
      throw new ApiError(0, { message: `Cannot reach ${base} (${e.cause?.code ?? e.message})` })
    }
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { message: text.slice(0, 200) } }
    if (!res.ok) throw new ApiError(res.status, data)
    return data
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function table (rows) {
  if (!rows.length) return ''
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i] ?? '').length)))
  return rows.map(r => r.map((c, i) => i === r.length - 1 ? String(c ?? '') : String(c ?? '').padEnd(widths[i])).join('  ').trimEnd()).join('\n') + '\n'
}

const DATA_TYPES = ['postgres', 'mysql', 'redis', 'nats', 'rabbitmq']
const isCode = s => !DATA_TYPES.includes(s.type ?? 'web')
const lc = v => String(v ?? '').toLowerCase()

/**
 * Every service from GET /apps with the application it is in. The API from 1.2 lists services flat, each with
 * `project: {id, slug, name}`; an older one lists main apps with their `services` — then the main app stands for
 * its application (project.id null).
 */
export function flatten (apps) {
  const out = new Map()
  for (const a of apps) if (!out.has(a.id)) out.set(a.id, { ...a, project: a.project ?? { id: null, slug: a.slug, name: a.name } })
  for (const a of apps) {
    for (const s of a.services ?? []) if (!out.has(s.id)) out.set(s.id, { ...s, service_of: a.id, project: out.get(a.id).project })
  }
  return [...out.values()]
}

/** application/service, for messages (an older API: the service's own name). */
export function label (s) {
  return s.project?.id && s.project.slug ? `${s.project.slug}/${s.name}` : s.name
}

function groups (services) {
  const by = new Map()
  for (const s of services) {
    const key = s.project?.id ?? `root-${s.service_of ?? s.id}`
    if (!by.has(key)) by.set(key, { project: s.project, services: [] })
    by.get(key).services.push(s)
  }
  return [...by.values()]
}

function applicationsMatching (services, needle) {
  return groups(services).filter(g => g.project && (lc(g.project.slug) === needle || lc(g.project.name) === needle || (g.project.id && String(g.project.id) === needle)))
}

function choices (list) {
  return list.map(s => `  ${label(s).padEnd(24)} ${String(s.id).padEnd(6)} ${s.type ?? 'web'}`).join('\n')
}

/** The service a directory is linked to: .rivervo here or in a parent directory. */
export async function findLink (cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    try {
      const raw = JSON.parse(await readFile(join(dir, '.rivervo'), 'utf8'))
      // {project, service} (1.2); an older or hand-written file: {app} / {id} / a bare id — a service.
      const service = raw?.service ?? raw?.app ?? raw?.id ?? (typeof raw === 'number' || typeof raw === 'string' ? raw : null)
      return { file: join(dir, '.rivervo'), project: raw?.project ?? null, service: typeof service === 'object' && service ? service.id ?? null : service }
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new ApiError(400, { message: `Cannot read ${join(dir, '.rivervo')}: ${e.message}. Run rivervo link again.` })
    }
    if (dirname(dir) === dir) return null
  }
}

/**
 * A service from `application/service`, a service's id, address (slug or host) or name, or an application
 * alone (its only code service). Without a reference: the directory's link, else the only service there is.
 */
export async function resolveApp (call, ref, ctx = {}) {
  const { data: apps } = await call('GET', '/apps')
  const all = flatten(apps)
  if (ref === undefined || ref === null || ref === '') {
    const link = ctx.cwd ? await findLink(ctx.cwd) : null
    if (link) {
      if (link.service) {
        const hit = all.find(s => String(s.id) === String(link.service))
        if (hit) return hit
        throw new ApiError(404, { message: `This directory is linked to service ${link.service}, which is not in this account (any more). Run rivervo link again. (${link.file})` })
      }
      if (link.project) return pickFrom(all.filter(s => String(s.project?.id) === String(link.project)), `the linked application (${link.file})`)
    }
    if (!all.length) throw new ApiError(404, { message: 'You have no apps yet. Create one in the panel.' })
    const code = all.filter(isCode)
    if (all.length === 1) return all[0]
    if (groups(all).length === 1 && code.length === 1) return code[0]
    throw new ApiError(400, { message: `Which app? Give it as application/service or its id (or run rivervo link):\n${choices(code.length ? code : all)}` })
  }
  const needle = lc(String(ref).trim()).replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (/^\d+$/.test(needle)) {
    const hit = all.find(s => String(s.id) === needle)
    if (hit) return hit
    throw new ApiError(404, { message: `No app “${ref}”. Run rivervo apps to see yours.` })
  }
  if (needle.includes('/')) {
    const [appPart, svcPart] = [needle.slice(0, needle.indexOf('/')), needle.slice(needle.indexOf('/') + 1)]
    const apps_ = applicationsMatching(all, appPart)
    if (apps_.length > 1) throw new ApiError(400, { message: `“${appPart}” matches ${apps_.length} applications; use the service's id:\n${choices(apps_.flatMap(g => g.services))}` })
    // An older API: «Shop/worker» was the main app's name and a service's.
    if (!apps_.length) throw new ApiError(404, { message: `No application “${appPart}”. Run rivervo apps to see yours.` })
    const inApp = apps_[0].services
    const hit = inApp.filter(s => lc(s.name) === svcPart || lc(s.slug) === svcPart || String(s.id) === svcPart)
    if (hit.length === 1) return hit[0]
    throw new ApiError(404, { message: `${apps_[0].project.name} has no service “${svcPart}”. Its services:\n${choices(inApp)}` })
  }
  const slug = needle.replace(/\.rivervo\.app$/, '')
  // An address first: «shop» keeps meaning the service at shop.rivervo.app.
  const byAddress = all.find(s => lc(s.slug) === slug || (s.url && lc(new URL(s.url).host) === needle))
  if (byAddress) return byAddress
  // An application alone: its only code service.
  const apps_ = applicationsMatching(all, needle)
  if (apps_.length === 1) return pickFrom(apps_[0].services, apps_[0].project.name)
  const byName = all.filter(s => lc(s.name) === needle)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1 || apps_.length > 1) {
    throw new ApiError(400, { message: `“${ref}” matches more than one; use application/service or the id:\n${choices(byName.length ? byName : apps_.flatMap(g => g.services))}` })
  }
  throw new ApiError(404, { message: `No app “${ref}”. Run rivervo apps to see yours.` })
}

function pickFrom (services, what) {
  const code = services.filter(isCode)
  if (code.length === 1) return code[0]
  if (!services.length) throw new ApiError(404, { message: `No services in ${what}.` })
  throw new ApiError(400, { message: `${what} has ${code.length ? 'several code services' : 'no code service'}; say which one:\n${choices(services)}` })
}

/** An application ({id, slug, name}) from its short name or name, a service of it, or the link / the only one. */
export async function resolveProject (call, ref, ctx = {}) {
  let project
  if (ref !== undefined && ref !== null && ref !== '' && !String(ref).includes('/')) {
    const { data: apps } = await call('GET', '/apps')
    const all = flatten(apps)
    const needle = lc(String(ref).trim())
    const hit = /^\d+$/.test(needle) ? all.find(s => String(s.id) === needle)?.project ?? applicationsMatching(all, needle)[0]?.project : null
    const named = hit ? [] : applicationsMatching(all, needle)
    if (named.length > 1) throw new ApiError(400, { message: `“${ref}” matches ${named.length} applications: ${named.map(g => g.project.slug).join(', ')}` })
    project = hit ?? named[0]?.project
  }
  if (!project && (ref === undefined || ref === null || ref === '')) {
    const link = ctx.cwd ? await findLink(ctx.cwd) : null
    if (link?.project) {
      const { data: apps } = await call('GET', '/apps')
      project = flatten(apps).find(s => String(s.project?.id) === String(link.project))?.project
      if (!project) throw new ApiError(404, { message: `This directory is linked to application ${link.project}, which is not in this account (any more). Run rivervo link again.` })
    } else if (!link) {
      const { data: apps } = await call('GET', '/apps')
      const g = groups(flatten(apps))
      if (g.length === 1) project = g[0].project
      else if (!g.length) throw new ApiError(404, { message: 'You have no apps yet. Create one in the panel.' })
      else throw new ApiError(400, { message: `Which application? ${g.map(x => x.project.slug).join(', ')}` })
    }
  }
  project ??= (await resolveApp(call, ref, ctx)).project
  if (!project?.id) throw new ApiError(400, { message: 'The API this CLI talks to does not know applications yet.' })
  return project
}

function openUrl (url, env) {
  if (env.RIVERVO_NO_BROWSER) return
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch {}
}

async function ask (io, question, { hidden = false } = {}) {
  if (io.prompt) return io.prompt(question)
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (hidden) rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(question) }
  try {
    return await new Promise(resolve => rl.question(question, resolve))
  } finally {
    rl.close()
    if (hidden) process.stdout.write('\n')
  }
}

const STEP = {
  fetch: 'Fetching the source code', scan: 'Security scan', detect: 'Analyzing the project', build: 'Building', start: 'Verifying',
  run: 'Starting the new version', place: 'Allocating resources', transfer: 'Preparing the release', pull: 'Downloading the image',
  database: 'Preparing the database', route: 'Switching traffic to the new version', dns: 'Configuring the address', check: 'Health check',
  backup: 'Saving the data', restore: 'Restoring the data', cleanup: 'Finishing up',
}

/** Follow a deployment until it ends: steps as they change, the build log as it grows. */
async function follow (call, appId, dep, io, env, json) {
  const every = Number(env.RIVERVO_POLL_MS ?? 2000)
  const seen = new Map()
  let offset = 0
  for (;;) {
    const { data: d } = await call('GET', `/apps/${appId}/deployments/${dep.id}`, { query: { log_offset: offset } })
    if (!json) {
      for (const s of d.steps ?? []) {
        if (seen.get(s.key) === s.status || s.status === 'pending') continue
        seen.set(s.key, s.status)
        const mark = { running: '…', done: '✓', failed: '✗' }[s.status] ?? '·'
        io.out(`${mark} ${STEP[s.key] ?? s.key}\n`)
      }
      if (d.log) io.out(d.log.replace(/^/gm, '  │ ').replace(/  │ $/, ''))
    }
    offset = d.log_length ?? offset
    if (d.status === 'succeeded' || d.status === 'failed') {
      if (json) io.out(JSON.stringify(d, null, 2) + '\n')
      else if (d.status === 'succeeded') io.out(`\nDeployed. (deployment ${d.id})\n`)
      else io.err(`\nThe deployment did not finish${d.error ? `: ${d.error}` : '.'}\nThe panel can explain the error: open the app's Deploys tab.\n`)
      return d.status === 'succeeded' ? 0 : 1
    }
    await sleep(every)
  }
}

// ── commands ─────────────────────────────────────────────────────────────

async function cmdLogin (ctx) {
  const { opt, io, env, cfg } = ctx
  const api = (opt.api || env.RIVERVO_API_URL || cfg.api || DEFAULT_API).replace(/\/+$/, '')
  let token = opt.token
  if (!token) {
    io.out('Create a token in the panel: Account settings → API tokens.\n')
    token = (await ask(io, 'Paste your token: ', { hidden: true })).trim()
  }
  if (!token) { io.err('No token given.\n'); return 1 }
  const call = client({ api, token, account: opt.account, lang: ctx.lang })
  const { data } = await call('GET', '/apps')
  const file = await saveConfig(env, { ...cfg, api, token })
  const n = groups(flatten(data)).length
  io.out(`Logged in. ${n} application${n === 1 ? '' : 's'} visible. Saved to ${file}\n`)
  return 0
}

async function cmdLogout ({ env, io }) {
  await rm(join(configDir(env), 'config.json'), { force: true })
  io.out('Logged out. (The token itself stays valid until you revoke it in the panel.)\n')
  return 0
}

const showStatus = (status, health) => health === 'down' ? `${status} (down)` : status

/** The applications with their services (GET /apps/projects); an older API: its flat list of apps. */
async function cmdApps ({ call, io, opt }) {
  let res
  try {
    res = await call('GET', '/apps/projects')
  } catch (e) {
    if (e.status !== 404) throw e
    return cmdAppsOld({ call, io, opt })
  }
  if (opt.json) { io.out(JSON.stringify(res.data, null, 2) + '\n'); return 0 }
  if (!res.data.length) { io.out('No applications yet. Create one in the panel.\n'); return 0 }
  // The API from 1.3: a web service's public address or «internal only», and its address inside the application.
  const withInternal = res.data.some(p => (p.services ?? []).some(s => 'internal_url' in s || 'public' in s))
  const rows = [['APPLICATION / SERVICE', 'ID', 'TYPE', 'STATUS', ...(withInternal ? ['INTERNAL'] : []), 'URL']]
  const blank = withInternal ? ['', '', '', '', ''] : ['', '', '', '']
  for (const p of res.data) {
    rows.push([`${p.slug}  (${p.name}${p.status && p.status !== 'active' ? `, ${p.status}` : ''})`, ...blank])
    if (!p.services?.length) rows.push(['  no services yet', ...blank])
    for (const s of p.services ?? []) {
      const url = s.public === false ? 'internal only' : s.address ? `https://${s.address}` : (s.url ?? '')
      rows.push([`  ${p.slug}/${s.name}`, s.id, s.type ?? 'web', showStatus(s.status, s.health_status), ...(withInternal ? [s.internal_url ?? ''] : []), url])
    }
  }
  io.out(table(rows))
  return 0
}

async function cmdAppsOld ({ call, io, opt }) {
  const res = await call('GET', '/apps')
  if (opt.json) { io.out(JSON.stringify(res.data, null, 2) + '\n'); return 0 }
  if (!res.data.length) { io.out('No apps yet. Create one in the panel.\n'); return 0 }
  const rows = [['ID', 'NAME', 'STATUS', 'URL']]
  for (const a of res.data) {
    rows.push([a.id, a.name, showStatus(a.status, a.health), a.url ?? ''])
    for (const s of a.services ?? []) rows.push([s.id, `  └ ${s.name} (${s.type})`, showStatus(s.status, s.health), s.url ?? ''])
  }
  io.out(table(rows))
  return 0
}

/** rivervo services [ls] | info [app] | set-public [app] on|off. */
async function cmdServices (ctx) {
  const { pos, io } = ctx
  const sub = pos[0]
  if (sub === undefined || sub === 'ls' || sub === 'list') return cmdApps(ctx)
  if (sub === 'info' || sub === 'show') return cmdServiceInfo({ ...ctx, pos: pos.slice(1) })
  if (sub === 'set-public') return cmdSetPublic({ ...ctx, pos: pos.slice(1) })
  if (sub === 'add') return cmdServiceAdd({ ...ctx, pos: pos.slice(1) })
  io.err('Usage: rivervo services [ls] | services info [app] | services set-public [app] on|off [--yes] | services add [application] …\n')
  return 1
}

const memory = mb => mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`

/** One service (GET /apps/{id}): its application, status, addresses, repository and resources. */
async function cmdServiceInfo (ctx) {
  const { call, pos, io, opt } = ctx
  const app = await resolveApp(call, pos[0] ?? ctx.appRef, ctx)
  const { data: a } = await call('GET', `/apps/${app.id}`)
  if (opt.json) { io.out(JSON.stringify(a, null, 2) + '\n'); return 0 }
  const s = { ...a, project: a.project ?? app.project }
  const r = a.resources ?? {}
  const rows = [
    ['Application', s.project?.id ? `${s.project.name} (${s.project.slug})` : '—'],
    ['Type', a.type ?? 'web'],
    ['Status', a.status ?? '—'],
    ['Health', a.health ?? '—'],
  ]
  // A web service: its public address or «internal only»; where the application's other services reach it.
  if (a.public === false) rows.push(['Public address', 'internal only'])
  else if (a.url) rows.push(['Public address', a.url])
  if (a.internal_url) rows.push(['Internal address', a.internal_url])
  const domains = (a.domains ?? []).map(d => d.name).filter(Boolean)
  if (domains.length) rows.push(['Domains', domains.join(', ')])
  if (a.repo) rows.push(['Repository', a.repo])
  if (a.branch) rows.push(['Branch', a.branch])
  const res = [r.memory_mb ? memory(r.memory_mb) : null, r.cpus ? `${r.cpus} CPU` : null, r.disk_gb ? `${r.disk_gb} GB disk` : null].filter(Boolean)
  if (res.length) rows.push(['Resources', res.join(' · ')])
  io.out(`${label(s)} (service ${a.id})\n\n${table(rows)}`)
  return 0
}

const isTerminal = io => 'isTTY' in io ? io.isTTY : Boolean(process.stdin.isTTY && process.stdout.isTTY)

const PUBLIC_REFUSED = {
  domains: 'Remove the custom domains of this service first: an internal-only service has no domains.',
  previews: 'Turn off previews of this service first: an internal-only service has no previews.',
  busy: 'Wait for the running deploy to finish.',
  not_web: 'Only a web service has a public address.',
}

/**
 * A web service's public address on or off (PUT /apps/{id}/public). Off — internal only — asks first in a
 * terminal (Enter: no); without one it needs --yes. Nothing restarts.
 */
async function cmdSetPublic (ctx) {
  const { call, pos, io, opt } = ctx
  const usage = 'Usage: rivervo services set-public [app] on|off [--yes]\n'
  if (!pos.length || pos.length > 2) { io.err(usage); return 1 }
  const word = lc(pos.at(-1))
  const wanted = ['on', 'true', 'public'].includes(word) ? true : ['off', 'false', 'internal'].includes(word) ? false : null
  if (wanted === null) { io.err(`Not on or off: ${pos.at(-1)}\n${usage}`); return 1 }
  const app = await resolveApp(call, pos.length === 2 ? pos[0] : ctx.appRef, ctx)
  const name = label(app)
  if (!wanted && app.public !== false && !opt.yes) {
    const what = `its public address${app.url ? ` ${app.url}` : ''}; only the application's other services reach it${app.internal_url ? `, at ${app.internal_url}` : ''}`
    if (!isTerminal(io)) { io.err(`Making ${name} internal only removes ${what}.\nPass --yes to do it without a question.\n`); return 1 }
    const answer = (await ask(io, `Make ${name} internal only? It loses ${what}. [y/N] `)).trim()
    if (!/^y(es)?$/i.test(answer)) { io.err('Nothing changed.\n'); return 1 }
  }
  let res
  try {
    res = await call('PUT', `/apps/${app.id}/public`, { body: { public: wanted } })
  } catch (e) {
    if (e.status !== 422 || !e.body?.reason) throw e
    io.err(`${e.body.message || PUBLIC_REFUSED[e.body.reason] || e.message}\n`)
    return 1
  }
  if (opt.json) { io.out(JSON.stringify(res, null, 2) + '\n'); return 0 }
  const a = res.data ?? {}
  const internal = a.internal_url ?? app.internal_url
  const later = res.applied === false ? ' It is applied with its next deploy.' : ''
  // No full stop right after the address: it would be copied with it.
  if (wanted) io.out(`${name} now has a public address${a.url ? `: ${a.url}` : '.'}${later ? `\n${later.trim()}` : ''}\n`)
  else io.out(`${name} is now internal only.${internal ? ` Other services of the application reach it at ${internal}.` : ''}${later}\n`)
  return 0
}

// ── services add ─────────────────────────────────────────────────────────

const SERVICE_TYPES = ['web', 'worker', 'cron', 'postgres', 'mysql', 'redis', 'nats', 'rabbitmq', 'kafka']
// nats, rabbitmq: message brokers (1.4.0, internal only); kafka: a template — a worker running one Kafka broker.
const TYPE_LABEL = { web: 'web service', worker: 'background worker', cron: 'cron job', postgres: 'PostgreSQL', mysql: 'MySQL', redis: 'Valkey (Redis)', nats: 'NATS (JetStream)', rabbitmq: 'RabbitMQ', kafka: 'Kafka (one broker, template)' }
// What the application's other services get from it (shown after it is added).
const TYPE_VARS = { nats: 'NATS_URL', rabbitmq: 'AMQP_URL and RABBITMQ_*', kafka: 'KAFKA_BROKERS' }
const SOURCES = { project: "the application's code (as one of its services runs it)", repo: 'a GitHub repository', image: 'a Docker image' }
// [memory MB, CPUs, disk GB] by kind when the API's quote cannot be had (the API's service_defaults win).
const SERVICE_DEFAULTS = { app: [512, 1, 5], data: [1024, 1, 10], redis: [256, 1, 5], nats: [256, 1, 5], rabbitmq: [1024, 1, 10], kafka: [1024, 1, 10] }
const kindOf = type => ['redis', 'nats', 'rabbitmq', 'kafka'].includes(type) ? type : (type === 'postgres' || type === 'mysql') ? 'data' : 'app'

/** Thrown when a value is missing and there is no terminal to ask in. */
class Missing extends Error {}

/** What adding the service does to the application's bill, in one sentence (amounts without tax). */
export function priceLine (q, project) {
  const delta = money(q.monthly_delta_cents)
  const change = `This adds ${delta} a month to ${project.slug} (now ${money(q.monthly_cents_before)} → ${money(q.monthly_cents_after)})`
  const line = {
    paid: `${change}; charged now: ${money(q.charged_now_cents)} (prorated).`,
    trial: `${change}; not billed during the trial.`,
    internal: `${change}, but ${project.slug} is an internal application: nothing is charged.`,
    unpaid: q.trial
      ? `${project.slug} will cost ${money(q.monthly_cents_after)} a month; the first ${q.trial_days} days are free.`
      : `${project.slug} will cost ${money(q.monthly_cents_after)} a month; charged now: ${money(q.charged_now_cents)}.`,
  }[q.state] ?? `${q.summary ?? change}.`
  return `${line} Amounts in ${q.currency ?? 'USD'}, without tax.`
}

/**
 * Add a service to an existing application: its quote first (POST …/services/quote), shown and confirmed, then
 * the same body with the quote's token (POST …/services). In a terminal it asks for whatever the flags leave out;
 * without one every needed flag must be given, and --yes to add it.
 */
async function cmdServiceAdd (ctx) {
  const { call, pos, io, opt } = ctx
  if (pos.length > 1) { io.err('Usage: rivervo services add [application] [--type …] [--yes]\n'); return 1 }
  const tty = isTerminal(io)
  const project = await resolveProject(call, pos[0] ?? ctx.appRef, ctx)
  const { data: apps } = await call('GET', '/apps')
  const code = flatten(apps).filter(s => String(s.project?.id) === String(project.id) && ['web', 'worker', 'cron'].includes(s.type ?? 'web'))
  const quoteUrl = `/apps/projects/${project.id}/services/quote`

  /** A value from its flag, else asked (again until `check` takes it), else — no terminal — an error naming the flag. */
  const value = async (given, flag, question, check, { optional = false } = {}) => {
    if (given !== undefined && given !== true) {
      const v = check(String(given))
      if (v === undefined) throw new Missing(`Not a valid ${flag}: ${given}`)
      return v
    }
    if (!tty) {
      if (optional) return null
      throw new Missing(`Missing ${flag}. Without a terminal to ask in, give it on the command line.`)
    }
    for (;;) {
      const answer = (await ask(io, question)).trim()
      if (answer === '' && optional) return null
      const v = answer === '' ? undefined : check(answer)
      if (v !== undefined) return v
    }
  }
  const choose = (list) => a => list.includes(lc(a)) ? lc(a) : (/^\d+$/.test(a) && list[Number(a) - 1]) || undefined
  const number = (int) => a => (int ? /^\d+$/ : /^\d+(\.\d+)?$/).test(a) && Number(a) > 0 ? Number(a) : undefined
  const listed = (list) => list.map((x, i) => `  ${i + 1}) ${x}`).join('\n') + '\n'

  let body, type
  try {
    if (tty && !opt.type) io.out(`What kind of service?\n${listed(SERVICE_TYPES.map(t => `${t.padEnd(9)}${TYPE_LABEL[t]}`))}`)
    type = await value(opt.type, '--type (web, worker, cron, postgres, mysql, redis, nats, rabbitmq or kafka)', `Type [1-${SERVICE_TYPES.length}]: `, choose(SERVICE_TYPES))
    const name = await value(opt.name, '--name', 'Name (lowercase letters, digits and -, starting with a letter): ', a => /^[a-z][a-z0-9-]{0,29}$/.test(a) ? a : undefined)
    body = { type, name }
    if (type === 'web') {
      if (opt.public === true && opt.internal === true) throw new Missing('Give --public or --internal, not both.')
      const given = opt.public === true ? 'public' : opt.internal === true ? 'internal' : undefined
      body.public = (await value(given, '--public or --internal (a web service has a public address or is internal only)',
        'A public address, or internal only (reached by the application\'s other services alone)? [public/internal]: ',
        a => ({ p: 'public', public: 'public', i: 'internal', internal: 'internal' })[lc(a)])) === 'public'
    }
    const isData = kindOf(type) !== 'app'
    if (isData && (opt.source || opt.repo || opt.image || opt.command || opt.from)) throw new Missing(`A ${TYPE_LABEL[type]} service has no code: leave out --source, --from, --command, --repo and --image.`)
    if (!isData) {
      let source = 'project'
      if (type === 'cron') {
        if (opt.source && opt.source !== 'project') throw new Missing('A cron job runs the application\'s code: --source project (or leave it out).')
      } else {
        if (tty && !opt.source) io.out(`Where does its code come from?\n${listed(Object.entries(SOURCES).map(([k, v]) => `${k.padEnd(9)}${v}`))}`)
        source = await value(opt.source, '--source (project, repo or image)', 'Source [1-3]: ', choose(Object.keys(SOURCES)))
      }
      body.source = source
      if (source === 'project') {
        if (!code.length) throw new Missing(`${project.slug} has no code service to take the code from; use --source repo or image.`)
        // In the list: its number there; also its name or id.
        const byRef = a => (/^\d+$/.test(a) && code[Number(a) - 1]) || code.find(s => lc(s.name) === lc(a) || String(s.id) === a)
        if (opt.from !== undefined) {
          const hit = code.find(s => lc(s.name) === lc(opt.from) || String(s.id) === String(opt.from))
          if (!hit) throw new Missing(`${project.slug} has no code service “${opt.from}”. Its code services: ${code.map(s => s.name).join(', ')}`)
          body.image_from = hit.id
        } else if (code.length === 1) {
          // As in the panel (owner, 19.10.2026): the only code service is taken; with more, the customer chooses.
          body.image_from = code[0].id
        } else {
          if (tty) io.out(`Whose code does it run?\n${listed(code.map(s => `${s.name.padEnd(12)}${s.type ?? 'web'}`))}`)
          const pick = await value(undefined, `--from (${code.map(s => s.name).join(', ')})`, `Service [1-${code.length}]: `, a => byRef(a))
          body.image_from = pick.id
        }
        body.command = await value(opt.command, '--command', 'Command to run: ', a => a)
      } else if (source === 'repo') {
        body.repo = await value(opt.repo, '--repo (owner/name on GitHub)', 'Repository (owner/name on GitHub): ', a => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a) ? a : undefined)
        const branch = await value(opt.branch, '--branch', 'Branch (Enter: the default one): ', a => a, { optional: true })
        if (branch) body.branch = branch
      } else {
        body.image = await value(opt.image, '--image (e.g. nginx:1.27)', 'Image (e.g. nginx:1.27): ', a => a)
        if (type === 'web') {
          const port = await value(opt.port, '--port', 'Port it listens on [8080]: ', number(true), { optional: true })
          if (port) body.port = port
        }
        const command = await value(opt.command, '--command', 'Command (Enter: the image\'s own): ', a => a, { optional: true })
        if (command) body.command = command
        if (opt['registry-user'] || opt['registry-password']) {
          body.registry_username = opt['registry-user']
          body.registry_password = opt['registry-password']
        }
      }
      if (type === 'cron') body.schedule = await value(opt.schedule, '--schedule (5 cron fields, UTC)', 'Schedule (5 cron fields, UTC, e.g. */15 * * * *): ', a => /^(\S+\s+){4}\S+$/.test(a) ? a : undefined)
    }
    const vars = []
    for (const a of opt.var ?? []) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a)
      if (!m) throw new Missing(`Not KEY=value: ${a}`)
      vars.push({ key: m[1], value: m[2] })
    }
    if (vars.length) body.vars = vars
    // Resources: the flags; in a terminal the rest is asked with the kind's defaults (the API's, from a first quote).
    const flags = { memory_mb: [opt.memory, '--memory', number(true)], cpus: [opt.cpus, '--cpus', number(false)], disk_gb: [opt.disk, '--disk', number(true)] }
    for (const [k, [given, flag, check]] of Object.entries(flags)) if (given !== undefined) body[k] = await value(given, flag, '', check)
    if (tty && Object.keys(flags).some(k => body[k] === undefined)) {
      let defaults = SERVICE_DEFAULTS
      try {
        defaults = (await call('POST', quoteUrl, { body: { type, name } })).service_defaults ?? SERVICE_DEFAULTS
      } catch (e) {
        if (!(e.status === 0 || e.status >= 500)) throw e
      }
      const [mem, cpus, disk] = defaults[kindOf(type)] ?? SERVICE_DEFAULTS[kindOf(type)]
      const questions = { memory_mb: [`Memory, MB [${mem}]: `, mem], cpus: [`CPUs [${cpus}]: `, cpus], disk_gb: [`Disk, GB [${disk}]: `, disk] }
      for (const [k, [question, def]] of Object.entries(questions)) {
        if (body[k] === undefined) body[k] = (await value(undefined, flags[k][1], question, flags[k][2], { optional: true })) ?? def
      }
    }
  } catch (e) {
    if (!(e instanceof Missing)) throw e
    io.err(`${e.message}\n`)
    return 1
  }

  let res = await call('POST', quoteUrl, { body })
  // --yes answers the first price; a new one (the quote expired or the price changed) is asked about again.
  const confirm = async (round) => {
    if (opt.yes && (round === 0 || !tty)) return true
    if (!tty) return false
    return /^y(es)?$/i.test((await ask(io, 'Add the service? [y/N] ')).trim())
  }
  for (let round = 0; ; round++) {
    if (!opt.json) io.out(`${priceLine(res.quote ?? {}, project)}\n`)
    if (!(await confirm(round))) {
      if (!tty) {
        if (opt.json) io.out(JSON.stringify(res, null, 2) + '\n')
        io.err('Pass --yes to add it.\n')
      } else io.err('Nothing added.\n')
      return 1
    }
    try {
      const { data: s } = await call('POST', `/apps/projects/${project.id}/services`, { body: { ...body, quote_token: res.quote_token } })
      if (opt.json) { io.out(JSON.stringify(s, null, 2) + '\n'); return 0 }
      const svc = { ...s, project: s.project ?? project }
      const where = s.type !== 'web' ? '' : s.public === false
        ? `, internal only${s.internal_url ? ` (other services of the application reach it at ${s.internal_url})` : ''}`
        : `${s.url ? `, public at ${s.url}` : ''}${s.internal_url ? ` (inside the application: ${s.internal_url})` : ''}`
      const kind = s.template ?? (s.type === 'worker' && type === 'kafka' ? 'kafka' : s.type)
      io.out(`Added ${label(svc)} (service ${s.id}): ${TYPE_LABEL[kind] ?? s.type}${where}.\n`)
      if (TYPE_VARS[kind]) io.out(`Only the application's services reach it; they get ${TYPE_VARS[kind]} with their next deploy.\n`)
      io.out(kindOf(s.type) === 'app'
        ? `It is starting; follow it with: rivervo logs ${label(svc)} -f\n`
        : `It is starting; rivervo services info ${label(svc)} shows its status.\n`)
      return 0
    } catch (e) {
      // The price changed or the quote expired: the API sends a new one; show it and ask again (a terminal).
      if (e.status !== 422 || e.body?.reason !== 'quote_required' || round >= 2) throw e
      io.err(`${e.message}\n`)
      res = e.body
      if (!tty) {
        if (!opt.json) io.out(`${priceLine(res.quote ?? {}, project)}\n`)
        io.err('The price is new: run the command again to add it at this price.\n')
        return 1
      }
    }
  }
}

/** Link this directory to a service: .rivervo {project, service} (ids — renaming does not break it). */
async function cmdLink (ctx) {
  const { call, pos, io, opt } = ctx
  const s = await resolveApp(call, pos[0] ?? ctx.appRef, { ...ctx, cwd: null })
  const file = join(ctx.cwd, '.rivervo')
  const link = { project: s.project?.id ?? null, service: s.id }
  await writeFile(file, JSON.stringify(link, null, 2) + '\n')
  if (opt.json) io.out(JSON.stringify(link, null, 2) + '\n')
  else io.out(`Linked ${ctx.cwd} to ${label(s)} (service ${s.id}). Commands here use it when no app is given.\n`)
  return 0
}

async function cmdUnlink ({ io, cwd }) {
  const file = join(cwd, '.rivervo')
  try {
    await rm(file)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    const up = await findLink(cwd)
    io.err(up ? `This directory has no link of its own; it uses ${up.file}.\n` : 'This directory is not linked.\n')
    return 1
  }
  io.out(`Removed ${file}.\n`)
  return 0
}

const money = c => c === null || c === undefined ? '—' : `$${(c / 100).toFixed(2)}`

/** What the application spent this month, the forecast, the next payment, the limit (money roles only). */
async function cmdUsage (ctx) {
  const { call, pos, io, opt } = ctx
  const p = await resolveProject(call, pos[0] ?? ctx.appRef, ctx)
  const { data: u } = await call('GET', `/apps/projects/${p.id}/usage`, { query: { month: opt.month } })
  if (opt.json) { io.out(JSON.stringify(u, null, 2) + '\n'); return 0 }
  const b = u.billing ?? {}
  const rows = [
    ['Spent so far', money(u.spent_cents)],
    ['Forecast for the month', money(u.forecast_cents)],
    ['Next payment', b.next_payment_at ? `${money(b.next_payment_estimate_cents)} on ${b.next_payment_at.slice(0, 10)}` : (b.cancel_at ? `none — ends on ${b.cancel_at.slice(0, 10)}` : '—')],
  ]
  if (b.trial_ends_at && b.status === 'trialing') rows.push(['Trial ends', b.trial_ends_at.slice(0, 10)])
  if (u.limit) rows.push(['Spending limit', `${money(u.limit.limit_cents)} (${u.limit.pct}% of it forecast${u.limit.on_limit ? `, ${u.limit.on_limit.replace('_', ' ')}` : ''})`])
  io.out(`${p.name} (${p.slug}) — ${u.month}, ${u.currency ?? 'USD'} without tax\n\n${table(rows)}`)
  const lines = (u.lines ?? []).filter(l => l.spent_cents || l.forecast_cents || l.kind === 'service')
  if (lines.length) {
    io.out('\n' + table([['', 'SPENT', 'FORECAST'], ...lines.map(l => [
      l.kind === 'service' ? `${l.name}${l.resources_label ? ` (${l.resources_label})` : ''}${l.deleted ? ' — deleted' : ''}` : l.kind,
      money(l.spent_cents), money(l.forecast_cents),
    ])]))
  }
  return 0
}

async function cmdDeploy (ctx) {
  const { call, opt, pos, io, env } = ctx
  const app = await resolveApp(call, pos[0] ?? ctx.appRef, ctx)
  const { data: dep } = await call('POST', `/apps/${app.id}/deployments`, { body: { rebuild: opt.build !== false } })
  if (!opt.json) io.out(`${opt.build === false ? 'Deploying the running version of' : 'Building and deploying'} ${label(app)} (deployment ${dep.id})\n`)
  if (opt.detach) { if (opt.json) io.out(JSON.stringify(dep, null, 2) + '\n'); return 0 }
  return follow(call, app.id, dep, io, env, opt.json)
}

async function cmdRollback (ctx) {
  const { call, pos, io, env, opt } = ctx
  const app = await resolveApp(call, pos[0] ?? ctx.appRef, ctx)
  let to = pos[1]
  if (!to) {
    const { data: list } = await call('GET', `/apps/${app.id}/deployments`, { query: { limit: 50 } })
    const prev = list.find(d => d.can_rollback)
    if (!prev) { io.err('There is no earlier version to go back to.\n'); return 1 }
    to = prev.id
  }
  const { data: dep } = await call('POST', `/apps/${app.id}/deployments/${to}/rollback`)
  if (!opt.json) io.out(`Rolling ${label(app)} back to deployment ${to}\n`)
  if (opt.detach) return 0
  return follow(call, app.id, dep, io, env, opt.json)
}

async function cmdLogs (ctx) {
  const { call, opt, pos, io, env } = ctx
  const app = await resolveApp(call, pos[0] ?? ctx.appRef, ctx)
  const lines = Number(opt.lines ?? 200)
  const process_ = opt.process ?? 'web'
  let res = await call('GET', `/apps/${app.id}/logs`, { query: { lines, process: process_ } })
  if (!res.data.running && !opt.follow) io.err('The app is not running.\n')
  for (const l of res.data.lines) io.out(l + '\n')
  if (!opt.follow) return 0
  const every = Number(env.RIVERVO_POLL_MS ?? 2000)
  const until = env.RIVERVO_FOLLOW_ROUNDS ? Number(env.RIVERVO_FOLLOW_ROUNDS) : Infinity
  // Follow from the last line we printed: web and workers stamp each line with its time (the server
  // sends only later ones); the schedule's log has no times, so new lines are found after the last ones shown.
  const stamp = l => /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s/.exec(l)?.[1]
  const stamped = process_ !== 'cron'
  let since = stamp(res.data.lines.at(-1) ?? '') ?? res.at
  let shown = res.data.lines
  for (let round = 0; round < until; round++) {
    await sleep(every)
    try {
      res = await call('GET', `/apps/${app.id}/logs`, { query: { lines: 500, process: process_, since: stamped ? since : undefined } })
    } catch (e) {
      if (e.status === 429) continue
      throw e
    }
    const fresh = stamped ? res.data.lines : afterOverlap(shown, res.data.lines)
    for (const l of fresh) io.out(l + '\n')
    if (stamped) since = stamp(fresh.at(-1) ?? '') ?? since
    else shown = res.data.lines
  }
  return 0
}

/** The lines of `next` after the last lines of `prev` (a log without times, read again from its end). */
export function afterOverlap (prev, next) {
  const anchor = prev.slice(-3)
  if (!anchor.length) return next
  for (let i = next.length - anchor.length; i >= 0; i--) {
    if (anchor.every((l, k) => next[i + k] === l)) return next.slice(i + anchor.length)
  }
  return next
}

async function cmdEnv (ctx) {
  const { opt } = ctx
  return opt.shared ? cmdEnvShared(ctx) : cmdEnvOwn(ctx)
}

/** The application's shared variables (every code service gets them; a service's own of the same name wins). */
async function cmdEnvShared (ctx) {
  const { call, opt, pos, io } = ctx
  const sub = pos[0]
  const rest = pos.slice(1)
  if (sub === 'ls' || sub === 'list' || sub === undefined) {
    const p = await resolveProject(call, rest[0] ?? ctx.appRef, ctx)
    const { data } = await call('GET', `/apps/projects/${p.id}/env`)
    if (opt.json) { io.out(JSON.stringify(data, null, 2) + '\n'); return 0 }
    if (!data.length) { io.out(`No shared variables in ${p.slug}.\n`); return 0 }
    io.out(table([['KEY', 'VALUE', 'TARGET'], ...data.map(v => [v.key, opt.reveal ? v.value : '••••••', v.target ?? 'all'])]))
    return 0
  }
  if (sub === 'set') {
    const appRef = rest.length && !rest[0].includes('=') ? rest.shift() : undefined
    const set = {}
    for (const a of rest) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a)
      if (!m) { io.err(`Not KEY=value: ${a}\n`); return 1 }
      set[m[1]] = m[2]
    }
    if (!Object.keys(set).length) { io.err('Usage: rivervo env set --shared [application] KEY=value …\n'); return 1 }
    const p = await resolveProject(call, appRef ?? ctx.appRef, ctx)
    await call('PATCH', `/apps/projects/${p.id}/env`, { body: { set, ...(opt.target ? { target: opt.target } : {}) } })
    io.out(`Saved ${Object.keys(set).join(', ')} in the shared variables of ${p.slug}. Each service gets them with its next deploy: rivervo deploy ${p.slug}/<service> --no-build\n`)
    return 0
  }
  if (sub === 'rm' || sub === 'unset') {
    let appRef
    if (rest.length > 1 && !/^[A-Z_][A-Z0-9_]*$/.test(rest[0])) appRef = rest.shift()
    if (!rest.length) { io.err('Usage: rivervo env rm --shared [application] KEY …\n'); return 1 }
    const p = await resolveProject(call, appRef ?? ctx.appRef, ctx)
    await call('PATCH', `/apps/projects/${p.id}/env`, { body: { unset: rest } })
    io.out(`Removed ${rest.join(', ')} from the shared variables of ${p.slug}. It takes effect with each service's next deploy.\n`)
    return 0
  }
  io.err('Usage: rivervo env ls|set|rm --shared …\n')
  return 1
}

async function cmdEnvOwn (ctx) {
  const { call, opt, pos, io } = ctx
  const sub = pos[0]
  const rest = pos.slice(1)
  if (sub === 'ls' || sub === 'list' || sub === undefined) {
    const app = await resolveApp(call, rest[0] ?? ctx.appRef, ctx)
    const { data } = await call('GET', `/apps/${app.id}/env`)
    if (opt.json) { io.out(JSON.stringify(data, null, 2) + '\n'); return 0 }
    if (!data.length) { io.out('No variables.\n'); return 0 }
    const withTarget = data.some(v => v.target)
    io.out(table([[ 'KEY', 'VALUE', ...(withTarget ? ['TARGET'] : []) ], ...data.map(v => [v.key, opt.reveal ? v.value : '••••••', ...(withTarget ? [v.target ?? 'all'] : [])])]))
    return 0
  }
  if (sub === 'set') {
    // [app] is optional: a first word that is not KEY=value.
    const appRef = rest.length && !rest[0].includes('=') ? rest.shift() : undefined
    const set = {}
    for (const a of rest) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a)
      if (!m) { io.err(`Not KEY=value: ${a}\n`); return 1 }
      set[m[1]] = m[2]
    }
    if (!Object.keys(set).length) { io.err('Usage: rivervo env set [app] KEY=value …\n'); return 1 }
    const app = await resolveApp(call, appRef ?? ctx.appRef, ctx)
    await call('PATCH', `/apps/${app.id}/env`, { body: { set, ...(opt.target ? { target: opt.target } : {}) } })
    io.out(`Saved ${Object.keys(set).join(', ')} on ${label(app)}. They reach the app with its next deploy: rivervo deploy ${app.id} --no-build\n`)
    return 0
  }
  if (sub === 'rm' || sub === 'unset') {
    // [app] is optional: a first word, followed by more, that does not look like a variable name (UPPER_CASE).
    let appRef
    if (rest.length > 1 && !/^[A-Z_][A-Z0-9_]*$/.test(rest[0])) appRef = rest.shift()
    if (!rest.length) { io.err('Usage: rivervo env rm [app] KEY …\n'); return 1 }
    const app = await resolveApp(call, appRef ?? ctx.appRef, ctx)
    await call('PATCH', `/apps/${app.id}/env`, { body: { unset: rest } })
    io.out(`Removed ${rest.join(', ')} from ${label(app)}. It takes effect with the next deploy: rivervo deploy ${app.id} --no-build\n`)
    return 0
  }
  io.err('Usage: rivervo env ls|set|rm …\n')
  return 1
}

async function cmdOpen (ctx) {
  const { call, pos, io, env } = ctx
  const app = await resolveApp(call, pos[0] ?? ctx.appRef, ctx)
  const url = app.url
  if (!url && app.public === false) {
    io.err(`${label(app)} is internal only: it has no public address.${app.internal_url ? ` Other services of the application reach it at ${app.internal_url}.` : ''}\n`)
    return 1
  }
  if (!url) { io.err(`${label(app)} has no web address.\n`); return 1 }
  io.out(url + '\n')
  openUrl(url, env)
  return 0
}

// ── shell ────────────────────────────────────────────────────────────────

const SHELL_ERRORS = {
  limit: 'Too many terminals are open to this service at once. Close one and try again.',
  not_running: 'This process is not running right now.',
  no_shell: 'This service has no shell to open.',
  busy: 'The terminal is busy right now. Try again in a minute.',
}

/**
 * An interactive shell: a one-time ticket from the API, then a WebSocket to the address the API gives with it
 * (the terminal gateway of the server the service runs on). The terminal is raw while it lasts; the exit code is the shell's.
 * io.WebSocket / io.stdin / io.stdout can be given (tests); Node 22 has WebSocket built in.
 */
async function cmdShell (ctx) {
  const { call, opt, pos, io } = ctx
  const WS = 'WebSocket' in io ? io.WebSocket : globalThis.WebSocket
  if (!WS) { io.err('rivervo shell needs Node.js 22 or newer.\n'); return 1 }
  const app = await resolveApp(call, pos[0] ?? ctx.appRef, ctx)
  const proc = opt.process ?? 'web'
  const { data: t } = await call('POST', `/apps/${app.id}/terminal`, { body: { process: proc } })
  const stdin = io.stdin ?? process.stdin
  const stdout = io.stdout ?? process.stdout
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 })

  return new Promise((resolve) => {
    const ws = new WS(t.url)
    ws.binaryType = 'arraybuffer'
    let raw = false
    let ready = false
    let told = false
    let code = 0
    let exited = false
    let limits = {}
    const open = () => ws.readyState === 1
    const onInput = (chunk) => { if (open()) ws.send(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk) }
    // Input from a pipe: its end ends the shell (Ctrl+D), so `echo cmd | rivervo shell` returns.
    const onEnd = () => { if (open()) ws.send(new Uint8Array([4])) }
    const onResize = () => { if (open()) ws.send(JSON.stringify({ type: 'resize', ...size() })) }
    const say = (text) => { told = true; io.err(`${raw ? '\r\n' : ''}${text}\n`) }
    const restore = () => {
      stdin.off?.('data', onInput)
      stdin.off?.('end', onEnd)
      stdout.off?.('resize', onResize)
      if (raw && stdin.setRawMode) stdin.setRawMode(false)
      raw = false
      stdin.pause?.()
    }
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', ticket: t.ticket, ...size() }))
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { stdout.write(Buffer.from(ev.data)); return }
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.type === 'ready') {
        ready = true
        limits = m
        io.err(`Connected to ${label(app)} (${proc}). Leave with exit or Ctrl+D.\n`)
        if (stdin.isTTY && stdin.setRawMode) { stdin.setRawMode(true); raw = true }
        stdin.on('data', onInput)
        stdin.on('end', onEnd)
        stdin.resume?.()
        stdout.on?.('resize', onResize)
      } else if (m.type === 'exit') {
        exited = true
        code = Number.isInteger(m.code) ? m.code : 0
      } else if (m.type === 'closing') {
        code = 1
        if (m.reason === 'idle') say(`Closed after ${Math.round((limits.idle ?? 1800) / 60)} minutes without activity.`)
        else if (m.reason === 'max') say(`Closed: a session lasts at most ${Math.round((limits.max ?? 14400) / 3600)} hours.`)
        else say('The session ended for maintenance. Connect again.')
      } else if (m.type === 'error') {
        code = 1
        say(SHELL_ERRORS[m.code] ?? 'The session could not start. Try again or write to support.')
      }
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      restore()
      if (!told && !ready) { code = 1; io.err('The connection could not be established. Check your network and try again.\n') }
      else if (!told && !exited) { code = 1; io.err('The connection was lost.\n') }
      resolve(code)
    }
    // Node's client reports a refused connection as an error without a close; nor may a silent network ever answer.
    const timer = setTimeout(() => { if (!ready) { try { ws.close() } catch {} finish() } }, 20000)
    ws.onerror = () => { if (!ready) finish() }
    ws.onclose = finish
  })
}

// ── storage: buckets and moving files in (the API from 1.4) ───────────────

const IMPORT_ACTIONS = ['status', 'pause', 'resume', 'abort', 'stop-gradual']
const PROVIDER_FLAG = { s3: 's3', gcs: 'gcs', 's3-compatible': 's3_compatible', s3_compatible: 's3_compatible' }
const PROVIDER_NAME = { s3: 'Amazon S3', gcs: 'Google Cloud Storage', s3_compatible: 'S3-compatible storage' }
const IMPORT_STATUS = { starting: 'starting', running: 'copying', paused: 'paused', completed: 'done', aborted: 'stopped', failed: 'failed', on: 'on', off: 'off' }
const IMPORT_REFUSED = {
  trial: 'Moving files in is not available during the free trial.',
  balance_required: 'Moving files in needs a positive balance. Top up in the panel: Billing → Top up.',
  read_only: 'The bucket is read-only now.',
  busy: 'One of this kind is already running for this bucket.',
}

/** A bucket of the application of `app` by its name or id (GET /apps/{id}/storage). */
export async function resolveBucket (call, appId, ref) {
  const { data } = await call('GET', `/apps/${appId}/storage`)
  const list = data ?? []
  const needle = lc(String(ref ?? '').trim())
  const hit = list.find(b => String(b.id) === needle || lc(b.name) === needle || lc(b.bucket) === needle)
  if (hit) return hit
  const names = list.map(b => b.name).join(', ')
  throw new ApiError(404, { message: needle ? `No bucket “${ref}” in this application.${names ? ` Its buckets: ${names}.` : ' It has no buckets yet.'}` : `Which bucket?${names ? ` ${names}` : ' The application has no buckets yet.'}` })
}

/** «copying 26% — 1 000 found · 250 copied · 10 skipped · 0 not copied» */
export function importLine (i) {
  if (!i) return ''
  const st = IMPORT_STATUS[i.status] ?? i.status
  if (i.mode === 'gradual') return `gradual moving ${st} — from ${PROVIDER_NAME[i.provider] ?? i.provider} ${i.source?.bucket ?? ''}`.trimEnd()
  const p = i.progress ?? {}
  const n = v => v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US')
  const pct = p.percent === null || p.percent === undefined ? '' : ` ${p.percent}%`
  const held = i.held === 'read_only' ? ' (paused while the bucket is read-only)' : ''
  return `copy ${st}${pct} — ${n(p.objects)} found · ${n(p.transferred)} copied · ${n(p.skipped)} skipped · ${n(p.failed)} not copied${held}`
}

async function cmdStorage (ctx) {
  const { pos, io } = ctx
  const sub = pos[0]
  if (sub === 'ls' || sub === 'list' || sub === undefined) return cmdStorageLs({ ...ctx, pos: pos.slice(1) })
  if (sub === 'import') return cmdStorageImport({ ...ctx, pos: pos.slice(1) })
  io.err('Usage: rivervo storage ls [app] | storage import [status|pause|resume|abort|stop-gradual] [app] <bucket> …\n')
  return 1
}

async function cmdStorageLs (ctx) {
  const { call, pos, io, opt } = ctx
  const app = await resolveApp(call, pos[0] ?? ctx.appRef, ctx)
  const res = await call('GET', `/apps/${app.id}/storage`)
  if (opt.json) { io.out(JSON.stringify(res, null, 2) + '\n'); return 0 }
  const rows = (res.data ?? []).map(b => [b.name, b.id, b.status, b.size_bytes === null || b.size_bytes === undefined ? '' : `${+(b.size_bytes / 1073741824).toFixed(2)} GB`, b.read_only ? 'read-only' : ''])
  if (!rows.length) { io.out(`${app.project?.slug ?? label(app)} has no buckets yet. Add one in the panel: the application → Storage.\n`); return 0 }
  io.out(table([['BUCKET', 'ID', 'STATUS', 'SIZE', ''], ...rows]))
  return 0
}

/** [app ref, bucket ref] from «[app] <bucket>». */
function appAndBucket (ctx, pos) {
  if (pos.length === 2) return [pos[0], pos[1]]
  if (pos.length === 1) return [ctx.appRef, pos[0]]
  return null
}

async function cmdStorageImport (ctx) {
  const { pos, io } = ctx
  const usage = 'Usage: rivervo storage import [app] <bucket> --mode copy|gradual --provider s3|gcs|s3-compatible --source-bucket <name> …\n' +
    '       rivervo storage import status|pause|resume|abort|stop-gradual [app] <bucket>\n'
  const action = IMPORT_ACTIONS.includes(pos[0]) ? pos[0] : null
  const refs = appAndBucket(ctx, action ? pos.slice(1) : pos)
  if (!refs) { io.err(usage); return 1 }
  if (action === 'status') return importStatus(ctx, refs)
  if (action) return importControl(ctx, refs, action)
  return importStart(ctx, refs)
}

async function importTarget (ctx, [appRef, bucketRef]) {
  const app = await resolveApp(ctx.call, appRef, ctx)
  const bucket = await resolveBucket(ctx.call, app.id, bucketRef)
  return { app, bucket, base: `/apps/${app.id}/storage/${bucket.id}/import` }
}

async function importStatus (ctx, refs) {
  const { call, io, opt, env } = ctx
  const { bucket, base } = await importTarget(ctx, refs)
  const every = Number(env.RIVERVO_POLL_MS ?? 5000)
  let last = ''
  for (;;) {
    const res = await call('GET', base)
    const { copy, gradual } = res.data ?? {}
    if (opt.json && !opt.watch) { io.out(JSON.stringify(res, null, 2) + '\n'); return 0 }
    if (!opt.watch) {
      if (!copy && !gradual) io.out(`Nothing has been moved into ${bucket.name} yet.\n`)
      if (copy) io.out(importLine(copy) + '\n')
      if (gradual) io.out(importLine(gradual) + '\n')
      if (res.refusal) io.out(`A new one cannot start now: ${res.refusal.message}\n`)
      return 0
    }
    if (!copy) { io.err(`There is no copy into ${bucket.name} to follow.\n`); return 1 }
    const line = importLine(copy)
    if (line !== last) { io.out(line + '\n'); last = line }
    if (!['running', 'paused', 'starting'].includes(copy.status)) {
      if (opt.json) io.out(JSON.stringify(copy, null, 2) + '\n')
      return copy.status === 'completed' ? 0 : 1
    }
    await sleep(every)
  }
}

async function importControl (ctx, refs, action) {
  const { call, io, opt } = ctx
  const { bucket, base } = await importTarget(ctx, refs)
  const { data } = await call('GET', base)
  const it = action === 'stop-gradual' ? data?.gradual : data?.copy
  if (!it) { io.err(action === 'stop-gradual' ? `Gradual moving was never turned on for ${bucket.name}.\n` : `There is no copy into ${bucket.name}.\n`); return 1 }
  if ((action === 'abort' || action === 'stop-gradual') && !opt.yes) {
    const q = action === 'abort'
      ? `Stop the copy into ${bucket.name}? Files already copied stay. [y/N] `
      : `Turn off gradual moving into ${bucket.name}? Files that were never read are no longer fetched from the old storage. [y/N] `
    if (!isTerminal(io)) { io.err(`${q.replace(' [y/N] ', '')}\nPass --yes to do it without a question.\n`); return 1 }
    if (!/^y(es)?$/i.test((await ask(io, q)).trim())) { io.err('Nothing changed.\n'); return 1 }
  }
  let res
  try {
    res = await call('POST', `${base}/${it.id}/${action === 'stop-gradual' ? 'stop' : action}`)
  } catch (e) {
    if (e.status !== 422 || !e.body?.reason) throw e
    io.err(`${e.body.message || IMPORT_REFUSED[e.body.reason] || e.message}\n`)
    return 1
  }
  if (opt.json) { io.out(JSON.stringify(res, null, 2) + '\n'); return 0 }
  io.out(importLine(res.data) + '\n')
  return 0
}

/**
 * Start one. The old storage's key: RIVERVO_IMPORT_ACCESS_KEY_ID / RIVERVO_IMPORT_SECRET_ACCESS_KEY (S3, S3-compatible)
 * or RIVERVO_IMPORT_GCS_KEY_FILE / --gcs-key-file (a path), else asked (hidden) in a terminal. Never a flag: a key given
 * as --access-key-id / --secret-access-key is refused, so it does not stay in the shell's history.
 */
async function importStart (ctx, refs) {
  const { call, io, opt, env } = ctx
  if (opt['access-key-id'] !== undefined || opt['secret-access-key'] !== undefined) {
    io.err('Keys are not taken as flags (they would stay in your shell history). Set RIVERVO_IMPORT_ACCESS_KEY_ID and\nRIVERVO_IMPORT_SECRET_ACCESS_KEY, or leave them out to be asked.\n')
    return 1
  }
  const tty = isTerminal(io)
  const need = async (value, question, check, what) => {
    if (value !== undefined && value !== true && String(value).trim() !== '') return String(value).trim()
    if (!tty) throw new ApiError(400, { message: `Give ${what}.` })
    const v = (await ask(io, question)).trim()
    if (!v || (check && !check(v))) throw new ApiError(400, { message: `Not ${what}: ${v || '(empty)'}` })
    return v
  }
  const mode = lc(await need(opt.mode, 'copy (everything now) or gradual (copied on first read)? ', v => ['copy', 'gradual'].includes(lc(v)), '--mode copy|gradual'))
  if (!['copy', 'gradual'].includes(mode)) { io.err('--mode is copy or gradual.\n'); return 1 }
  const provider = PROVIDER_FLAG[lc(await need(opt.provider, 'Old storage — s3, gcs or s3-compatible? ', v => !!PROVIDER_FLAG[lc(v)], '--provider s3|gcs|s3-compatible'))]
  if (!provider) { io.err('--provider is s3, gcs or s3-compatible.\n'); return 1 }
  const body = { mode, provider, bucket: await need(opt['source-bucket'], 'The bucket in the old storage: ', null, '--source-bucket <name>') }
  if (provider === 's3') body.region = await need(opt.region, 'Its region (e.g. eu-central-1): ', null, '--region <region>')
  if (provider === 's3_compatible') {
    body.endpoint = await need(opt.endpoint, 'Its S3 address (https://…, without the bucket): ', v => /^https:\/\//.test(v), '--endpoint https://…')
    if (opt.region && opt.region !== true) body.region = String(opt.region)
  }
  if (mode === 'copy') {
    if (opt.prefix && opt.prefix !== true) body.prefix = String(opt.prefix)
    body.overwrite = opt.overwrite === true
  } else if (opt.prefix || opt.overwrite) { io.err('--prefix and --overwrite are for --mode copy only.\n'); return 1 }

  const { app, bucket, base } = await importTarget(ctx, refs)
  if (provider === 'gcs') {
    const file = opt['gcs-key-file'] && opt['gcs-key-file'] !== true ? String(opt['gcs-key-file']) : env.RIVERVO_IMPORT_GCS_KEY_FILE || (tty ? (await ask(io, 'Path to the service account\'s JSON key file: ')).trim() : '')
    if (!file) { io.err('Give the service account\'s JSON key file: --gcs-key-file <path> or RIVERVO_IMPORT_GCS_KEY_FILE.\n'); return 1 }
    try {
      body.service_account_json = await readFile(file, 'utf8')
    } catch (e) {
      io.err(`Cannot read ${file}: ${e.message}\n`)
      return 1
    }
  } else {
    body.access_key_id = env.RIVERVO_IMPORT_ACCESS_KEY_ID || (tty ? (await ask(io, 'Access key ID (a key that can only list and read that bucket): ', { hidden: true })).trim() : '')
    body.secret_access_key = env.RIVERVO_IMPORT_SECRET_ACCESS_KEY || (tty ? (await ask(io, 'Secret access key: ', { hidden: true })).trim() : '')
    if (!body.access_key_id || !body.secret_access_key) {
      io.err('Give the old storage\'s key: set RIVERVO_IMPORT_ACCESS_KEY_ID and RIVERVO_IMPORT_SECRET_ACCESS_KEY (or run it in a terminal to be asked).\n')
      return 1
    }
  }

  const from = `${PROVIDER_NAME[provider]} ${body.bucket}${body.prefix ? `/${body.prefix.replace(/^\/+/, '')}` : ''}`
  const what = mode === 'copy'
    ? `Copy everything from ${from} into ${bucket.name} of ${app.project?.slug ?? label(app)}${body.overwrite ? ', replacing files of the same name' : ' (files already there are kept)'}.`
    : `Turn on gradual moving from ${from} into ${bucket.name} of ${app.project?.slug ?? label(app)}: a file is copied the first time it is read.`
  const cost = 'No fee for the move itself: files cost the usual storage prices (size and writes), paid from your balance; your old provider may charge for data leaving it.'
  if (!opt.yes) {
    if (!tty) { io.err(`${what}\n${cost}\nPass --yes to start it without a question.\n`); return 1 }
    io.out(`${what}\n${cost}\n`)
    if (!/^y(es)?$/i.test((await ask(io, 'Start? [y/N] ')).trim())) { io.err('Nothing started.\n'); return 1 }
  }
  let res
  try {
    res = await call('POST', base, { body })
  } catch (e) {
    if (e.status !== 422 || !e.body?.reason) throw e
    io.err(`${e.body.message || IMPORT_REFUSED[e.body.reason] || e.message}\n`)
    return 1
  } finally {
    delete body.access_key_id
    delete body.secret_access_key
    delete body.service_account_json
  }
  if (opt.json) { io.out(JSON.stringify(res, null, 2) + '\n'); return 0 }
  if (mode === 'copy') io.out(`The copy has started; it runs on our side and you get an e-mail when it is done.\nFollow it: rivervo storage import status ${app.project?.slug ?? label(app)} ${bucket.name} --watch\n`)
  else io.out(`Gradual moving is on. Switch your application to ${bucket.name} now (its S3_* variables).\nTo finish: run a copy for the rest (--mode copy), then: rivervo storage import stop-gradual ${app.project?.slug ?? label(app)} ${bucket.name}\n`)
  return 0
}

const COMMANDS = { shell: cmdShell, login: cmdLogin, logout: cmdLogout, apps: cmdApps, ls: cmdApps, services: cmdServices, link: cmdLink, unlink: cmdUnlink, deploy: cmdDeploy, rollback: cmdRollback, logs: cmdLogs, env: cmdEnv, usage: cmdUsage, open: cmdOpen, storage: cmdStorage }

/** Run one command. @returns {Promise<number>} the exit code */
export async function main (argv = process.argv.slice(2), io = {}) {
  io = { out: s => process.stdout.write(s), err: s => process.stderr.write(s), env: process.env, ...io }
  const env = io.env
  const { pos, opt } = parseArgs(argv)
  if (opt.version) { io.out(VERSION + '\n'); return 0 }
  const name = pos.shift()
  if (!name || opt.help || name === 'help') { io.out(HELP); return 0 }
  const command = COMMANDS[name]
  if (!command) { io.err(`Unknown command: ${name}\n\n${HELP}`); return 1 }
  const cfg = await loadConfig(env)
  const lang = ['en', 'az', 'ru'].includes(env.RIVERVO_LANG) ? env.RIVERVO_LANG : 'en'
  const ctx = { pos, opt, io, env, cfg, lang, appRef: opt.app ?? env.RIVERVO_APP, cwd: io.cwd ?? process.cwd() }
  try {
    if (name !== 'login' && name !== 'logout' && name !== 'unlink') {
      const token = env.RIVERVO_TOKEN || cfg.token
      if (!token) { io.err('Not logged in. Run: rivervo login\n'); return 1 }
      ctx.call = client({ api: env.RIVERVO_API_URL || cfg.api || DEFAULT_API, token, account: opt.account ?? env.RIVERVO_ACCOUNT, lang })
    }
    return await command(ctx)
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    if (e.status === 401) io.err('The token is not valid (revoked or expired). Run: rivervo login\n')
    else if (e.status === 403 && e.body?.reason === 'token_scope') io.err(`${e.message}\n(This needs a “${e.body.needs}” token.)\n`)
    else if (e.status === 403 && e.body?.reason === 'forbidden' && e.body?.needs === 'owner') io.err(`${e.message}\n(Only the account owner can do this.)\n`)
    else if (e.status === 403 && e.body?.reason === 'forbidden' && e.body?.needs === 'admin') io.err(`${e.message}\n(This needs the Administrator role in the application${e.body.role ? `; yours is ${e.body.role}` : ''}.)\n`)
    else if (e.status === 429) io.err(`${e.message}\n`)
    else {
      io.err(`${e.message}\n`)
      for (const [field, msgs] of Object.entries(e.body?.errors ?? {})) io.err(`  ${field}: ${[].concat(msgs).join(' ')}\n`)
    }
    return 1
  }
}

// Run when started as a program (also through npm's bin link), not when imported.
const startedAs = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href } catch { return '' } })()
if (startedAs === import.meta.url) {
  main().then(code => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
