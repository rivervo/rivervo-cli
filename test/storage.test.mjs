// Moving files into object storage (the API from 1.4): storage ls, storage import (keys from the environment or asked,
// never flags; a question before starting), status with --watch, pause / resume / abort / stop-gradual — against a
// mocked API (node:test, no network).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, importLine } from '../bin/rivervo.mjs'

const SHOP = { id: 3, slug: 'shop', name: 'Shop' }
const SERVICES = [
  { id: 7, name: 'web', slug: 'shopx', type: 'web', status: 'live', url: 'https://shopx.rivervo.app', public: true, project: SHOP, services: [] },
  { id: 9, name: 'db', slug: 'shopx-db', type: 'postgres', status: 'live', url: null, project: SHOP, services: [] },
]
const BUCKETS = [{ id: 21, name: 'media', bucket: 'rv-7-media-abc', status: 'active', size_bytes: 2147483648, read_only: false }]
const imp = (over = {}) => ({
  id: 5, mode: 'copy', provider: 's3', status: 'running', held: null, source: { bucket: 'old', region: 'eu-central-1', endpoint: null, prefix: null }, overwrite: false,
  progress: { objects: 1000, transferred: 250, skipped: 10, failed: 0, percent: 26, bytes: null }, can: { pause: true, resume: false, abort: true, stop: false, logs: true }, ...over,
})

let server, base, home, requests, state
beforeEach(async () => {
  requests = []
  state = { copy: null, gradual: null, refuse: null, polls: [] }
  home = await mkdtemp(join(tmpdir(), 'rivervo-storage-'))
})

