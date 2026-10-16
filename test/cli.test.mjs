// The CLI against a mocked Rivervo API (node:test, no network).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, parseArgs, configDir, afterOverlap } from '../bin/rivervo.mjs'

let server
let base
let requests = []
let state

function reset () {
  requests = []
  state = {
    env: [{ key: 'A', value: 'one', target: 'all' }],
    polls: 0,
    logRounds: 0,
  }
}

const APPS = [
  { id: 7, name: 'Shop', slug: 'shop', status: 'live', health: 'up', url: 'https://shop.rivervo.app', services: [{ id: 8, name: 'worker', type: 'worker', status: 'live', health: 'down', url: null }] },
  { id: 9, name: 'Blog', slug: 'blog', status: 'live', health: 'up', url: 'https://blog.rivervo.app', services: [] },
]

function route (req, body) {
  const url = new URL(req.url, base)
  const p = url.pathname.replace(/^\/api\/v1/, '')
  if (req.headers.authorization !== 'Bearer good-token') return [401, { message: 'Unauthenticated.' }]
  const key = `${req.method} ${p}`
  if (key === 'GET /apps') return [200, { data: APPS }]
  if (key === 'POST /apps/7/deployments') return [202, { data: { id: state.failNext ? 101 : 100, status: 'queued', steps: [] } }]
  if (key === 'POST /apps/9/deployments') return [403, { message: 'This token does not allow this.', reason: 'token_scope', needs: 'deploy' }]
  if (key === 'GET /apps/7/deployments/100' || key === 'GET /apps/7/deployments/101') {
    state.polls++
    const offset = Number(url.searchParams.get('log_offset') ?? 0)
    const full = state.polls === 1 ? 'npm ci\n' : 'npm ci\nnpm run build\n'
    const done = state.polls >= 2
    const failed = key.endsWith('101')
    return [200, { data: {
      id: Number(p.split('/').pop()), status: done ? (failed ? 'failed' : 'succeeded') : 'running', error: failed && done ? 'Build failed' : null,
      steps: [{ key: 'fetch', status: 'done' }, { key: 'build', status: done ? (failed ? 'failed' : 'done') : 'running' }, { key: 'route', status: done && !failed ? 'done' : 'pending' }],
      log: full.slice(offset), log_offset: offset, log_length: full.length,
    } }]
  }
  if (key === 'GET /apps/7/deployments') return [200, { data: [{ id: 101, status: 'failed', can_rollback: false }, { id: 99, status: 'succeeded', current: true, can_rollback: false }, { id: 98, status: 'succeeded', can_rollback: true }] }]
  if (key === 'POST /apps/7/deployments/98/rollback') return [202, { data: { id: 100, status: 'queued', trigger: 'rollback' } }]
  if (key === 'GET /apps/7/logs') {
    if (url.searchParams.get('since')) {
      state.logRounds++
      return [200, { data: { lines: state.logRounds === 1 ? ['2026-10-16T10:00:09.000000000Z third'] : [], process: 'web', running: true }, at: '2026-10-16T10:00:10.000000Z' }]
    }
    return [200, { data: { lines: ['2026-10-16T10:00:00.000000000Z first', '2026-10-16T10:00:05.000000000Z second'], process: url.searchParams.get('process'), running: true }, at: '2026-10-16T10:00:06.000000Z' }]
  }
  if (key === 'GET /apps/7/env') return [200, { data: state.env }]
  if (key === 'PATCH /apps/7/env') {
    const b = JSON.parse(body)
    for (const [k, v] of Object.entries(b.set ?? {})) state.env.push({ key: k, value: v, target: b.target ?? 'all' })
    state.env = state.env.filter(v => !(b.unset ?? []).includes(v.key))
    return [200, { data: state.env, applies: 'next_deployment' }]
  }
  return [404, { message: 'Not found' }]
}

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      const [status, json] = route(req, body)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(json))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

let home
beforeEach(async () => {
  reset()
  home = await mkdtemp(join(tmpdir(), 'rivervo-cli-'))
})

