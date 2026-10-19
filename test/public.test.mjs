// A web service's public address or «internal only» (the API from 1.3): the apps table, services info,
// services set-public with its confirmation, open — against a mocked API (node:test, no network).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../bin/rivervo.mjs'

const SHOP = { id: 3, slug: 'shop', name: 'Shop' }
const RES = { memory_mb: 512, cpus: 1, disk_gb: 10 }
// GET /apps: shop/web public, shop/api internal only, shop/admin public (has domains), a worker and a database.
const SERVICES = [
  { id: 7, name: 'web', slug: 'shopx', type: 'web', status: 'live', health: 'up', url: 'https://shopx.rivervo.app', public: true, internal_url: 'http://web:8080', project: SHOP, services: [] },
  { id: 10, name: 'api', slug: 'shop-api', type: 'web', status: 'live', health: 'up', url: null, public: false, internal_url: 'http://api:8080', project: SHOP, services: [] },
  { id: 11, name: 'admin', slug: 'shop-admin', type: 'web', status: 'live', health: 'up', url: 'https://shop-admin.rivervo.app', public: true, internal_url: 'http://admin:8080', project: SHOP, services: [] },
  { id: 8, name: 'worker', slug: 'shopx-worker', type: 'worker', status: 'live', health: 'up', url: null, public: null, internal_url: null, project: SHOP, services: [] },
  { id: 9, name: 'db', slug: 'shopx-db', type: 'postgres', status: 'live', url: null, public: null, internal_url: null, project: SHOP, services: [] },
]
const PROJECTS = [
  { ...SHOP, status: 'active', services: [
    { id: 7, name: 'web', type: 'web', status: 'live', address: 'shopx.rivervo.app', url: 'https://shopx.rivervo.app', public: true, internal_url: 'http://web:8080' },
    { id: 10, name: 'api', type: 'web', status: 'live', address: null, url: null, public: false, internal_url: 'http://api:8080' },
    { id: 8, name: 'worker', type: 'worker', status: 'live', address: null, url: null, public: null, internal_url: null },
    { id: 9, name: 'db', type: 'postgres', status: 'live', address: null, url: null, public: null, internal_url: null },
  ] },
]

let server, base, home, requests, answer
beforeEach(async () => {
  requests = []
  answer = { applied: true, role: null }
  home = await mkdtemp(join(tmpdir(), 'rivervo-public-'))
})

const brief = (s, over = {}) => ({ ...s, services: undefined, repo: 'acme/shop', branch: 'main', resources: RES, ...over })

function route (req, body, url) {
  const p = url.pathname.replace(/^\/api\/v1/, '')
  const key = `${req.method} ${p}`
  if (key === 'GET /apps') return [200, { data: SERVICES }]
  if (key === 'GET /apps/projects') return [200, { data: PROJECTS }]
  const show = /^GET \/apps\/(\d+)$/.exec(key)
  if (show) {
    const s = SERVICES.find(x => String(x.id) === show[1])
    return s ? [200, { data: brief(s, { domains: s.id === 11 ? [{ name: 'admin.shop.az', status: 'active' }] : [], latest_deployment: null }) }] : [404, { message: 'Not found' }]
  }
  const put = /^PUT \/apps\/(\d+)\/public$/.exec(key)
  if (put) {
    if (answer.role) return [403, { message: 'Your role in this application does not allow this.', reason: 'forbidden', needs: 'admin', role: answer.role }]
    const s = SERVICES.find(x => String(x.id) === put[1])
    const on = JSON.parse(body).public
    if (s.id === 11 && !on) {
      const message = 'Remove the custom domains of this service first: an internal-only service has no domains.'
      return [422, { message, reason: 'domains', errors: { public: [message] } }]
    }
    if (s.type !== 'web') return [422, { message: 'Only a web service has a public address.', reason: 'not_web', errors: { public: ['Only a web service has a public address.'] } }]
    return [200, { data: brief(s, { public: on, url: on ? `https://${s.slug}.rivervo.app` : null }), applied: answer.applied }]
  }
  return [404, { message: 'Not found' }]
}

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, base)
      requests.push({ method: req.method, url: req.url, body })
      const [status, json] = route(req, body, url)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(json))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

