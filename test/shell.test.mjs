// rivervo shell against a mocked API and a mocked terminal gateway (a tiny WebSocket server here;
// the CLI uses Node's own WebSocket client). node:test, no network.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../bin/rivervo.mjs'

let api, gw, base, wsUrl, home
let requests = []
let script = null   // how the mock gateway behaves for the next session
let seen = []       // what the gateway received: {type: 'json'|'bytes', data}

const APPS = [{ id: 7, name: 'Shop', slug: 'shop', status: 'live', url: 'https://shop.rivervo.app', services: [{ id: 8, name: 'worker', type: 'worker', status: 'live' }] }]

// ── the mock gateway: RFC 6455 framing, server side ──────────────────────
function frame (opcode, payload) {
  const n = payload.length
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
  return Buffer.concat([head, payload])
}
function parser (onFrame) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 2) return
      const op = buf[0] & 15
      let n = buf[1] & 127
      let off = 2
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); off = 4 }
      assert.ok(buf[1] & 0x80, 'the client masks its frames')
      if (buf.length < off + 4 + n) return
      const mask = buf.subarray(off, off + 4)
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + n).map((b, i) => b ^ mask[i & 3]))
      buf = buf.subarray(off + 4 + n)
      onFrame(op, data)
    }
  }
}

before(async () => {
  api = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body, headers: req.headers })
      const p = new URL(req.url, base).pathname.replace(/^\/api\/v1/, '')
      let status = 404
      let json = { message: 'Not found' }
      if (req.headers.authorization !== 'Bearer good-token') [status, json] = [401, { message: 'Unauthenticated.' }]
      else if (req.method === 'GET' && p === '/apps') [status, json] = [200, { data: APPS }]
      else if (req.method === 'POST' && (p === '/apps/7/terminal' || p === '/apps/8/terminal')) {
        const proc = JSON.parse(body || '{}').process
        if (proc === 'w9') [status, json] = [422, { message: 'This process is not running in the service.', reason: 'process' }]
        else [status, json] = [201, { data: { url: wsUrl, ticket: 'tk-1', expires_at: '2026-10-16T10:01:00Z', process: proc } }]
      }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(json))
    })
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${api.address().port}`

  gw = createServer((req, res) => { res.writeHead(426); res.end() })
  gw.on('upgrade', (req, socket) => {
    assert.equal(req.url, '/__rivervo/terminal')
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const send = (op, data) => socket.write(frame(op, Buffer.isBuffer(data) ? data : Buffer.from(data)))
    const json = obj => send(1, JSON.stringify(obj))
    const close = () => { send(8, Buffer.from([3, 232])); socket.end() }
    socket.on('error', () => {})
    socket.on('data', parser((op, data) => {
      if (op === 8) { socket.end(); return }
      if (op === 1) {
        const m = JSON.parse(data)
        seen.push({ type: 'json', data: m })
        if (m.type === 'auth') script.onAuth({ json, send, close, m })
      } else if (op === 2) {
        seen.push({ type: 'bytes', data: data.toString() })
        script.onBytes?.({ json, send, close, data: data.toString() })
      }
    }))
  })
  await new Promise(resolve => gw.listen(0, '127.0.0.1', resolve))
  wsUrl = `ws://127.0.0.1:${gw.address().port}/__rivervo/terminal`
})
after(() => { api.close(); gw.close() })

beforeEach(async () => {
  requests = []
  seen = []
  home = await mkdtemp(join(tmpdir(), 'rivervo-shell-'))
})

function terminal ({ tty = false } = {}) {
  const stdin = new PassThrough()
  stdin.isTTY = tty
  const modes = []
  if (tty) stdin.setRawMode = (on) => { modes.push(on); return stdin }
  const stdout = new PassThrough()
  stdout.columns = 100
  stdout.rows = 30
  let screen = ''
  stdout.on('data', c => { screen += c })
  return { stdin, stdout, modes, screen: () => screen }
}

async function shell (argv, t, more = {}) {
  let err = ''
  const code = await main(argv, {
    out: () => {}, err: s => { err += s }, stdin: t.stdin, stdout: t.stdout,
    env: { XDG_CONFIG_HOME: home, RIVERVO_API_URL: `${base}/api/v1`, RIVERVO_TOKEN: 'good-token' },
    ...more,
  })
  return { code, err }
}

