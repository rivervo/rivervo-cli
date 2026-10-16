#!/usr/bin/env node
/*
 * rivervo — the command line for Rivervo Applications.
 * One file, no dependencies (Node 22+): it talks to the public API (/api/v1) with a
 * personal API token from Account settings → API tokens.
 *
 *   rivervo login | logout | apps | deploy | logs | env ls|set|rm | rollback | open | shell
 *
 * Importable for tests: main(argv, io) runs one command and resolves its exit code.
 */
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export const VERSION = '1.1.0'
const DEFAULT_API = 'https://api.rivervo.com/api/v1'

const HELP = `rivervo ${VERSION} — Rivervo Applications from the command line

Usage
  rivervo login [--token <token>] [--api <url>]   save a personal API token
  rivervo logout                                  forget the saved token
  rivervo apps                                    your apps and their services
  rivervo deploy [app] [--no-build] [--detach]    deploy: build the latest commit (or, with --no-build,
                                                  the running version again) and follow its progress
  rivervo logs [app] [-f] [-n <lines>] [--process web|cron|w1]
                                                  the app's output; -f keeps following it
  rivervo env ls [app] [--reveal]                 variables (values hidden unless --reveal)
  rivervo env set [app] KEY=value … [--target all|production|preview]
  rivervo env rm [app] KEY …
  rivervo rollback [app] [deployment]             back to an earlier version (default: the previous one)
  rivervo open [app]                              open the app in the browser
  rivervo shell [app] [--process web|i2|w1]       an interactive shell in the running service (tinker, psql…);
                                                  web is its first instance, i2… the others, w1… a worker

[app] is an app's id, address (slug) or name — or a service's id. Without it: --app, the
RIVERVO_APP variable, or your only app.

Options
  --account <id>   work in another account you are a team member of
  --json           print the API's JSON instead of text
  -h, --help       this help        -v, --version

Environment
  RIVERVO_TOKEN    a token to use instead of the saved one (CI)
  RIVERVO_API_URL  the API (default ${DEFAULT_API})
  RIVERVO_LANG     language of messages from the API: en (default), az, ru
`

// ── arguments ────────────────────────────────────────────────────────────

const FLAGS_WITH_VALUE = new Set(['token', 'api', 'app', 'account', 'lines', 'n', 'process', 'target'])