/** Run the CLI; `tty` says whether there is a terminal to ask in, `prompt` answers its question. */
async function run (argv, { tty = false, prompt, env = {} } = {}) {
  let out = ''
  let err = ''
  const asked = []
  const code = await main(argv, {
    out: s => { out += s }, err: s => { err += s }, cwd: home, isTTY: tty,
    prompt: prompt ? async q => { asked.push(q); return prompt } : undefined,
    env: { XDG_CONFIG_HOME: home, RIVERVO_POLL_MS: '1', RIVERVO_NO_BROWSER: '1', RIVERVO_API_URL: `${base}/api/v1`, RIVERVO_TOKEN: 'good-token', ...env },
  })
  return { code, out, err, asked }
}

const puts = () => requests.filter(q => q.method === 'PUT')

test('apps: a web service is public or internal only, with its internal address; an internal one shows no URL', async () => {
  const r = await run(['apps'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^APPLICATION \/ SERVICE\s+ID\s+TYPE\s+STATUS\s+INTERNAL\s+URL\n/)
  assert.match(r.out, / {2}shop\/web\s+7\s+web\s+live\s+http:\/\/web:8080\s+https:\/\/shopx\.rivervo\.app\n/)
  assert.match(r.out, / {2}shop\/api\s+10\s+web\s+live\s+http:\/\/api:8080\s+internal only\n/)
  assert.match(r.out, / {2}shop\/worker\s+8\s+worker\s+live\n/)
  assert.doesNotMatch(r.out, /shop-api\.rivervo\.app/)
  for (const line of r.out.split('\n')) assert.ok(line.length <= 100, line)

  // rivervo services (no subcommand) and services ls: the same list.
  for (const argv of [['services'], ['services', 'ls']]) {
    const s = await run(argv)
    assert.equal(s.code, 0, s.err)
    assert.equal(s.out, r.out)
  }
  const bad = await run(['services', 'frob'])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /^Usage: rivervo services/)
})

test('services info: application, type, status, health, addresses, repository, resources; --json is the API\'s', async () => {
  let r = await run(['services', 'info', 'shop/api'])
  assert.equal(r.code, 0, r.err)
  assert.equal(requests.at(-1).url, '/api/v1/apps/10')
  assert.match(r.out, /^shop\/api \(service 10\)\n\n/)
  assert.match(r.out, /Application\s+Shop \(shop\)\n/)
  assert.match(r.out, /Type\s+web\n/)
  assert.match(r.out, /Status\s+live\n/)
  assert.match(r.out, /Health\s+up\n/)
  assert.match(r.out, /Public address\s+internal only\n/)
  assert.match(r.out, /Internal address\s+http:\/\/api:8080\n/)
  assert.match(r.out, /Repository\s+acme\/shop\n/)
  assert.match(r.out, /Branch\s+main\n/)
  assert.match(r.out, /Resources\s+512 MB · 1 CPU · 10 GB disk\n/)

  r = await run(['services', 'info', 'shop/admin'])
  assert.match(r.out, /Public address\s+https:\/\/shop-admin\.rivervo\.app\n/)
  assert.match(r.out, /Domains\s+admin\.shop\.az\n/)

  // A worker: neither address.
  r = await run(['services', 'info', 'shop/worker'])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out, /address/)

  // The app from RIVERVO_APP, like every command; --json prints the API's data.
  r = await run(['services', 'info', '--json'], { env: { RIVERVO_APP: '10' } })
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).internal_url, 'http://api:8080')
})

