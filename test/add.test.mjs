// rivervo services add: a service added to an existing application after its price is shown and confirmed
// (quote, then the same body with the quote's token) — against a mocked API (node:test, no network).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, priceLine } from '../bin/rivervo.mjs'

const SHOP = { id: 3, slug: 'shop', name: 'Shop' }
const SERVICES = [
  { id: 7, name: 'web', slug: 'shopx', type: 'web', status: 'live', url: 'https://shopx.rivervo.app', public: true, internal_url: 'http://web:8080', project: SHOP, services: [] },
  { id: 8, name: 'worker', slug: 'shopx-worker', type: 'worker', status: 'live', url: null, public: null, internal_url: null, project: SHOP, services: [] },
  { id: 9, name: 'db', slug: 'shopx-db', type: 'postgres', status: 'live', url: null, public: null, internal_url: null, project: SHOP, services: [] },
]
const DEFAULTS = { app: [512, 1, 5], data: [1024, 1, 10], redis: [256, 1, 5], nats: [256, 1, 5], rabbitmq: [1024, 1, 10], kafka: [1024, 1, 10] }
const QUOTE = { monthly_cents_before: 2000, monthly_cents_after: 3200, monthly_delta_cents: 1200, charged_now_cents: 310, currency: 'USD', trial: false, trial_days: 0, state: 'paid', summary: '+$12.00/mo; $3.10 charged now (prorated)' }
const DEARER = { ...QUOTE, monthly_cents_after: 3500, monthly_delta_cents: 1500, charged_now_cents: 400 }

let server, base, home, requests, state
beforeEach(async () => {
  requests = []
  state = { issued: 0, tokens: new Map(), priceChanges: 0, quote: QUOTE }
  home = await mkdtemp(join(tmpdir(), 'rivervo-add-'))
})

// The token is bound to the exact body (as the API's: numbers and numeric strings are the same).
const norm = b => JSON.stringify(Object.keys(b).sort().map(k => [k, typeof b[k] === 'object' ? JSON.stringify(b[k]) : String(b[k])]))
function quote (body) {
  const token = `tk-${++state.issued}`
  state.tokens.set(token, norm(body))
  const kind = ['redis', 'nats', 'rabbitmq', 'kafka'].includes(body.type) ? body.type : ['postgres', 'mysql'].includes(body.type) ? 'data' : 'app'
  const [m, c, d] = DEFAULTS[kind]
  return { quote: state.quote, service: { type: body.type, name: body.name, memory_mb: body.memory_mb ?? m, cpus: body.cpus ?? c, disk_gb: body.disk_gb ?? d }, quote_token: token, expires_at: '2026-10-19T10:10:00+00:00', service_defaults: DEFAULTS }
}