export function parseArgs (argv) {
  const pos = []
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { pos.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2)
      if (k.startsWith('no-')) opt[k.slice(3)] = false
      else if (v !== undefined) opt[k] = v
      else if (FLAGS_WITH_VALUE.has(k)) opt[k] = argv[++i]
      else opt[k] = true
    } else if (a.length > 1 && a.startsWith('-') && !/^-\d/.test(a)) {
      const k = { f: 'follow', n: 'lines', h: 'help', v: 'version' }[a.slice(1)] ?? a.slice(1)
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

/** An app from an id, slug or name — or a service by its id or name; else the only app. */
export async function resolveApp (call, ref) {
  const { data: apps } = await call('GET', '/apps')
  const flat = apps.flatMap(a => [a, ...(a.services ?? []).map(s => ({ ...s, service_of: a.id, project: a.name }))])
  if (ref === undefined || ref === null || ref === '') {
    if (apps.length === 1) return apps[0]
    if (!apps.length) throw new ApiError(404, { message: 'You have no apps yet. Create one in the panel.' })
    throw new ApiError(400, { message: `Which app? Give its id or address:\n${apps.map(a => `  ${a.id}  ${a.slug}`).join('\n')}` })
  }
  const s = String(ref).toLowerCase()
  const hit = flat.find(a => String(a.id) === s) ?? flat.find(a => a.slug?.toLowerCase() === s) ?? flat.filter(a => a.name?.toLowerCase() === s)
  if (Array.isArray(hit)) {
    if (hit.length === 1) return hit[0]
    if (hit.length > 1) throw new ApiError(400, { message: `“${ref}” matches ${hit.length} apps or services; use the id: ${hit.map(h => h.id).join(', ')}` })
    throw new ApiError(404, { message: `No app “${ref}”. Run rivervo apps to see yours.` })
  }
  return hit
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
  io.out(`Logged in. ${data.length} app${data.length === 1 ? '' : 's'} visible. Saved to ${file}\n`)
  return 0
}

async function cmdLogout ({ env, io }) {
  await rm(join(configDir(env), 'config.json'), { force: true })
  io.out('Logged out. (The token itself stays valid until you revoke it in the panel.)\n')
  return 0
}

async function cmdApps ({ call, io, opt }) {
  const res = await call('GET', '/apps')
  if (opt.json) { io.out(JSON.stringify(res.data, null, 2) + '\n'); return 0 }
  if (!res.data.length) { io.out('No apps yet. Create one in the panel.\n'); return 0 }
  const rows = [['ID', 'NAME', 'STATUS', 'URL']]
  for (const a of res.data) {
    rows.push([a.id, a.name, a.health === 'down' ? `${a.status} (down)` : a.status, a.url ?? ''])
    for (const s of a.services ?? []) rows.push([s.id, `  └ ${s.name} (${s.type})`, s.health === 'down' ? `${s.status} (down)` : s.status, s.url ?? ''])
  }
  io.out(table(rows))
  return 0
}

async function cmdDeploy (ctx) {
  const { call, opt, pos, io, env } = ctx
  const app = await resolveApp(call, pos[0] ?? ctx.appRef)
  const { data: dep } = await call('POST', `/apps/${app.id}/deployments`, { body: { rebuild: opt.build !== false } })
  if (!opt.json) io.out(`${opt.build === false ? 'Deploying the running version of' : 'Building and deploying'} ${app.name} (deployment ${dep.id})\n`)
  if (opt.detach) { if (opt.json) io.out(JSON.stringify(dep, null, 2) + '\n'); return 0 }
  return follow(call, app.id, dep, io, env, opt.json)
}

async function cmdRollback (ctx) {
  const { call, pos, io, env, opt } = ctx
  const app = await resolveApp(call, pos[0] ?? ctx.appRef)
  let to = pos[1]
  if (!to) {
    const { data: list } = await call('GET', `/apps/${app.id}/deployments`, { query: { limit: 50 } })
    const prev = list.find(d => d.can_rollback)
    if (!prev) { io.err('There is no earlier version to go back to.\n'); return 1 }
    to = prev.id
  }
  const { data: dep } = await call('POST', `/apps/${app.id}/deployments/${to}/rollback`)
  if (!opt.json) io.out(`Rolling ${app.name} back to deployment ${to}\n`)
  if (opt.detach) return 0
  return follow(call, app.id, dep, io, env, opt.json)
}

async function cmdLogs (ctx) {
  const { call, opt, pos, io, env } = ctx
  const app = await resolveApp(call, pos[0] ?? ctx.appRef)
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
  const { call, opt, pos, io } = ctx
  const sub = pos[0]
  const rest = pos.slice(1)
  if (sub === 'ls' || sub === 'list' || sub === undefined) {
    const app = await resolveApp(call, rest[0] ?? ctx.appRef)
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
    const app = await resolveApp(call, appRef ?? ctx.appRef)
    await call('PATCH', `/apps/${app.id}/env`, { body: { set, ...(opt.target ? { target: opt.target } : {}) } })
    io.out(`Saved ${Object.keys(set).join(', ')} on ${app.name}. They reach the app with its next deploy: rivervo deploy ${app.id} --no-build\n`)
    return 0
  }
  if (sub === 'rm' || sub === 'unset') {
    // [app] is optional: a first word, followed by more, that does not look like a variable name (UPPER_CASE).
    let appRef
    if (rest.length > 1 && !/^[A-Z_][A-Z0-9_]*$/.test(rest[0])) appRef = rest.shift()
    if (!rest.length) { io.err('Usage: rivervo env rm [app] KEY …\n'); return 1 }
    const app = await resolveApp(call, appRef ?? ctx.appRef)
    await call('PATCH', `/apps/${app.id}/env`, { body: { unset: rest } })
    io.out(`Removed ${rest.join(', ')} from ${app.name}. It takes effect with the next deploy: rivervo deploy ${app.id} --no-build\n`)
    return 0
  }
  io.err('Usage: rivervo env ls|set|rm …\n')
  return 1
}

async function cmdOpen (ctx) {
  const { call, pos, io, env } = ctx
  const app = await resolveApp(call, pos[0] ?? ctx.appRef)
  const url = app.url
  if (!url) { io.err(`${app.name} has no web address.\n`); return 1 }
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
 * An interactive shell: a one-time ticket from the API, then a WebSocket straight to the app's own
 * address (the server's terminal gateway). The terminal is raw while it lasts; the exit code is the shell's.
 * io.WebSocket / io.stdin / io.stdout can be given (tests); Node 22 has WebSocket built in.
 */
async function cmdShell (ctx) {
  const { call, opt, pos, io } = ctx
  const WS = 'WebSocket' in io ? io.WebSocket : globalThis.WebSocket
  if (!WS) { io.err('rivervo shell needs Node.js 22 or newer.\n'); return 1 }
  const app = await resolveApp(call, pos[0] ?? ctx.appRef)
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
        io.err(`Connected to ${app.name} (${proc}). Leave with exit or Ctrl+D.\n`)
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

const COMMANDS = { shell: cmdShell, login: cmdLogin, logout: cmdLogout, apps: cmdApps, ls: cmdApps, deploy: cmdDeploy, rollback: cmdRollback, logs: cmdLogs, env: cmdEnv, open: cmdOpen }

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
  const ctx = { pos, opt, io, env, cfg, lang, appRef: opt.app ?? env.RIVERVO_APP }
  try {
    if (name !== 'login' && name !== 'logout') {
      const token = env.RIVERVO_TOKEN || cfg.token
      if (!token) { io.err('Not logged in. Run: rivervo login\n'); return 1 }
      ctx.call = client({ api: env.RIVERVO_API_URL || cfg.api || DEFAULT_API, token, account: opt.account ?? env.RIVERVO_ACCOUNT, lang })
    }
    return await command(ctx)
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    if (e.status === 401) io.err('The token is not valid (revoked or expired). Run: rivervo login\n')
    else if (e.status === 403 && e.body?.reason === 'token_scope') io.err(`${e.message}\n(This needs a “${e.body.needs}” token.)\n`)
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
