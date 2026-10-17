// Applications (the API from stage 4): the flat list of services with their application, application/service
// addressing, .rivervo links, shared variables and usage — against a mocked API (node:test, no network).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, flatten, label } from '../bin/rivervo.mjs'

const SHOP = { id: 3, slug: 'shop', name: 'Shop' }
const BLOG = { id: 4, slug: 'blog', name: 'Blog' }
// GET /apps: every service flat, each with its application (the first service still lists the others).
const SERVICES = [
  { id: 20, name: 'Blog', slug: 'blogx', type: 'web', status: 'live', url: 'https://blogx.rivervo.app', project: BLOG, services: [{ id: 21, name: 'db', type: 'mysql' }] },
  { id: 21, name: 'db', slug: 'blogx-db', type: 'mysql', status: 'live', url: null, project: BLOG, services: [] },
  { id: 7, name: 'web', slug: 'shopx', type: 'web', status: 'live', url: 'https://shopx.rivervo.app', project: SHOP, services: [{ id: 8, name: 'worker', type: 'worker' }, { id: 9, name: 'db', type: 'postgres' }] },
  { id: 8, name: 'worker', slug: 'shopx-worker', type: 'worker', status: 'live', health: 'down', url: null, project: SHOP, services: [] },
  { id: 9, name: 'db', slug: 'shopx-db', type: 'postgres', status: 'live', url: null, project: SHOP, services: [] },
]
const PROJECTS = [
  { ...BLOG, status: 'active', services: [{ id: 20, name: 'Blog', type: 'web', status: 'live', address: 'blogx.rivervo.app' }, { id: 21, name: 'db', type: 'mysql', status: 'live', address: null }] },
  { ...SHOP, status: 'active', services: [{ id: 7, name: 'web', type: 'web', status: 'live', address: 'shopx.rivervo.app' }, { id: 8, name: 'worker', type: 'worker', status: 'live', health_status: 'down', address: null }, { id: 9, name: 'db', type: 'postgres', status: 'live', address: null }] },
]

let server, base, home, requests, shared
beforeEach(async () => {
  requests = []
  shared = [{ key: 'APP_KEY', value: 'base64:x', target: 'all' }]
  home = await mkdtemp(join(tmpdir(), 'rivervo-apps-'))
})

