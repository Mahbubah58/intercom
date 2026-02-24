/**
 * TracScope – Swap Analytics Tracker
 * Subscribes to the Intercom sidechannel and aggregates swap/RFQ events
 * into an in-memory store that the dashboard reads from.
 *
 * Usage (Pear runtime only):
 *   pear run . store1
 *
 * The tracker auto-starts when index.js boots. You can also require it
 * directly in tests: const tracker = require('./tracker')
 */

'use strict'

// ─── Constants ────────────────────────────────────────────────────────────────

const TRACKER_VERSION = '1.0.0'

// Event types emitted by IntercomSwap over the sidechannel
const EV = {
  RFQ_REQUEST:  'rfq_request',   // peer requests a quote
  RFQ_RESPONSE: 'rfq_response',  // market-maker responds
  RFQ_ACCEPT:   'rfq_accept',    // requester accepts quote
  RFQ_REJECT:   'rfq_reject',    // requester rejects quote
  SWAP_INIT:    'swap_init',     // HTLC initiated
  SWAP_SETTLE:  'swap_settle',   // HTLC settled (success)
  SWAP_REFUND:  'swap_refund',   // HTLC expired / refunded
  PEER_HELLO:   'peer_hello',    // peer announces itself
}

// How long to keep per-minute buckets (rolling window)
const ROLLING_MINUTES = 60

// ─── In-memory state ──────────────────────────────────────────────────────────

/**
 * All aggregated analytics live here.
 * The dashboard reads this object directly (same process) or via the
 * local HTTP/WebSocket bridge in index.js.
 */
const state = {
  startedAt: Date.now(),
  version: TRACKER_VERSION,

  peers: new Map(),       // peerId → { firstSeen, lastSeen, rfqs, swaps }
  swaps: [],              // last 500 completed swaps (ring buffer)
  rfqs: [],               // last 500 RFQ events

  totals: {
    rfqRequests:  0,
    rfqAccepted:  0,
    rfqRejected:  0,
    swapsSuccess: 0,
    swapsRefund:  0,
    volumeBtcSats: 0n,     // BigInt – satoshis
    volumeUsdtMicro: 0n,   // BigInt – USDT * 1_000_000
  },

  // Rolling 1-min buckets for sparkline charts
  minuteBuckets: [],      // [{ ts, swaps, volumeSats }]  – newest last

  // Live peer set (active in last 5 min)
  activePeers: new Set(),
}

// ─── Ring-buffer helper ────────────────────────────────────────────────────────

function pushRing(arr, item, maxLen = 500) {
  arr.push(item)
  if (arr.length > maxLen) arr.shift()
}

// ─── Bucket helpers ───────────────────────────────────────────────────────────

function currentMinute() {
  return Math.floor(Date.now() / 60_000) * 60_000
}

function getOrCreateBucket(ts = currentMinute()) {
  const last = state.minuteBuckets[state.minuteBuckets.length - 1]
  if (last && last.ts === ts) return last
  const bucket = { ts, swaps: 0, rfqs: 0, volumeSats: 0n }
  state.minuteBuckets.push(bucket)
  // Keep only ROLLING_MINUTES buckets
  if (state.minuteBuckets.length > ROLLING_MINUTES) {
    state.minuteBuckets.shift()
  }
  return bucket
}

// ─── Peer tracking ────────────────────────────────────────────────────────────

function touchPeer(peerId) {
  const now = Date.now()
  if (!state.peers.has(peerId)) {
    state.peers.set(peerId, { firstSeen: now, lastSeen: now, rfqs: 0, swaps: 0 })
  } else {
    state.peers.get(peerId).lastSeen = now
  }
  state.activePeers.add(peerId)
  // Expire peers not seen in 5 min
  for (const [id, p] of state.activePeers) {
    if (now - state.peers.get(id)?.lastSeen > 5 * 60_000) {
      state.activePeers.delete(id)
    }
  }
  return state.peers.get(peerId)
}

// ─── Event handlers ───────────────────────────────────────────────────────────

const handlers = {
  [EV.PEER_HELLO](msg) {
    touchPeer(msg.peerId)
  },

  [EV.RFQ_REQUEST](msg) {
    const peer = touchPeer(msg.peerId)
    peer.rfqs++
    state.totals.rfqRequests++
    getOrCreateBucket().rfqs++
    pushRing(state.rfqs, {
      ts: msg.ts || Date.now(),
      peerId: msg.peerId,
      type: 'request',
      amountSats: BigInt(msg.amountSats || 0),
      pair: msg.pair || 'BTC/USDT',
    })
  },

  [EV.RFQ_RESPONSE](msg) {
    touchPeer(msg.peerId)
    pushRing(state.rfqs, {
      ts: msg.ts || Date.now(),
      peerId: msg.peerId,
      type: 'response',
      quotedRate: msg.quotedRate,
      pair: msg.pair || 'BTC/USDT',
    })
  },

  [EV.RFQ_ACCEPT](msg) {
    touchPeer(msg.peerId)
    state.totals.rfqAccepted++
  },

  [EV.RFQ_REJECT](msg) {
    touchPeer(msg.peerId)
    state.totals.rfqRejected++
  },

  [EV.SWAP_INIT](msg) {
    touchPeer(msg.peerId)
  },

  [EV.SWAP_SETTLE](msg) {
    const peer = touchPeer(msg.peerId)
    peer.swaps++
    state.totals.swapsSuccess++

    const sats = BigInt(msg.amountSats || 0)
    const usdt = BigInt(msg.amountUsdtMicro || 0)
    state.totals.volumeBtcSats   += sats
    state.totals.volumeUsdtMicro += usdt

    const bucket = getOrCreateBucket()
    bucket.swaps++
    bucket.volumeSats += sats

    pushRing(state.swaps, {
      ts:             msg.ts || Date.now(),
      peerId:         msg.peerId,
      amountSats:     sats,
      amountUsdt:     usdt,
      settlementMs:   msg.settlementMs || null,
      txIdLightning:  msg.txIdLightning || null,
      txIdSolana:     msg.txIdSolana    || null,
    })
  },

  [EV.SWAP_REFUND](msg) {
    touchPeer(msg.peerId)
    state.totals.swapsRefund++
  },
}