/** Run the CLI; returns {code, out, err}. */
async function run (argv, { env = {}, prompt } = {}) {
  let out = ''
  let err = ''
  const code = await main(argv, {
    out: s => { out += s },
    err: s => { err += s },
    prompt,
    env: { XDG_CONFIG_HOME: home, RIVERVO_POLL_MS: '1', RIVERVO_NO_BROWSER: '1', RIVERVO_API_URL: `${base}/api/v1`, RIVERVO_TOKEN: 'good-token', ...env },
  })
  return { code, out, err }
}

test('parses flags, short flags and values', () => {
  assert.deepEqual(parseArgs(['logs', 'shop', '-f', '-n', '50', '--process=w1', '--no-build', '--app', '7']), {
    pos: ['logs', 'shop'], opt: { follow: true, lines: '50', process: 'w1', build: false, app: '7' },
  })
})

test('login: verifies the pasted token and stores it privately; logout forgets it', async () => {
  const r = await run(['login', '--api', `${base}/api/v1`], { env: { RIVERVO_TOKEN: '', RIVERVO_API_URL: '' }, prompt: async () => ' good-token \n' })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /Logged in\. 2 apps visible/)
  const file = join(configDir({ XDG_CONFIG_HOME: home }), 'config.json')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { api: `${base}/api/v1`, token: 'good-token' })
  assert.equal((await stat(file)).mode & 0o777, 0o600)

  // The saved token is used when no RIVERVO_TOKEN is set.
  const apps = await run(['apps'], { env: { RIVERVO_TOKEN: '', RIVERVO_API_URL: '' } })
  assert.equal(apps.code, 0, apps.err)

  const out = await run(['logout'])
  assert.equal(out.code, 0)
  await assert.rejects(stat(file))
  const again = await run(['apps'], { env: { RIVERVO_TOKEN: '', RIVERVO_API_URL: '' } })
  assert.equal(again.code, 1)
  assert.match(again.err, /Not logged in/)
})

test('login refuses a bad token and stores nothing', async () => {
  const r = await run(['login', '--token', 'bad', '--api', `${base}/api/v1`])
  assert.equal(r.code, 1)
  assert.match(r.err, /not valid/)
  await assert.rejects(readFile(join(configDir({ XDG_CONFIG_HOME: home }), 'config.json')))
})