function route (req, body, url) {
  const p = url.pathname.replace(/^\/api\/v1/, '')
  const key = `${req.method} ${p}`
  if (key === 'GET /apps') return [200, { data: SERVICES }]
  if (key === 'GET /apps/7/storage') return [200, { enabled: true, data: BUCKETS }]
  if (key === 'GET /apps/7/storage/21/import') {
    if (state.polls.length) state.copy = state.polls.shift()
    return [200, { data: { copy: state.copy, gradual: state.gradual, history: [] }, refusal: null, offered: {} }]
  }
  if (key === 'POST /apps/7/storage/21/import') {
    if (state.refuse) return [422, state.refuse]
    const b = JSON.parse(body)
    const made = b.mode === 'copy' ? imp({ overwrite: b.overwrite }) : imp({ mode: 'gradual', status: 'on', progress: null })
    if (b.mode === 'copy') state.copy = made
    else state.gradual = made
    return [201, { data: made }]
  }
  const ctl = /^POST \/apps\/7\/storage\/21\/import\/5\/(pause|resume|abort|stop)$/.exec(key)
  if (ctl) return [200, { data: imp({ status: { pause: 'paused', resume: 'running', abort: 'aborted', stop: 'off' }[ctl[1]], mode: ctl[1] === 'stop' ? 'gradual' : 'copy' }) }]
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

async function run (argv, { tty = false, answers = [], env = {} } = {}) {
  let out = ''
  let err = ''
  const asked = []
  const code = await main(argv, {
    out: s => { out += s }, err: s => { err += s }, cwd: home, isTTY: tty,
    prompt: async q => { asked.push(q); return answers.shift() ?? '' },
    env: { XDG_CONFIG_HOME: home, RIVERVO_POLL_MS: '1', RIVERVO_NO_BROWSER: '1', RIVERVO_API_URL: `${base}/api/v1`, RIVERVO_TOKEN: 'good-token', ...env },
  })
  return { code, out, err, asked }
}
const posts = () => requests.filter(q => q.method === 'POST')
const KEYS = { RIVERVO_IMPORT_ACCESS_KEY_ID: 'AKIAOLD', RIVERVO_IMPORT_SECRET_ACCESS_KEY: 'oldSecret' }

test('storage ls: the buckets of the application; an unknown bucket names the ones there are', async () => {
  const r = await run(['storage', 'ls', 'shop'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^BUCKET\s+ID\s+STATUS\s+SIZE\n/)
  assert.match(r.out, /media\s+21\s+active\s+2 GB/)
  const bad = await run(['storage', 'import', 'status', 'shop', 'nope'])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /No bucket “nope”.*Its buckets: media/)
})

test('copy with keys from the environment: asks before starting, sends what the API takes', async () => {
  const r = await run(['storage', 'import', 'shop', 'media', '--mode', 'copy', '--provider', 's3', '--source-bucket', 'old', '--region', 'eu-central-1', '--prefix', 'photos/'], { tty: true, answers: ['y'], env: KEYS })
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(r.asked, ['Start? [y/N] '])
  assert.match(r.out, /Copy everything from Amazon S3 old\/photos\/ into media of shop \(files already there are kept\)\./)
  assert.match(r.out, /No fee for the move itself/)
  assert.match(r.out, /rivervo storage import status shop media --watch/)
  const sent = JSON.parse(posts()[0].body)
  assert.deepEqual(sent, { mode: 'copy', provider: 's3', bucket: 'old', region: 'eu-central-1', prefix: 'photos/', overwrite: false, access_key_id: 'AKIAOLD', secret_access_key: 'oldSecret' })
  assert.equal(posts()[0].url, '/api/v1/apps/7/storage/21/import')
})

test('no: nothing starts; without a terminal --yes is needed', async () => {
  let r = await run(['storage', 'import', 'shop', 'media', '--mode', 'copy', '--provider', 's3', '--source-bucket', 'old', '--region', 'us-east-1'], { tty: true, answers: ['n'], env: KEYS })
  assert.equal(r.code, 1)
  assert.equal(posts().length, 0)
  r = await run(['storage', 'import', 'shop', 'media', '--mode', 'copy', '--provider', 's3', '--source-bucket', 'old', '--region', 'us-east-1'], { env: KEYS })
  assert.equal(r.code, 1)
  assert.match(r.err, /Pass --yes/)
  assert.equal(posts().length, 0)
  r = await run(['storage', 'import', 'shop', 'media', '--mode', 'copy', '--provider', 's3', '--source-bucket', 'old', '--region', 'us-east-1', '--yes'], { env: KEYS })
  assert.equal(r.code, 0, r.err)
  assert.equal(posts().length, 1)
})

test('keys are never flags; in a terminal they are asked (hidden); without one the environment is needed', async () => {
  let r = await run(['storage', 'import', 'shop', 'media', '--mode', 'copy', '--provider', 's3', '--source-bucket', 'old', '--region', 'us-east-1', '--secret-access-key', 'x', '--yes'])
  assert.equal(r.code, 1)
  assert.match(r.err, /not taken as flags.*shell history/s)
  assert.equal(requests.length, 0)
  r = await run(['storage', 'import', 'shop', 'media', '--mode', 'copy', '--provider', 's3', '--source-bucket', 'old', '--region', 'us-east-1', '--yes'])
  assert.equal(r.code, 1)
  assert.match(r.err, /RIVERVO_IMPORT_ACCESS_KEY_ID/)
  r = await run(['storage', 'import', 'shop', 'media', '--mode', 'gradual', '--provider', 's3-compatible', '--source-bucket', 'old', '--endpoint', 'https://s3.example.com', '--yes'], { tty: true, answers: ['KEYID', 'SECRET'] })
  assert.equal(r.code, 0, r.err)
  assert.match(r.asked[0], /Access key ID/)
  assert.deepEqual(JSON.parse(posts()[0].body), { mode: 'gradual', provider: 's3_compatible', bucket: 'old', endpoint: 'https://s3.example.com', access_key_id: 'KEYID', secret_access_key: 'SECRET' })
  assert.match(r.out, /Gradual moving is on/)
})

test('Google Cloud Storage: the key file from the environment', async () => {
  const file = join(home, 'key.json')
  await writeFile(file, '{"client_email":"a@b.iam.gserviceaccount.com","private_key":"PEM"}')
  const r = await run(['storage', 'import', 'shop', 'media', '--mode', 'copy', '--provider', 'gcs', '--source-bucket', 'old', '--overwrite', '--yes'], { env: { RIVERVO_IMPORT_GCS_KEY_FILE: file } })
  assert.equal(r.code, 0, r.err)
  const sent = JSON.parse(posts()[0].body)
  assert.equal(sent.provider, 'gcs')
  assert.equal(sent.overwrite, true)
  assert.equal(sent.service_account_json, '{"client_email":"a@b.iam.gserviceaccount.com","private_key":"PEM"}')
})

test('refusals come back as the API says them', async () => {
  state.refuse = { message: 'Importing files is not available during the free trial.', reason: 'trial' }
  const r = await run(['storage', 'import', 'shop', 'media', '--mode', 'copy', '--provider', 's3', '--source-bucket', 'old', '--region', 'us-east-1', '--yes'], { env: KEYS })
  assert.equal(r.code, 1)
  assert.match(r.err, /free trial/)
})

test('status and --watch: a progress line as it changes, 0 when done', async () => {
  state.copy = imp()
  let r = await run(['storage', 'import', 'status', 'shop', 'media'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'copy copying 26% — 1,000 found · 250 copied · 10 skipped · 0 not copied\n')
  state.polls = [imp(), imp({ progress: { objects: 1000, transferred: 900, skipped: 10, failed: 0, percent: 91 } }), imp({ status: 'completed', progress: { objects: 1000, transferred: 990, skipped: 10, failed: 0, percent: 100 } })]
  r = await run(['storage', 'import', 'status', 'shop', 'media', '--watch'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out.trim().split('\n').length, 3)
  assert.match(r.out, /copy done 100%/)
  assert.equal(importLine(imp({ mode: 'gradual', status: 'on', progress: null })), 'gradual moving on — from Amazon S3 old')
})

test('pause, resume, abort (asks), stop-gradual (asks)', async () => {
  state.copy = imp()
  state.gradual = imp({ mode: 'gradual', status: 'on', progress: null })
  let r = await run(['storage', 'import', 'pause', 'shop', 'media'])
  assert.equal(r.code, 0, r.err)
  assert.equal(posts().at(-1).url, '/api/v1/apps/7/storage/21/import/5/pause')
  r = await run(['storage', 'import', 'abort', 'shop', 'media'])
  assert.equal(r.code, 1)
  assert.match(r.err, /Pass --yes/)
  r = await run(['storage', 'import', 'abort', 'shop', 'media'], { tty: true, answers: ['y'] })
  assert.equal(r.code, 0, r.err)
  assert.equal(posts().at(-1).url, '/api/v1/apps/7/storage/21/import/5/abort')
  r = await run(['storage', 'import', 'stop-gradual', 'shop', 'media', '--yes'])
  assert.equal(r.code, 0, r.err)
  assert.equal(posts().at(-1).url, '/api/v1/apps/7/storage/21/import/5/stop')
})