function route (req, body, url) {
  const p = url.pathname.replace(/^\/api\/v1/, '')
  const key = `${req.method} ${p}`
  if (key === 'GET /apps') return [200, { data: SERVICES }]
  if (key === 'GET /apps/projects') return [200, { data: PROJECTS }]
  if (/^POST \/apps\/\d+\/deployments$/.test(key)) return [202, { data: { id: 100, status: 'queued', steps: [] } }]
  if (key === 'GET /apps/projects/3/env') return [200, { data: shared, targets: ['all', 'production', 'preview'] }]
  if (key === 'PATCH /apps/projects/3/env') {
    const b = JSON.parse(body)
    for (const [k, v] of Object.entries(b.set ?? {})) shared.push({ key: k, value: v, target: b.target ?? 'all' })
    shared = shared.filter(v => !(b.unset ?? []).includes(v.key))
    return [200, { data: shared, applies: 'next_deployment' }]
  }
  if (key === 'GET /apps/projects/3/usage') {
    return [200, { data: {
      month: url.searchParams.get('month') ?? '2026-10', currency: 'USD', spent_cents: 1234, forecast_cents: 2000,
      billing: { status: 'active', next_payment_at: '2026-11-05T00:00:00+00:00', next_payment_estimate_cents: 1700 },
      lines: [{ kind: 'service', service_id: 7, name: 'web', resources_label: '512 MB · 1 CPU', spent_cents: 900, forecast_cents: 1500 }, { kind: 'traffic', spent_cents: 0, forecast_cents: 0 }],
      limit: { limit_cents: 5000, on_limit: 'notify', pct: 40, extra_held: false },
    } }]
  }
  if (key === 'GET /apps/projects/4/usage') return [403, { message: 'Your role in this application does not allow this.', reason: 'forbidden', role: 'developer', needs: 'money' }]
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

async function run (argv, { cwd = home, env = {} } = {}) {
  let out = ''
  let err = ''
  const code = await main(argv, {
    out: s => { out += s }, err: s => { err += s }, cwd,
    env: { XDG_CONFIG_HOME: home, RIVERVO_POLL_MS: '1', RIVERVO_NO_BROWSER: '1', RIVERVO_API_URL: `${base}/api/v1`, RIVERVO_TOKEN: 'good-token', ...env },
  })
  return { code, out, err }
}

const deployedTo = () => requests.find(q => q.method === 'POST')?.url.match(/apps\/(\d+)\/deployments/)?.[1]

test('flatten: the API from 1.2 (flat, with project) and an older one (main apps with services)', () => {
  const flat = flatten(SERVICES)
  assert.deepEqual(flat.map(s => s.id), [20, 21, 7, 8, 9])
  assert.equal(label(flat.find(s => s.id === 8)), 'shop/worker')
  const old = flatten([{ id: 7, name: 'Shop', slug: 'shop', services: [{ id: 8, name: 'worker', type: 'worker' }] }])
  assert.deepEqual(old.map(s => [s.id, s.project.slug, s.project.id]), [[7, 'shop', null], [8, 'shop', null]])
  assert.equal(label(old[1]), 'worker')
})

test('apps: applications with their services, addressed as application/service', async () => {
  const r = await run(['apps'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^APPLICATION \/ SERVICE\s+ID\s+TYPE\s+STATUS\s+URL/)
  assert.match(r.out, /\nshop {2}\(Shop\)\n/)
  assert.match(r.out, / {2}shop\/web\s+7\s+web\s+live\s+https:\/\/shopx\.rivervo\.app/)
  assert.match(r.out, / {2}shop\/worker\s+8\s+worker\s+live \(down\)/)
  assert.ok(r.out.indexOf('blog  (Blog)') < r.out.indexOf('shop  (Shop)'))
  assert.equal(requests[0].url, '/api/v1/apps/projects')
})

test('addressing: application/service, a service id, an address, an application with one code service', async () => {
  const cases = [['shop/worker', '8'], ['Shop/DB', '9'], ['shop/9', '9'], ['8', '8'], ['shopx', '7'], ['https://shopx.rivervo.app', '7'], ['blog', '20'], ['worker', '8']]
  for (const [ref, id] of cases) {
    requests = []
    const r = await run(['deploy', ref, '--detach'])
    assert.equal(r.code, 0, `${ref}: ${r.err}`)
    assert.equal(deployedTo(), id, ref)
  }
  let r = await run(['deploy', 'shop/worker', '--detach'])
  assert.match(r.out, /Building and deploying shop\/worker/)

  // Several code services: the list to choose from.
  r = await run(['deploy', 'shop'])
  assert.equal(r.code, 1)
  assert.match(r.err, /Shop has several code services; say which one:/)
  assert.match(r.err, /shop\/web\s+7/)
  assert.match(r.err, /shop\/worker\s+8/)
  // A name in two applications, an unknown service, an unknown application.
  r = await run(['deploy', 'db'])
  assert.match(r.err, /matches more than one/)
  r = await run(['deploy', 'shop/nope'])
  assert.match(r.err, /Shop has no service “nope”/)
  r = await run(['deploy', 'nope/web'])
  assert.match(r.err, /No application “nope”/)
  // Nothing given and more than one: which one.
  r = await run(['deploy'])
  assert.match(r.err, /Which app\? Give it as application\/service/)
})

test('link: .rivervo {project, service} here and below; an older {app} file is read too; unlink', async () => {
  let r = await run(['link', 'shop/worker'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(await readFile(join(home, '.rivervo'), 'utf8')), { project: 3, service: 8 })
  assert.match(r.out, /Linked .* to shop\/worker \(service 8\)/)

  const sub = join(home, 'src', 'deep')
  await mkdir(sub, { recursive: true })
  requests = []
  r = await run(['deploy', '--detach'], { cwd: sub })
  assert.equal(r.code, 0, r.err)
  assert.equal(deployedTo(), '8')
  // An explicit app still wins.
  requests = []
  await run(['deploy', 'shop/web', '--detach'], { cwd: sub })
  assert.equal(deployedTo(), '7')
  // The linked application for --shared and usage.
  r = await run(['usage'], { cwd: sub })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^Shop \(shop\)/)

  await writeFile(join(home, '.rivervo'), JSON.stringify({ app: 9 }))
  requests = []
  await run(['deploy', '--detach'], { cwd: sub })
  assert.equal(deployedTo(), '9')

  await writeFile(join(home, '.rivervo'), JSON.stringify({ project: 3, service: 999 }))
  r = await run(['deploy'], { cwd: sub })
  assert.equal(r.code, 1)
  assert.match(r.err, /linked to service 999, which is not in this account/)

  r = await run(['unlink'], { cwd: sub })
  assert.equal(r.code, 1)
  assert.match(r.err, /uses .*\.rivervo/)
  r = await run(['unlink'])
  assert.equal(r.code, 0, r.err)
  await assert.rejects(readFile(join(home, '.rivervo')))
  r = await run(['unlink'])
  assert.match(r.err, /not linked/)

  // A bare application with one code service links to it.
  r = await run(['link', 'blog'])
  assert.deepEqual(JSON.parse(await readFile(join(home, '.rivervo'), 'utf8')), { project: 4, service: 20 })
})

test('env --shared: the application\'s shared variables', async () => {
  let r = await run(['env', 'ls', '--shared', 'shop'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /APP_KEY\s+••••••\s+all/)
  r = await run(['env', 'set', '--shared', 'shop/worker', 'API_URL=https://x', '--target', 'production'])
  assert.equal(r.code, 0, r.err)
  assert.equal(requests.at(-1).url, '/api/v1/apps/projects/3/env')
  assert.deepEqual(JSON.parse(requests.at(-1).body), { set: { API_URL: 'https://x' }, target: 'production' })
  assert.match(r.out, /shared variables of shop\. Each service gets them with its next deploy: rivervo deploy shop\/<service> --no-build/)
  r = await run(['env', 'rm', '--shared', 'shop', 'API_URL'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(requests.at(-1).body), { unset: ['API_URL'] })
  r = await run(['env', 'ls', '--shared', 'shop', '--reveal'])
  assert.match(r.out, /APP_KEY\s+base64:x\s+all/)
  assert.doesNotMatch(r.out, /API_URL/)
})

test('usage: spent, forecast, next payment and the limit; others get the API\'s message', async () => {
  let r = await run(['usage', 'shop', '--month', '2026-09'])
  assert.equal(r.code, 0, r.err)
  assert.match(requests.at(-1).url, /\/apps\/projects\/3\/usage\?month=2026-09/)
  assert.match(r.out, /Shop \(shop\) — 2026-09, USD without tax/)
  assert.match(r.out, /Spent so far\s+\$12\.34/)
  assert.match(r.out, /Forecast for the month\s+\$20\.00/)
  assert.match(r.out, /Next payment\s+\$17\.00 on 2026-11-05/)
  assert.match(r.out, /Spending limit\s+\$50\.00 \(40% of it forecast, notify\)/)
  assert.match(r.out, /web \(512 MB · 1 CPU\)\s+\$9\.00\s+\$15\.00/)

  r = await run(['usage', 'blog'])
  assert.equal(r.code, 1)
  assert.match(r.err, /does not allow this/)
})

after(async () => { if (home) await rm(home, { recursive: true, force: true }) })