test('apps: a table of apps with their services', async () => {
  const r = await run(['apps'])
  assert.equal(r.code, 0)
  assert.match(r.out, /^ID\s+NAME\s+STATUS\s+URL/)
  assert.match(r.out, /7\s+Shop\s+live\s+https:\/\/shop\.rivervo\.app/)
  assert.match(r.out, /8\s+└ worker \(worker\)\s+live \(down\)/)
  assert.equal(requests[0].headers.locale, 'en')
  assert.match(requests[0].headers['user-agent'], /^rivervo-cli\//)
})

test('deploy: builds, follows steps and the growing log, exits 0 when it succeeds', async () => {
  const r = await run(['deploy', 'shop'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(requests.find(q => q.method === 'POST').body), { rebuild: true })
  assert.match(r.out, /Building and deploying Shop \(deployment 100\)/)
  assert.match(r.out, /✓ Fetching the source code/)
  assert.match(r.out, /… Building[\s\S]*✓ Building/)
  // The log is printed once, line by line, as it grows.
  assert.equal(r.out.match(/│ npm ci/g).length, 1)
  assert.match(r.out, /│ npm run build/)
  assert.match(r.out, /Deployed\./)
  const polls = requests.filter(q => q.url.includes('/deployments/100'))
  assert.match(polls[1].url, /log_offset=7/)
})

test('deploy --no-build redeploys the running version; --detach does not wait; --app and a single app pick the app', async () => {
  let r = await run(['deploy', '--no-build', '--detach', '--app', '7'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(requests.find(q => q.method === 'POST').body), { rebuild: false })
  assert.equal(requests.filter(q => q.url.includes('/deployments/100')).length, 0)

  r = await run(['deploy'])
  assert.equal(r.code, 1)
  assert.match(r.err, /Which app\?/)
})

test('deploy: a token without the scope gets a clear message', async () => {
  const r = await run(['deploy', 'blog'])
  assert.equal(r.code, 1)
  assert.match(r.err, /needs a “deploy” token/)
})

test('rollback: to the previous version by default, followed to the end; a failed one exits 1', async () => {
  const r = await run(['rollback', '7'])
  assert.equal(r.code, 0, r.err)
  assert.ok(requests.some(q => q.method === 'POST' && q.url === '/api/v1/apps/7/deployments/98/rollback'))
  assert.match(r.out, /Rolling Shop back to deployment 98/)

  reset()
  state.failNext = true
  const failed = await run(['deploy', 'shop'])
  assert.equal(failed.code, 1)
  assert.match(failed.out, /✗ Building/)
  assert.match(failed.err, /did not finish: Build failed/)
})

test('logs: the tail, then --follow asks only for lines after the last one shown', async () => {
  const r = await run(['logs', 'shop', '-n', '50', '--process', 'w1', '-f'], { env: { RIVERVO_FOLLOW_ROUNDS: '2' } })
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, '2026-10-16T10:00:00.000000000Z first\n2026-10-16T10:00:05.000000000Z second\n2026-10-16T10:00:09.000000000Z third\n')
  const logs = requests.filter(q => q.url.startsWith('/api/v1/apps/7/logs')).map(q => new URL(q.url, base).searchParams)
  assert.equal(logs[0].get('lines'), '50')
  assert.equal(logs[0].get('process'), 'w1')
  assert.equal(logs[1].get('since'), '2026-10-16T10:00:05.000000000Z')
  assert.equal(logs[2].get('since'), '2026-10-16T10:00:09.000000000Z')
})

test('a log without times (the schedule) shows only lines after the ones already shown', () => {
  assert.deepEqual(afterOverlap(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e']), ['d', 'e'])
  assert.deepEqual(afterOverlap(['x', 'b', 'c'], ['b', 'c', 'd']), ['b', 'c', 'd'])  // the anchor is gone: everything
  assert.deepEqual(afterOverlap(['b', 'c', 'b', 'c'], ['c', 'b', 'c', 'z']), ['z'])
  assert.deepEqual(afterOverlap([], ['a']), ['a'])
})

test('env ls hides values unless --reveal; set and rm patch only what is named', async () => {
  let r = await run(['env', 'ls', 'shop'])
  assert.match(r.out, /A\s+••••••\s+all/)
  assert.doesNotMatch(r.out, /one/)
  r = await run(['env', 'ls', 'shop', '--reveal'])
  assert.match(r.out, /A\s+one/)

  r = await run(['env', 'set', 'shop', 'DATABASE_URL=postgres://x:y@h/db?a=b', 'B=2', '--target', 'production'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(requests.at(-1).body), { set: { DATABASE_URL: 'postgres://x:y@h/db?a=b', B: '2' }, target: 'production' })
  assert.match(r.out, /next deploy: rivervo deploy 7 --no-build/)

  r = await run(['env', 'rm', 'shop', 'B'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(requests.at(-1).body), { unset: ['B'] })

  r = await run(['env', 'set', 'shop', 'not-a-pair'])
  assert.equal(r.code, 1)
})

test('open prints the address (the browser is not started in tests); a worker has none', async () => {
  let r = await run(['open', 'shop'])
  assert.equal(r.code, 0)
  assert.equal(r.out, 'https://shop.rivervo.app\n')
  r = await run(['open', '8'])
  assert.equal(r.code, 1)
  assert.match(r.err, /no web address/)
})

test('help, version, unknown commands and X-Account', async () => {
  assert.match((await run(['--help'])).out, /rivervo login/)
  assert.match((await run(['-v'])).out, /^\d+\.\d+\.\d+\n$/)
  assert.equal((await run(['frobnicate'])).code, 1)
  await run(['apps', '--account', '42'])
  assert.equal(requests.at(-1).headers['x-account'], '42')
})

after(async () => { if (home) await rm(home, { recursive: true, force: true }) })
