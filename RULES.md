# Insight Pulse — Scoring Rules (v1)

**URL**: `https://github.com/imokokok/insight-pulse-trail/blob/main/RULES.md`
**Version**: 1 (2026-11-22)

These are the exact rules applied by `scripts/pulse.mjs` when computing consensus,
agreement, deviation, and trust score. Anyone re-running these rules on the
`rawSources[]` data inside a Pulse JSON must arrive at the same numbers.

---

## 1. Sources

Three independent public sources are polled concurrently. All are free and
require no API key:

| Source | Type | Endpoint / Contract |
|--------|------|---------------------|
| Chainlink ETH/USD (Ethereum) | on-chain `eth_call` | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` via `publicnode.com` |
| CoinGecko ETH/USD | HTTP API | `api.coingecko.com/api/v3/simple/price` |
| OKX ETH-USDT spot | HTTP API | `www.okx.com/api/v5/market/ticker` |

> Binance and Bybit are intentionally excluded — their API blocks GitHub Actions
> runner IPs with HTTP 451/403. If a future run finds them working, they can be
> added without changing the scoring rules.

---

## 2. Quorum

```
QUORUM_MIN = 3
```

**quorumSatisfied = true** if ≥ 3 sources succeeded. **false** if only 1 or 2
succeeded (unable to form a meaningful median). If fewer than 2 succeeded, the
sampler aborts and no Pulse is emitted.

---

## 3. Consensus Price

```
consensusPrice = median(successful_source_prices)
```

Simple median — no MAD / IQR outlier filtering. The small source count (3)
makes MAD/robust stats unreliable. We rely on agreement and deviation metrics
to surface anomalies instead.

---

## 4. Agreement (agreementBps)

Cross-provider consistency, scaled to 0–10000 basis points. Higher = more
agreement.

```
agreementBps = round( max(0, min(1, 1 - (stddev/mean * 10))) * 10000 )
```

Where:
- `mean` = arithmetic mean of successful source prices
- `stddev` = population standard deviation
- `cv` = stddev / mean (coefficient of variation)
- `cv * 10` sensitivity: a 10% coefficient of variation → agreement drops to 0

Minimum 2 sources required (definition is trivially 10000 for 1 source but we
never have that case — quorum aborts below 2).

---

## 5. Maximum Deviation (maxDeviationBps)

The farthest any source is from consensus, in basis points.

```
maxDeviationBps = max over sources of (|price - consensus| / consensus) * 10000
```

---

## 6. Trust Score (0–100)

Weighted combination of agreement, source count, quorum status, and deviation
penalty. Higher = more trustworthy.

```
agreementScore = agreementBps / 10000     // 0–1
countScore     = min(1, n_sources / 5)   // 0.6 for 3 sources; 1.0 for 5+
quorumBonus    = quorumSatisfied ? 0 : -0.2
devPenalty     = min(0.5, maxDeviationBps / 5000)

trustScore = round( clamp(
    agreementScore * 0.4 + countScore * 0.3 + quorumBonus * 0.3 - devPenalty,
    0, 100
) * 100 )
```

Interpretation guide (for ETH/USD under normal conditions):

| Score range | Interpretation |
|---|---|
| 90–100 | Excellent — all sources within ~20bps, high agreement |
| 70–89 | Good — within normal daily spread |
| 50–69 | Fair — noticeable divergence, one source may be stale |
| 0–49 | Poor — sources disagree, quorum may have failed |

---

## 7. Evidence Hash (providerObservationsHash)

A deterministic hash over sorted raw observations. Same principle as Insight's
main `computeProviderObservationsHash`, hand-encoded for dependency-free usage
in the trail.

```
providerObservationsHash = keccak256(
  newline-joined(
    sorted_by_name(
      for each success: "<name>|<feedId>|<priceScaled>|<timestamp>|<dataAgeSeconds>|1"
    )
  )
)
```

Where `priceScaled = round(price * 1e8)`.

---

## 8. EIP-712 Signature

**Domain**:
```
{ name: "Insight Pulse", version: "1", chainId: 1 }
```

**Types** (12 fields, all non-optional):
```
OraclePulse(
  string symbol,
  uint256 subjectChainId,
  uint256 consensusPrice,
  uint256 maxDeviationBps,
  uint256 agreementBps,
  uint256 participantCount,
  bool   quorumSatisfied,
  uint256 trustScore,
  bytes32 providerObservationsHash,
  uint256 evaluatedAt,
  uint256 validUntil,
  uint256 schemaVersion
)
```

**UID** = `hashTypedData(domain, types, primaryType="OraclePulse", message)`.

---

## 9. What this does NOT prove — trust boundaries

> **A Pulse proves the raw source data existed at time T and the scoring rules
> were applied. It does NOT prove price correctness, source legality, or that
> no manipulation occurred.**

| Claim | Supported? | Why |
|---|---|---|
| These 3 sources returned these prices at time T | ✅ Yes — rawSources[] recorded | Each source's sampledAt timestamp + rawResponse are in the JSON |
| The consensus = median(rawSources) | ✅ Yes — re-runnable | Anyone can run `node scripts/verify-pulse.mjs` to confirm |
| This Pulse was signed by the registered attester | ✅ Yes — EIP-712 | Locally verifiable signature against attester public key |
| BTC timestamp proves this hash existed before time T | ✅ Yes — .ots file | `ots verify week.txt.ots week.txt` confirms Merkle root in BTC |
| The "real" ETH price was X at time T | ❌ No | Prices come from public sources, which could lag or be manipulated |
| Chainlink's on-chain feed is always right | ❌ No | Chainlink is a single oracle, can be stale, behind, or compromised |
| The attester key is never compromised | ⚠️ Mitigated | Using a dedicated **sample attester** key with no production privileges |

---

## 10. Versioning

- **schemaVersion** (1): EIP-712 type definitions — only changes if the domain or types change
- **rulesVersion** (1): Scoring rules in this document — bumps when consensus, agreement, or trust algorithms change
- **Both** are in every Pulse JSON so readers can check compatibility

When bumping either version, update `RULES.md`, update the `PULSE_DOMAIN` / `PULSE_TYPES` in `scripts/pulse.mjs`, and commit the change separately from a normal Pulse run.