test('set-public off: asks in a terminal (Enter is no), refuses without one unless --yes', async () => {
  // No terminal, no --yes: refused, nothing sent.
  let r = await run(['services', 'set-public', 'shop/web', 'off'])
  assert.equal(r.code, 1)
  assert.match(r.err, /Making shop\/web internal only removes its public address https:\/\/shopx\.rivervo\.app/)
  assert.match(r.err, /Pass --yes/)
  assert.equal(puts().length, 0)

  // A terminal: Enter means no.
  r = await run(['services', 'set-public', 'shop/web', 'off'], { tty: true, prompt: '\n' })
  assert.equal(r.code, 1)
  assert.match(r.asked[0], /^Make shop\/web internal only\? It loses its public address https:\/\/shopx\.rivervo\.app; only the application's other services reach it, at http:\/\/web:8080\. \[y\/N\] $/)
  assert.match(r.err, /Nothing changed/)
  assert.equal(puts().length, 0)

  // y: switched.
  r = await run(['services', 'set-public', 'shop/web', 'internal'], { tty: true, prompt: 'y' })
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(puts()[0].body), { public: false })
  assert.equal(puts()[0].url, '/api/v1/apps/7/public')
  assert.equal(r.out, 'shop/web is now internal only. Other services of the application reach it at http://web:8080.\n')

  // --yes / -y: no question, also without a terminal.
  for (const flag of ['--yes', '-y']) {
    requests = []
    r = await run(['services', 'set-public', 'shop/web', 'false', flag], { prompt: 'n' })
    assert.equal(r.code, 0, r.err)
    assert.equal(r.asked.length, 0)
    assert.deepEqual(JSON.parse(puts()[0].body), { public: false })
  }

  // Not applied on the server now: said so.
  answer.applied = false
  r = await run(['services', 'set-public', 'shop/web', 'off', '--yes'])
  assert.equal(r.out, 'shop/web is now internal only. Other services of the application reach it at http://web:8080. It is applied with its next deploy.\n')
})

test('set-public on: no question; on|true|public; the app from the link or RIVERVO_APP; --json', async () => {
  let r = await run(['services', 'set-public', 'shop/api', 'on'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(puts()[0].body), { public: true })
  assert.equal(r.out, 'shop/api now has a public address: https://shop-api.rivervo.app\n')
  answer.applied = false
  r = await run(['services', 'set-public', 'shop/api', 'on'])
  assert.equal(r.out, 'shop/api now has a public address: https://shop-api.rivervo.app\nIt is applied with its next deploy.\n')
  answer.applied = true

  requests = []
  r = await run(['services', 'set-public', 'public'], { env: { RIVERVO_APP: 'shop/api' } })
  assert.equal(r.code, 0, r.err)
  assert.equal(puts()[0].url, '/api/v1/apps/10/public')

  requests = []
  r = await run(['services', 'set-public', 'shop/api', 'true', '--json'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(Object.keys(JSON.parse(r.out)).sort(), ['applied', 'data'])

  r = await run(['services', 'set-public', 'shop/api', 'maybe'])
  assert.equal(r.code, 1)
  assert.match(r.err, /Not on or off: maybe/)
  r = await run(['services', 'set-public'])
  assert.equal(r.code, 1)
  assert.match(r.err, /^Usage: rivervo services set-public/)
})

test('set-public: the API\'s refusals (domains, not a web service, the role) exit 1 with its message once', async () => {
  let r = await run(['services', 'set-public', 'shop/admin', 'off', '--yes'])
  assert.equal(r.code, 1)
  assert.equal(r.err, 'Remove the custom domains of this service first: an internal-only service has no domains.\n')

  r = await run(['services', 'set-public', 'shop/worker', 'on'])
  assert.equal(r.code, 1)
  assert.equal(r.err, 'Only a web service has a public address.\n')

  answer.role = 'developer'
  r = await run(['services', 'set-public', 'shop/api', 'on'])
  assert.equal(r.code, 1)
  assert.match(r.err, /Your role in this application does not allow this\.\n\(This needs the Administrator role in the application; yours is developer\.\)/)
})

test('open: an internal-only service has no public address; its internal one is shown', async () => {
  let r = await run(['open', 'shop/api'])
  assert.equal(r.code, 1)
  assert.equal(r.out, '')
  assert.equal(r.err, 'shop/api is internal only: it has no public address. Other services of the application reach it at http://api:8080.\n')
  r = await run(['open', 'shop/web'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'https://shopx.rivervo.app\n')
})

after(async () => { if (home) await rm(home, { recursive: true, force: true }) })
