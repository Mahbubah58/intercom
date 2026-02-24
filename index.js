
/**
 * TracScope – index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pear runtime entry point. Boots an Intercom peer, subscribes to sidechannel
 * events, feeds them into the tracker, and serves the analytics dashboard via
 * a local HTTP server + Server-Sent Events (SSE) stream.
 *
 * Run:  pear run . store1
 *
 * Open the dashboard: http://localhost:7842
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict'

import Pear from 'pear'
import path from 'path'
import fs from 'fs'
import http from 'http'
import { fileURLToPath } from 'url'

// ─── TracScope modules ────────────────────────────────────────────────────────
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const tracker = require('./tracker.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Config ───────────────────────────────────────────────────────────────────
// Replace BOOTSTRAP_KEY with your actual contract writer key after deploying.
const BOOTSTRAP_KEY   = process.env.BOOTSTRAP_KEY   || '__REPLACE_WITH_YOUR_BOOTSTRAP_KEY__'
const CHANNEL_NAME    = process.env.CHANNEL_NAME    || 'tracscope-swap-analytics-v1' // exactly 32 chars
const DASHBOARD_PORT  = parseInt(process.env.PORT   || '7842', 10)
const SIMULATION_MODE = !process.env.BOOTSTRAP_KEY   // auto-enable sim if no key set

// ─── Pear / Intercom bootstrap ────────────────────────────────────────────────

const { storage } = Pear

async function bootIntercom() {
  if (SIMULATION_MODE) {
    console.log('[TracScope] No BOOTSTRAP_KEY set → running in simulation mode')
    console.log('[TracScope] Set env BOOTSTRAP_KEY=<key> to connect to live Intercom')
    tracker.startSimulation()
    return null
  }

  // Dynamically import Intercom peer (provided by the upstream repo)
  // The upstream index.js exports a `createPeer` factory.
  let createPeer
  try {
    ;({ createPeer } = await import('./node_modules/trac-peer/index.js'))
  } catch {
    console.warn('[TracScope] trac-peer not found – falling back to simulation mode')
    tracker.startSimulation()
    return null
  }

  const storeName = process.argv[2] || 'store1'
  const storePath = storage(storeName)

  const peer = await createPeer({
    storePath,
    bootstrapKey: BOOTSTRAP_KEY,
    channel: CHANNEL_NAME,
    // Listen only – TracScope is a read-only observer
    readOnly: true,
  })

  // ── Sidechannel subscription ──────────────────────────────────────────────
  peer.on('sidechannel:message', (raw) => {
    try {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : raw
      tracker.ingest(msg)
    } catch { /* ignore malformed */ }
  })

  // ── Contract state events (optional enrichment) ───────────────────────────
  peer.on('contract:event', (ev) => {
    tracker.ingest(ev)
  })

  peer.on('error', (err) => {
    console.error('[TracScope] Peer error:', err.message)
  })

  console.log(`[TracScope] Connected to Intercom channel: ${CHANNEL_NAME}`)
  console.log(`[TracScope] Peer key: ${peer.writerKey}`)

  return peer
}

// ─── HTTP dashboard server ────────────────────────────────────────────────────

const SSE_CLIENTS = new Set()

function broadcastSnapshot() {
  if (SSE_CLIENTS.size === 0) return
  const data = `data: ${JSON.stringify(tracker.snapshot())}\n\n`
  for (const res of SSE_CLIENTS) {
    try { res.write(data) } catch { SSE_CLIENTS.delete(res) }
  }
}

// Push a fresh snapshot to all SSE clients every 3 seconds
setInterval(broadcastSnapshot, 3000)

function startDashboardServer() {
  const dashboardPath = path.join(__dirname, 'dashboard.html')

  const server = http.createServer((req, res) => {

    // ── SSE endpoint ─────────────────────────────────────────────────────────
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      res.write(': connected\n\n')
      // Send initial snapshot immediately
      res.write(`data: ${JSON.stringify(tracker.snapshot())}\n\n`)
      SSE_CLIENTS.add(res)
      req.on('close', () => SSE_CLIENTS.delete(res))
      return
    }

    // ── Snapshot JSON endpoint ────────────────────────────────────────────────
    if (req.url === '/api/snapshot') {
      const body = JSON.stringify(tracker.snapshot())
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(body)
      return
    }

    // ── Dashboard HTML ────────────────────────────────────────────────────────
    if (req.url === '/' || req.url === '/index.html') {
      fs.readFile(dashboardPath, 'utf8', (err, html) => {
        if (err) {
          res.writeHead(500)
          res.end('Dashboard not found. Make sure dashboard.html is in the same directory.')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    console.log(`[TracScope] Dashboard: http://localhost:${DASHBOARD_PORT}`)
    console.log(`[TracScope] Snapshot API: http://localhost:${DASHBOARD_PORT}/api/snapshot`)
  })

  return server
}

// ─── Main ─────────────────────────────────────────────────────────────────────

;(async () => {
  console.log('┌─────────────────────────────────┐')
  console.log('│  TracScope – Swap Analytics     │')
  console.log('│  Built on Intercom / Trac Net   │')
  console.log('└─────────────────────────────────┘')

  startDashboardServer()
  await bootIntercom()

  console.log('[TracScope] Ready.')
})()