function route (req, body, url) {
  const p = url.pathname.replace(/^\/api\/v1/, '')
  const key = `${req.method} ${p}`
  if (key === 'GET /apps') return [200, { data: SERVICES }]
  if (key === 'POST /apps/projects/3/services/quote') {
    const b = JSON.parse(body)
    if (b.source === 'repo' && b.repo === 'someone/else') return [403, { message: 'Only the account owner can connect another repository.', reason: 'forbidden', needs: 'owner' }]
    return [200, quote(b)]
  }
  if (key === 'POST /apps/projects/3/services') {
    const { quote_token: token, ...b } = JSON.parse(body)
    if (state.priceChanges > 0 || state.tokens.get(token) !== norm(b)) {
      state.priceChanges--
      state.quote = DEARER
      return [422, { message: 'Confirm the price first: ask for a quote and send the same service again with its quote_token.', reason: 'quote_required', ...quote(b) }]
    }
    const id = 12
    const web = b.type === 'web'
    // Kafka is a template: the API answers with a worker made from it.
    if (b.type === 'kafka') return [201, { data: { id, name: b.name, slug: `shop-${b.name}`, type: 'worker', template: 'kafka', status: 'deploying', public: null, url: null, internal_url: null, project: SHOP } }]
    return [201, { data: { id, name: b.name, slug: `shop-${b.name}`, type: b.type, status: 'deploying', public: web ? b.public : null, url: web && b.public ? `https://shop-${b.name}.rivervo.app` : null, internal_url: web ? `http://${b.name}:${b.port ?? 8080}` : null, project: SHOP } }]
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

/** Run the CLI; `answers` are typed into a terminal one by one (there is one only when they are given). */
async function run (argv, { answers, env = {} } = {}) {
  let out = ''
  let err = ''
  const asked = []
  const queue = answers ? [...answers] : null
  const code = await main(argv, {
    out: s => { out += s }, err: s => { err += s }, cwd: home, isTTY: Boolean(queue),
    prompt: queue ? async q => {
      asked.push(q)
      if (!queue.length) throw new Error(`no answer left for: ${q}`)
      return queue.shift()
    } : undefined,
    env: { XDG_CONFIG_HOME: home, RIVERVO_POLL_MS: '1', RIVERVO_NO_BROWSER: '1', RIVERVO_API_URL: `${base}/api/v1`, RIVERVO_TOKEN: 'good-token', ...env },
  })
  return { code, out, err, asked }
}

const posts = path => requests.filter(q => q.method === 'POST' && q.url === `/api/v1/apps/projects/3/${path}`).map(q => JSON.parse(q.body))
const PRICE = 'This adds $12.00 a month to shop (now $20.00 → $32.00); charged now: $3.10 (prorated). Amounts in USD, without tax.'

test('interactive: a web service, internal only, from an image — asked step by step, the price confirmed', async () => {
  const r = await run(['services', 'add', 'shop'], {
    answers: ['1', 'Api', 'api', '', 'internal', '3', 'nginx:1.27', '', '', '1024', '', '', 'y'],
  })
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(r.asked, [
    'Type [1-9]: ',
    'Name (lowercase letters, digits and -, starting with a letter): ',
    'Name (lowercase letters, digits and -, starting with a letter): ',   // «Api» is not a name: asked again
    'A public address, or internal only (reached by the application\'s other services alone)? [public/internal]: ',
    'A public address, or internal only (reached by the application\'s other services alone)? [public/internal]: ', // no default
    'Source [1-3]: ',
    'Image (e.g. nginx:1.27): ',
    'Port it listens on [8080]: ',
    'Command (Enter: the image\'s own): ',
    'Memory, MB [512]: ',
    'CPUs [1]: ',
    'Disk, GB [5]: ',
    'Add the service? [y/N] ',
  ])
  assert.match(r.out, /What kind of service\?\n {2}1\) web/)
  // The defaults come from a first quote; then the full body is quoted, and sent with its token.
  const quotes = posts('services/quote')
  assert.deepEqual(quotes[0], { type: 'web', name: 'api' })
  const full = { type: 'web', name: 'api', public: false, source: 'image', image: 'nginx:1.27', memory_mb: 1024, cpus: 1, disk_gb: 5 }
  assert.deepEqual(quotes[1], full)
  assert.deepEqual(posts('services'), [{ ...full, quote_token: 'tk-2' }])
  assert.match(r.out, new RegExp(PRICE.replace(/[$().→]/g, '\\$&')))
  assert.match(r.out, /Added shop\/api \(service 12\): web service, internal only \(other services of the application reach it at http:\/\/api:8080\)\.\n/)
  assert.match(r.out, /It is starting; follow it with: rivervo logs shop\/api -f\n/)
})

test('interactive: Enter at the confirmation adds nothing', async () => {
  const r = await run(['services', 'add', 'shop', '--type', 'worker', '--name', 'jobs', '--source', 'project', '--command', 'run', '--memory', '256', '--cpus', '1', '--disk', '5'], {
    answers: ['1', ''],
  })
  assert.equal(r.code, 1)
  // Whose code: two code services, so the customer chooses (no default, as in the panel); then only the confirmation.
  assert.deepEqual(r.asked, ['Service [1-2]: ', 'Add the service? [y/N] '])
  assert.match(r.out, /Whose code does it run\?\n {2}1\) web/)
  assert.equal(posts('services/quote')[0].image_from, 7)
  assert.match(r.err, /Nothing added/)
  assert.equal(posts('services').length, 0)
})