// ─── Core dispatcher ──────────────────────────────────────────────────────────

/**
 * Feed a raw sidechannel message into the tracker.
 * Call this from your Intercom message handler in index.js:
 *
 *   sidechannel.on('message', (msg) => tracker.ingest(msg))
 *
 * @param {object} msg  Parsed JSON from the sidechannel
 */
function ingest(msg) {
  if (!msg || typeof msg.type !== 'string') return
  const handler = handlers[msg.type]
  if (handler) {
    try {
      handler(msg)
    } catch (err) {
      console.error('[TracScope] handler error for', msg.type, err.message)
    }
  }
}

// ─── Snapshot API (used by dashboard / HTTP bridge) ──────────────────────────

/**
 * Returns a plain JSON-serialisable snapshot of the current analytics state.
 * Converts BigInts to strings so JSON.stringify works.
 */
function snapshot() {
  const fillRate = state.totals.rfqRequests > 0
    ? ((state.totals.rfqAccepted / state.totals.rfqRequests) * 100).toFixed(1)
    : '0.0'

  const topPeers = [...state.peers.entries()]
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => b.swaps - a.swaps)
    .slice(0, 10)

  const recentSwaps = [...state.swaps].reverse().slice(0, 50).map(s => ({
    ...s,
    amountSats:   s.amountSats.toString(),
    amountUsdt:   (Number(s.amountUsdt) / 1_000_000).toFixed(6),
  }))

  return {
    version: TRACKER_VERSION,
    snapshotAt: Date.now(),
    uptimeMs: Date.now() - state.startedAt,

    totals: {
      rfqRequests:   state.totals.rfqRequests,
      rfqAccepted:   state.totals.rfqAccepted,
      rfqRejected:   state.totals.rfqRejected,
      rfqFillRate:   fillRate + '%',
      swapsSuccess:  state.totals.swapsSuccess,
      swapsRefund:   state.totals.swapsRefund,
      volumeBtc:     (Number(state.totals.volumeBtcSats) / 1e8).toFixed(8),
      volumeUsdt:    (Number(state.totals.volumeUsdtMicro) / 1e6).toFixed(2),
    },

    activePeerCount: state.activePeers.size,
    totalPeerCount:  state.peers.size,
    topPeers,
    recentSwaps,

    // Sparkline data – last 60 min, each bucket: { ts, swaps, volumeBtc }
    buckets: state.minuteBuckets.map(b => ({
      ts:         b.ts,
      swaps:      b.swaps,
      rfqs:       b.rfqs,
      volumeBtc:  (Number(b.volumeSats) / 1e8).toFixed(8),
    })),
  }
}

// ─── Demo / simulation mode ───────────────────────────────────────────────────
// When running without a live Intercom node, call startSimulation() to feed
// synthetic events so the dashboard has data to display.

let _simInterval = null

function startSimulation() {
  if (_simInterval) return
  console.log('[TracScope] Simulation mode active – generating synthetic events')

  const peers = ['peer_alice', 'peer_bob', 'peer_carol', 'peer_dave', 'peer_eve']

  function randomPeer() { return peers[Math.floor(Math.random() * peers.length)] }
  function randomSats() { return Math.floor(Math.random() * 500_000) + 10_000 }

  // Seed some history
  for (let i = 0; i < 40; i++) {
    ingest({ type: EV.PEER_HELLO,    peerId: randomPeer() })
    ingest({ type: EV.RFQ_REQUEST,   peerId: randomPeer(), amountSats: randomSats(), pair: 'BTC/USDT' })
    ingest({ type: EV.RFQ_RESPONSE,  peerId: randomPeer(), quotedRate: (92000 + Math.random() * 2000).toFixed(2) })
    if (Math.random() > 0.25) {
      ingest({ type: EV.RFQ_ACCEPT,  peerId: randomPeer() })
      ingest({ type: EV.SWAP_INIT,   peerId: randomPeer() })
      ingest({
        type: EV.SWAP_SETTLE,
        peerId: randomPeer(),
        amountSats: randomSats(),
        amountUsdtMicro: Math.floor(Math.random() * 50_000_000),
        settlementMs: Math.floor(Math.random() * 8000) + 1200,
      })
    } else {
      ingest({ type: EV.RFQ_REJECT, peerId: randomPeer() })
    }
  }

  // Live trickle
  _simInterval = setInterval(() => {
    const peerId = randomPeer()
    ingest({ type: EV.RFQ_REQUEST, peerId, amountSats: randomSats(), pair: 'BTC/USDT' })
    if (Math.random() > 0.3) {
      ingest({ type: EV.RFQ_ACCEPT, peerId })
      ingest({
        type: EV.SWAP_SETTLE,
        peerId,
        amountSats: randomSats(),
        amountUsdtMicro: Math.floor(Math.random() * 50_000_000),
        settlementMs: Math.floor(Math.random() * 8000) + 1200,
      })
    } else {
      ingest({ type: EV.RFQ_REJECT, peerId })
    }
  }, 3000)
}

function stopSimulation() {
  if (_simInterval) { clearInterval(_simInterval); _simInterval = null }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { ingest, snapshot, startSimulation, stopSimulation, EV, state }
