# TracScope – SKILL.md

Agent-oriented setup, operational guidance, and capability description for the **TracScope** fork of [Intercom](https://github.com/Trac-Systems/intercom).

---

## What TracScope does

TracScope is a **read-only analytics and portfolio dashboard** built on the Intercom P2P stack.

It connects to an Intercom / IntercomSwap contract network as a passive observer peer, subscribes to sidechannel messages, and aggregates them into live swap analytics:

| Metric | Description |
|--------|-------------|
| Swap volume | Total BTC (sats) and USDT settled |
| RFQ fill rate | % of quote requests that result in a settled swap |
| Active peers | Peers seen in the last 5 minutes |
| Per-peer stats | Swap count, RFQ count per peer address |
| Sparkline charts | Rolling 60-minute volume and swap-count buckets |
| Live swap feed | Most recent 20 settled swaps with amounts and peer IDs |

The dashboard is served at `http://localhost:7842` via a local HTTP server. A Server-Sent Events (SSE) endpoint pushes fresh snapshots every 3 seconds.

---

## Runtime requirements

| Requirement | Detail |
|-------------|--------|
| Pear runtime | `npm install -g pear` — see https://pears.com |
| Node.js | ≥ 20 (bundled with Pear) |
| OS | macOS, Linux, Windows |
| Network | Outbound P2P (DHT); no inbound ports required |

---

## Installation

```bash
# 1. Fork this repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/intercom
cd intercom

# 2. Install dependencies
npm install

# 3. Run in simulation mode (no live node needed)
pear run . store1
# → opens dashboard at http://localhost:7842

# 4. Connect to a live Intercom contract network
BOOTSTRAP_KEY=<your-bootstrap-writer-key> pear run . store1
```

---

## First-run decisions (agent checklist)

- [ ] **Simulation vs live?** If `BOOTSTRAP_KEY` env var is not set, TracScope runs in simulation mode and generates synthetic swap events so the dashboard has something to display.
- [ ] **Bootstrap key** — obtain the contract writer key from the network admin (or deploy your own contract following the upstream README). Set it as `BOOTSTRAP_KEY`.
- [ ] **Channel name** — must match the 32-character channel name used by the IntercomSwap deployment. Default: `tracscope-swap-analytics-v1`. Change via `CHANNEL_NAME` env var.
- [ ] **Port** — dashboard defaults to `7842`. Change via `PORT` env var.
- [ ] **Trac address** — add your Trac wallet address to this README under "Trac Address" (required for the competition reward payout).

---

## Architecture overview

```
Intercom sidechannel
       │  (P2P messages: rfq_request, swap_settle, etc.)
       ▼
  tracker.js          ← event ingestion + aggregation
       │  (in-memory state: totals, buckets, peers)
       ▼
   index.js           ← Pear entry point + HTTP server
       │  (SSE /events  +  GET /api/snapshot)
       ▼
 dashboard.html        ← browser UI (canvas charts, live tables)
```

---

## Key files

| File | Purpose |
|------|---------|
| `tracker.js` | Core analytics engine. `ingest(msg)` routes sidechannel events. `snapshot()` returns JSON. |
| `index.js` | Pear entry point. Boots peer, subscribes to sidechannel, runs HTTP server. |
| `dashboard.html` | Self-contained browser dashboard. Connects via SSE. |
| `SKILL.md` | This file. |
| `README.md` | Human-readable project overview + Trac address. |

---

## Tracker event types consumed

TracScope listens for the following message types on the sidechannel. All other message types are silently ignored.

| Type | Trigger |
|------|---------|
| `rfq_request` | Peer requests a swap quote |
| `rfq_response` | Market-maker replies with a rate |
| `rfq_accept` | Requester accepts the quote |
| `rfq_reject` | Requester rejects the quote |
| `swap_init` | HTLC has been initiated |
| `swap_settle` | Swap completed successfully |
| `swap_refund` | HTLC expired; funds refunded |
| `peer_hello` | Peer announces presence |

---

## Snapshot API

`GET http://localhost:7842/api/snapshot` returns:

```json
{
  "version": "1.0.0",
  "snapshotAt": 1700000000000,
  "uptimeMs": 12345,
  "totals": {
    "rfqRequests": 42,
    "rfqAccepted": 36,
    "rfqRejected": 6,
    "rfqFillRate": "85.7%",
    "swapsSuccess": 34,
    "swapsRefund": 2,
    "volumeBtc": "0.12345678",
    "volumeUsdt": "11234.56"
  },
  "activePeerCount": 5,
  "totalPeerCount": 12,
  "topPeers": [ ... ],
  "recentSwaps": [ ... ],
  "buckets": [ { "ts": 1700000000000, "swaps": 3, "rfqs": 4, "volumeBtc": "0.03" }, ... ]
}
```

---

## Adding TracScope to an agent workflow

An agent can:

1. Poll `GET /api/snapshot` for structured analytics data.
2. Use the data to make trading or monitoring decisions.
3. Pipe the `recentSwaps` feed into alerting logic.

Example (agent pseudo-code):
```js
const snap = await fetch('http://localhost:7842/api/snapshot').then(r => r.json())
if (parseFloat(snap.totals.rfqFillRate) < 50) {
  alert('Fill rate dropped below 50%')
}
```

---

## Extending TracScope

- **Add new event types**: Add a handler to `handlers` in `tracker.js` and update this SKILL.md.
- **Persist history**: Replace the in-memory ring buffers with SQLite (better-sqlite3) for historical data across restarts.
- **Portfolio mode**: Pass a Trac address as `MY_ADDRESS` env var; tracker.js will tag swaps where `peerId === MY_ADDRESS` for personal P&L tracking.
- **Alerts**: Add a webhook emitter in tracker.js that POSTs to a URL when volume or fill-rate thresholds are breached.

---

## Trac Address

> **Add your Trac address here** (required for the 500 TNK competition reward):
>
> `YOUR_TRAC_ADDRESS_HERE`

---

## License

MIT