test('non-interactive with --yes: the price is printed, then the service is added', async () => {
  let r = await run(['services', 'add', 'shop', '--type', 'worker', '--name', 'jobs', '--source', 'project', '--from', 'worker',
    '--command', 'php artisan queue:work', '--memory', '256', '--var', 'A=1', '--var=B=x=y', '--yes'])
  assert.equal(r.code, 0, r.err)
  const body = { type: 'worker', name: 'jobs', source: 'project', image_from: 8, command: 'php artisan queue:work', vars: [{ key: 'A', value: '1' }, { key: 'B', value: 'x=y' }], memory_mb: 256 }
  assert.deepEqual(posts('services/quote'), [body])   // no defaults asked for: none is needed
  assert.deepEqual(posts('services'), [{ ...body, quote_token: 'tk-1' }])
  assert.ok(r.out.startsWith(PRICE + '\n'), r.out)
  assert.match(r.out, /Added shop\/jobs \(service 12\): background worker\.\nIt is starting; follow it with: rivervo logs shop\/jobs -f\n/)

  // --json: the created service only.
  requests = []
  r = await run(['services', 'add', 'shop/web', '--type', 'web', '--name', 'site', '--public', '--source', 'repo', '--repo', 'acme/site', '--branch', 'main', '--yes', '--json'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(posts('services/quote')[0], { type: 'web', name: 'site', public: true, source: 'repo', repo: 'acme/site', branch: 'main' })
  assert.equal(JSON.parse(r.out).url, 'https://shop-site.rivervo.app')
})

test('non-interactive: a missing flag is named; --public or --internal is required for web; no defaults', async () => {
  let r = await run(['services', 'add', 'shop', '--type', 'web', '--name', 'api', '--source', 'image', '--image', 'nginx', '--yes'])
  assert.equal(r.code, 1)
  assert.match(r.err, /^Missing --public or --internal/)
  assert.equal(requests.filter(q => q.method === 'POST').length, 0)

  r = await run(['services', 'add', 'shop', '--name', 'api', '--yes'])
  assert.match(r.err, /^Missing --type/)
  // Two services with code: whose code must be named (no default, as in the panel).
  r = await run(['services', 'add', 'shop', '--type', 'cron', '--name', 'nightly', '--command', 'php artisan x', '--yes'])
  assert.match(r.err, /^Missing --from \(web, worker\)/)
  r = await run(['services', 'add', 'shop', '--type', 'cron', '--name', 'nightly', '--from', 'web', '--command', 'php artisan x', '--yes'])
  assert.match(r.err, /^Missing --schedule/)
  r = await run(['services', 'add', 'shop', '--type', 'worker', '--name', 'w', '--yes'])
  assert.match(r.err, /^Missing --source/)
  r = await run(['services', 'add', 'shop', '--type', 'web', '--name', 'api', '--public', '--internal'])
  assert.match(r.err, /not both/)
  r = await run(['services', 'add', 'shop', '--type', 'postgres', '--name', 'db2', '--source', 'image'])
  assert.match(r.err, /has no code/)
  assert.equal(requests.filter(q => q.method === 'POST').length, 0)
})

test('non-interactive without --yes: the price, «Pass --yes», exit 1; --json prints the quote', async () => {
  let r = await run(['services', 'add', 'shop', '--type', 'redis', '--name', 'cache'])
  assert.equal(r.code, 1)
  assert.equal(r.out, PRICE + '\n')
  assert.match(r.err, /Pass --yes to add it/)
  assert.equal(posts('services').length, 0)

  r = await run(['services', 'add', 'shop', '--type', 'redis', '--name', 'cache', '--json'])
  assert.equal(r.code, 1)
  assert.match(JSON.parse(r.out).quote_token, /^tk-\d+$/)
})

test('a data service: no source, the kind\'s resources from the API', async () => {
  const r = await run(['services', 'add', 'shop', '--type', 'postgres', '--name', 'db2', '--yes'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(posts('services'), [{ type: 'postgres', name: 'db2', quote_token: 'tk-1' }])
  assert.match(r.out, /Added shop\/db2 \(service 12\): PostgreSQL\.\nIt is starting; rivervo services info shop\/db2 shows its status\.\n/)
})

test('message brokers and the Kafka template: no source, their variables named, their defaults asked', async () => {
  let r = await run(['services', 'add', 'shop', '--type', 'rabbitmq', '--name', 'mq', '--yes'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(posts('services'), [{ type: 'rabbitmq', name: 'mq', quote_token: 'tk-1' }])
  assert.match(r.out, /Added shop\/mq \(service 12\): RabbitMQ\.\nOnly the application's services reach it; they get AMQP_URL and RABBITMQ_\* with their next deploy\.\nIt is starting; rivervo services info shop\/mq shows its status\.\n/)

  r = await run(['services', 'add', 'shop', '--type', 'nats', '--name', 'events', '--source', 'image', '--yes'])
  assert.equal(r.code, 1)
  assert.match(r.err, /A NATS \(JetStream\) service has no code/)

  r = await run(['services', 'add', 'shop', '--type', 'kafka', '--name', 'kafka', '--var', 'KAFKA_NUM_PARTITIONS=3', '--yes'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(posts('services').at(-1), { type: 'kafka', name: 'kafka', vars: [{ key: 'KAFKA_NUM_PARTITIONS', value: '3' }], quote_token: 'tk-2' })
  assert.match(r.out, /Added shop\/kafka \(service 12\): Kafka \(one broker, template\)\.\nOnly the application's services reach it; they get KAFKA_BROKERS with their next deploy\.\n/)

  // In a terminal the kind's defaults come from the API.
  r = await run(['services', 'add', 'shop', '--type', 'nats', '--name', 'events'], { answers: ['', '', '', 'y'] })
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(r.asked.slice(0, 3), ['Memory, MB [256]: ', 'CPUs [1]: ', 'Disk, GB [5]: '])
})

test('quote_required: the new price is shown and asked about again; without a terminal it stops', async () => {
  state.priceChanges = 1
  const flags = ['services', 'add', 'shop', '--type', 'web', '--name', 'api', '--internal', '--source', 'image', '--image', 'nginx:1.27', '--memory', '512', '--cpus', '1', '--disk', '5']
  let r = await run([...flags, '--port', '8080', '--command', 'nginx -g "daemon off;"', '--yes'], { answers: ['y'] })
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(r.asked, ['Add the service? [y/N] '])   // --yes answered the first price, not the new one
  assert.match(r.err, /Confirm the price first/)
  assert.match(r.out, /This adds \$15\.00 a month to shop \(now \$20\.00 → \$35\.00\); charged now: \$4\.00/)
  assert.deepEqual(posts('services').map(b => b.quote_token), ['tk-1', 'tk-2'])

  requests = []
  state = { ...state, priceChanges: 1, quote: QUOTE }
  r = await run([...flags, '--yes'])
  assert.equal(r.code, 1)
  assert.match(r.out, /\$15\.00 a month/)
  assert.match(r.err, /run the command again/)
  assert.equal(posts('services').length, 1)
})

test('403: another repository is the account owner\'s', async () => {
  const r = await run(['services', 'add', 'shop', '--type', 'worker', '--name', 'w', '--source', 'repo', '--repo', 'someone/else', '--yes'])
  assert.equal(r.code, 1)
  assert.equal(r.err, 'Only the account owner can connect another repository.\n(Only the account owner can do this.)\n')
})

test('the price in words: trial, internal, a new subscription', () => {
  const p = { slug: 'shop' }
  assert.equal(priceLine({ ...QUOTE, state: 'trial', charged_now_cents: 0 }, p), 'This adds $12.00 a month to shop (now $20.00 → $32.00); not billed during the trial. Amounts in USD, without tax.')
  assert.equal(priceLine({ ...QUOTE, state: 'internal', charged_now_cents: 0 }, p), 'This adds $12.00 a month to shop (now $20.00 → $32.00), but shop is an internal application: nothing is charged. Amounts in USD, without tax.')
  assert.equal(priceLine({ ...QUOTE, state: 'unpaid', trial: true, trial_days: 3 }, p), 'shop will cost $32.00 a month; the first 3 days are free. Amounts in USD, without tax.')
  assert.equal(priceLine({ ...QUOTE, state: 'other', summary: 'Something new' }, p), 'Something new. Amounts in USD, without tax.')
})

after(async () => { if (home) await rm(home, { recursive: true, force: true }) })
