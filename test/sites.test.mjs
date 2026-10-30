// Websites (hosting) from the command line against a mocked Rivervo API (node:test, no network).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { main } from '../bin/rivervo.mjs'

let server
let base
let requests = []

const SITES = [
  { id: 12, domain: 'shop.az', package: { name: 'Rapids' }, end_date: 'Dec 1, 2026', suspended: false, is_pending: false, is_expired: false },
  { id: 13, domain: 'blog.az', package: { name: 'Stream' }, end_date: 'Jan 5, 2027', suspended: true, is_pending: false, is_expired: false },
]

function route (req, body) {
  const url = new URL(req.url, base)
  const p = url.pathname.replace(/^\/api\/v1/, '')
  if (req.headers.authorization !== 'Bearer good-token') return [401, { message: 'Unauthenticated.' }]
  const key = `${req.method} ${p}`
  if (key === 'GET /hosting/list') return [200, { data: SITES }]
  if (key === 'POST /hosting/12/access/exec') return [200, { data: { exit: body.command === 'false' ? 1 : 0, timed_out: false, seconds: 0.2, output: `ran: ${body.command} in ${body.cwd ?? '~'}\n` } }]
  if (key === 'GET /hosting/12/access/dns/records') return [200, { data: { zone: url.searchParams.get('zone'), serial: '2026103001', records: [
    { line: 1, type: 'SOA', name: 'shop.az.', ttl: 3600, data: ['ns1', 'host', '2026103001'], locked: true },
    { line: 2, type: 'A', name: 'shop.az.', ttl: 14400, data: ['5.9.109.7'], locked: false },
  ] } }]
  if (key === 'PUT /hosting/12/access/dns/records') return [200, { data: {} }]
  if (key === 'GET /hosting/12/databases') return [200, { data: { databases: [{ name: 'shop_wp', size: 3 * 1048576, users: ['shop_u'] }], users: [] } }]
  if (key === 'POST /hosting/12/databases') return [200, { data: { database: `shop_${body.name}` } }]
  if (key === 'GET /hosting/12/cron') return [200, { data: { jobs: [] } }]
  return [404, { message: 'Not Found' }]
}

before(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      requests.push({ method: req.method, url: req.url, body })
      const [status, data] = route(req, body)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())
beforeEach(() => { requests = [] })

async function run (args) {
  let out = ''
  let err = ''
  const code = await main(args, { out: s => { out += s }, err: s => { err += s }, env: { RIVERVO_TOKEN: 'good-token', RIVERVO_API_URL: `${base}/api/v1`, HOME: '/nonexistent' } })
  return { code, out, err }
}

test('sites lists the websites with their status', async () => {
  const r = await run(['sites'])
  assert.equal(r.code, 0)
  assert.match(r.out, /12\s+shop\.az\s+Rapids\s+active/)
  assert.match(r.out, /13\s+blog\.az\s+Stream\s+suspended/)
})

test('run finds the website by domain or id and exits with the command\'s code', async () => {
  const ok = await run(['run', 'shop.az', '--cwd', 'public_html', '--', 'wp', 'core', 'version'])
  assert.equal(ok.code, 0)
  assert.equal(ok.out, 'ran: wp core version in public_html\n')
  assert.deepEqual(requests.at(-1).body, { command: 'wp core version', cwd: 'public_html' })
  assert.equal((await run(['run', '12', '--', 'false'])).code, 1)
  const missing = await run(['run', 'nope.az', '--', 'ls'])
  assert.equal(missing.code, 1)
  assert.match(missing.err, /No website «nope\.az»/)
})

test('dns ls shows the records people edit; dns add sends the zone\'s serial', async () => {
  const ls = await run(['dns', 'ls', 'shop.az'])
  assert.equal(ls.code, 0)
  assert.match(ls.out, /A\s+shop\.az\.\s+14400\s+5\.9\.109\.7/)
  assert.doesNotMatch(ls.out, /SOA/)
  const add = await run(['dns', 'add', 'shop.az', 'shop.az', 'mx', '@', '10', 'mail.example.com.'])
  assert.equal(add.code, 0)
  const put = requests.find(q => q.method === 'PUT')
  assert.deepEqual(put.body, { zone: 'shop.az', serial: '2026103001', add: [{ type: 'MX', name: '@', data: ['10', 'mail.example.com.'] }], edit: [], remove: [] })
})

test('db ls and db create', async () => {
  const ls = await run(['db', 'ls', 'shop.az'])
  assert.match(ls.out, /shop_wp\s+3\s+shop_u/)
  const c = await run(['db', 'create', 'shop.az', 'blog'])
  assert.equal(c.out, 'Created: shop_blog\n')
})

test('api calls any operation and prints its JSON', async () => {
  const r = await run(['api', 'get', '/hosting/12/cron'])
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.out), { data: { jobs: [] } })
  assert.equal((await run(['api', 'FETCH', '/x'])).code, 1)
})
