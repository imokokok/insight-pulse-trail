# Insight Pulse Trail

> Independent, EIP-712-signed, Bitcoin-anchored oracle quality monitoring — running every 15 minutes, zero cost, self-contained, verifiable offline.

## What this is

A **continuous oracle quality trail** for ETH/USD. Every 15 minutes it polls three
independent sources (Chainlink on-chain, CoinGecko API, OKX spot), computes a
median consensus, and emits an EIP-712-signed Pulse JSON with **all raw source
data** so anyone can re-run the scoring rules and get the same numbers.

Weekly it aggregates all Pulse hashes into a single Bitcoin-chain timestamp via
[OpenTimestamps](https://opentimestamps.org), giving every Pulse an **immutable
proof of existence** anchored to the world's most trusted blockchain.

```
Every 15 min    →   Pulse JSON + EIP-712 commit
Every Sunday    →   Aggregate weekly hashes → OTS submit
Every Wednesday →   Fetch BTC confirmations → complete .ots proof
```

**Zero Insight-dependency.** This repo runs entirely on GitHub Actions. It never
calls oracleinsight.xyz, never touches Insight's Cloudflare Workers, and never
uses Insight's database or signing keys.

---

## Quick start — verify a Pulse (clone, one command)

```bash
# 1. Clone
git clone https://github.com/imokokok/insight-pulse-trail.git
cd insight-pulse-trail
npm install   # only viem

# 2. Verify the latest Pulse — re-runs scoring rules + EIP-712 signature locally
node scripts/verify-pulse.mjs pulses/ETH/2026/11/22/1415-ETH.json

# Expected output:
#   ✅ 2/5 Re-running scoring rules on 3 raw sources...
#      consensus=$1679.38  deviation=22bps  agreement=3900bps  score=57
#      ✅ All fields match — Pulse was produced by the documented algorithm
#   ✅ 3/5 Verifying EIP-712 signature...
#      ✅ Signature valid — signed by 0x25cD...3a0 (sample)
#   🎉 VERIFIED
```

That's it. No API keys, no network calls (after clone), no signup.

---

## Quick start — verify the Bitcoin timestamp

```bash
pip install opentimestamps-client

# 1. Fetch BTC confirmations for week N's .ots file
ots upgrade timestamps/2026-W47/week.txt.ots

# 2. Verify locally — confirms the Merkle root exists in a BTC block
ots verify timestamps/2026-W47/week.txt.ots timestamps/2026-W47/week.txt
# → Timestamp verified at block 864211
#   Root 0xabc...def exists in Bitcoin blockchain (2026-11-23 02:17 UTC)
```

Or drag `week.txt.ots` into [opentimestamps.org](https://opentimestamps.org).

---

## Trust boundaries — what this proves and what it doesn't

| Claim | Supported? |
|---|---|
| These 3 sources returned these prices at time T | ✅ — `rawSources[]` records every sampled value + `sampledAt` timestamp |
| The consensus = median(rawSources) | ✅ — re-runnable via `verify-pulse.mjs` |
| This Pulse was signed by the registered sample attester | ✅ — EIP-712, locally verifiable |
| BTC timestamp proves this hash existed before time T | ✅ — via `.ots` file |
| The "real" ETH price was X at time T | ❌ — prices come from public sources, which could lag or be manipulated |
| Chainlink's on-chain feed is always right | ❌ — can be stale, behind, or compromised |
| The attester key is never compromised | ⚠️ — dedicated sample key with **zero production privileges** |

> The Bitcoin timestamp proves the **hash existed before the chain's block time**.
> It does NOT prove the hash is correct — correctness comes from re-running the
> scoring rules against `rawSources[]`.

---

## Repository layout

```
insight-pulse-trail/
├── .github/workflows/
│   ├── pulse-every-15min.yml       # L1: every 15min — sample + EIP-712 sign
│   ├── weekly-stamp.yml            # L2a: Sunday UTC 23:00 — aggregate week → OTS submit
│   └── weekly-upgrade.yml          # L2b: Wednesday UTC 23:00 — fetch BTC confirmations
├── scripts/
│   ├── pulse.mjs                   # Node — samplers + scoring + signature
│   ├── verify-pulse.mjs            # Node — offline verification (rules + EIP-712)
│   ├── stamp-week.py               # Python — aggregate weekly UIDs → OTS stamp
│   └── upgrade-week.py             # Python — OTS upgrade (fetch BTC confirmations)
├── pulses/ETH/YYYY/MM/DD/HHMM-ETH.json   # .gitignore'd, workflow force-adds
├── timestamps/YYYY-Www/
│   ├── week.txt                    # Weekly Pulse UIDs, one per line
│   ├── week.txt.ots                # OTS proof (incomplete → upgraded Wednesdays)
│   └── manifest.json               # Metadata: monday/sunday/pulseCount/uids[]
├── RULES.md                        # Exact scoring rules (v1)
├── README.md                       # (this file)
└── package.json                    # Only dependency: viem
```

---

## Sources

| Source | Type | Endpoint |
|---|---|---|
| Chainlink ETH/USD (Ethereum mainnet) | on-chain `eth_call` | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` via `ethereum-rpc.publicnode.com` |
| CoinGecko ETH/USD | HTTP API | `api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd` |
| OKX ETH-USDT spot | HTTP API | `www.okx.com/api/v5/market/ticker?instId=ETH-USDT` |

All are free, read-only, no API key required. Failures are recorded in each
Pulse JSON's `failures[]` array — so readers know what was attempted and why it
fell through.

> Binance and Bybit are excluded — their API blocks GitHub Actions runner IPs
> (HTTP 451/403). The sources can be swapped or added without changing scoring
> rules — see RULES.md §1.

---

## Trail vs Insight production pipeline — two independent systems

> **Trail and Insight are two separate data-collection + signing pipelines.
> They may produce slightly different consensus values even at the same
> timestamp.** Do not expect bit-for-bit equality between this trail and
> Insight's own `/api/v1/pulse/latest` endpoint.

| | **Insight production** | **This trail** |
|---|---|---|
| **Runs where** | Cloudflare Workers + Supabase | GitHub Actions (Ubuntu runner) |
| **Sources** | 6–8 providers (Chainlink, Pyth, RedStone, Chronicle, Supra, ...) | 3 providers (Chainlink, CoinGecko, OKX) |
| **Consensus** | MAD outlier filter + weighted median | Simple median (3 sources too small for MAD) |
| **Agreement** | Weighted standard deviation | Population stddev over raw values |
| **Trust formula** | Production tuning weights | RULES.md v1 simple weights |
| **Signer key** | Production attester (role: `attester`) | Sample attester (role: `sample`) |
| **Dependency on other Insight services** | Yes — Oracle Watch cache, DB, attestation framework | **Zero** — self-contained |

The trail intentionally keeps the algorithm simple and self-contained so
anyone can clone this repo, re-run the scoring rules, and get the same
result without needing Insight's DB, RPC configuration, or paid tier
resources. Insight's production pipeline prioritises robustness (more
sources, stale detection, weighted consensus) over this trail's goal of
**easy independent verification**.

---

## Scoring rules (high level)

See **[RULES.md](RULES.md)** for the exact algorithm, every formula, and every
constant. Here's the short version:

```
QUORUM_MIN          = 3

consensusPrice      = median(successful_source_prices)
maxDeviationBps     = max |source - consensus| / consensus * 10000
agreementBps        = round(clamp(1 - (stddev/mean * 10), 0, 1) * 10000)
trustScore          = round(clamp(
                        agreement/10000 * 0.4 +
                        min(1, n/5)     * 0.3 +
                        quorumBonus     * 0.3 -   # +0 if quorum, -0.2 if not
                        min(0.5, maxDev/5000),
                      0, 100) * 100)
```

---

## Attester

Pulse signatures are produced by a **dedicated sample attester key**:

| Field | Value |
|---|---|
| Address | `0x25cD6643947A6C9B77708dE235F90377f82293a0` |
| Role | `sample` — zero production privileges |
| Domain | `{ name: "Insight Pulse", version: "1", chainId: 1 }` |

This key is registered at:
- Trail repo: this README
- Insight production: `oracleinsight.xyz/.well-known/oracle-keys.json` (role: sample)

**No production signing keys ever touch this trail.** The sample key exists only
to sign Pulse attestations here. If compromised, it can be rotated with zero
impact on Insight or PriorSeal.

---

## Why Bitcoin for timestamping

| Property | Value |
|---|---|
| Immutable? | ✅ BTC blockchain — oldest, most secure, ~7 confirmations |
| Free? | ✅ OpenTimestamps calendar servers aggregate multiple users' hashes into one BTC tx |
| No lock-in? | ✅ `.ots` proof files are standalone — verify with any BTC full node or public RPC |
| Decentralized? | ✅ Multiple calendars (alice, bob, finney, catallaxy) — no single point of failure |

---

## GitHub Actions cron schedule (UTC)

| Workflow | Cron | Job |
|---|---|---|
| `pulse-every-15min.yml` | `*/15 * * * *` | Sample 3 sources → median → EIP-712 → commit |
| `weekly-stamp.yml` | `0 23 * * 0` (Sun) | Aggregate week UIDs → OTS submit |
| `weekly-upgrade.yml` | `0 23 * * 3` (Wed) | OTS upgrade (BTC confirmations) |

---

## Related

| Project | What it does |
|---|---|
| **Insight** ([oracleinsight.xyz](https://oracleinsight.xyz)) | Production oracle transparency platform — this trail is a lightweight, independent sibling |
| **PriorSeal** ([github.com/imokokok/PriorSeal](https://github.com/imokokok/PriorSeal)) | EIP-712 + Ed25519 signed execution boundaries |

---

## License

MIT.