test('a session: ticket for the process, auth with the size, keys both ways, resize, raw mode, the shell\'s exit code', async () => {
  const t = terminal({ tty: true })
  script = {
    onAuth: ({ json, send }) => {
      json({ type: 'ready', idle: 1800, max: 14400 })
      send(2, '$ ')
      setTimeout(() => {
        t.stdin.write('php artisan tinker\r')
        t.stdout.columns = 132
        t.stdout.rows = 40
        t.stdout.emit('resize')
      }, 30)
    },
    onBytes: ({ json, send, close, data }) => {
      if (data.includes('tinker')) { send(2, 'Psy Shell v0.12\r\n> '); setTimeout(() => t.stdin.write('exit\r'), 30) }
      if (data === 'exit\r') { json({ type: 'exit', code: 3 }); close() }
    },
  }
  const r = await shell(['shell', 'shop', '--process', 'w1'], t)
  assert.equal(r.code, 3, r.err)
  const ticketReq = requests.find(q => q.method === 'POST')
  assert.equal(ticketReq.url, '/api/v1/apps/7/terminal')
  assert.deepEqual(JSON.parse(ticketReq.body), { process: 'w1' })
  assert.deepEqual(seen[0], { type: 'json', data: { type: 'auth', ticket: 'tk-1', cols: 100, rows: 30 } })
  assert.ok(seen.some(s => s.type === 'json' && s.data.type === 'resize' && s.data.cols === 132 && s.data.rows === 40))
  assert.ok(seen.some(s => s.type === 'bytes' && s.data === 'php artisan tinker\r'))
  assert.match(t.screen(), /Psy Shell v0\.12/)
  assert.match(r.err, /Connected to Shop \(w1\)/)
  assert.deepEqual(t.modes, [true, false], 'raw while it lasts, restored after')
})

test('input from a pipe: its end ends the shell (Ctrl+D)', async () => {
  const t = terminal()
  script = {
    onAuth: ({ json }) => { json({ type: 'ready', idle: 1800, max: 14400 }); setTimeout(() => t.stdin.end('php -v\n'), 20) },
    onBytes: ({ json, close, data }) => { if (data === '\u0004') { json({ type: 'exit', code: 0 }); close() } },
  }
  const r = await shell(['shell', '--app', 'shop'], t)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(seen.filter(s => s.type === 'bytes').map(s => s.data), ['php -v\n', '\u0004'])
})

test('the gateway\'s refusals and closings are told in plain words', async () => {
  for (const [msg, words] of [
    [{ type: 'error', code: 'limit' }, /Too many terminals are open to this service/],
    [{ type: 'error', code: 'no_shell' }, /no shell to open/],
    [{ type: 'error', code: 'expired' }, /could not start/],
    [{ type: 'closing', reason: 'idle' }, /after 1 minutes without activity/],
  ]) {
    const t = terminal()
    script = {
      onAuth: ({ json, close }) => {
        if (msg.type === 'closing') json({ type: 'ready', idle: 60, max: 600 })
        json(msg)
        close()
      },
    }
    const r = await shell(['shell', '8'], t)
    assert.equal(r.code, 1)
    assert.match(r.err, words)
  }
})

test('a process the service does not run is the API\'s answer; no gateway, no WebSocket', async () => {
  const t = terminal()
  const r = await shell(['shell', 'shop', '--process', 'w9'], t)
  assert.equal(r.code, 1)
  assert.match(r.err, /not running in the service/)
  const noWs = await shell(['shell', 'shop'], terminal(), { WebSocket: null })
  assert.equal(noWs.code, 1)
  assert.match(noWs.err, /needs Node.js 22/)
})

test('a gateway that cannot be reached', async () => {
  const saved = wsUrl
  wsUrl = 'ws://127.0.0.1:9/__rivervo/terminal'
  try {
    const r = await shell(['shell', 'shop'], terminal())
    assert.equal(r.code, 1)
    assert.match(r.err, /could not be established/)
  } finally {
    wsUrl = saved
  }
})
