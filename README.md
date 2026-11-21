# Insight Pulse Trail

Bitcoin-anchored trail of Insight oracle quality pulses — **EIP-712 signed**, **independent public sources**, **fully verifiable**.

## What this repo is

Every 15 minutes, this repo records one cross-oracle health snapshot:

- **3+ independent public price sources** sampled directly (no Insight API, no paid RPC)
  - Chainlink ETH/USD on Ethereum mainnet (on-chain eth_call)
  - Chainlink ETH/USD on Base (on-chain eth_call)
  - CoinGecko public API
  - Binance spot (ETH/USDT)
- **Simplified median consensus** with agreement + max deviation
- **EIP-712 signed** by the dedicated sample attester key (registry role "sample")
- **Commitment hash** — the `uid` is `hashTypedData(domain, types, message)`

This is a **public, immutable, independently cloneable audit trail**. Anyone can clone it, run the verification steps below, and reproduce every Pulse's signature.

## Why you should care

If your protocol, treasury, or AI agent relies on an oracle feed, this trail answers:

> What was the cross-source spread on this asset at this exact moment, and does the attester's signature match?

## How to verify a Pulse

### 1. Clone the trail

```bash
git clone https://github.com/imokokok/insight-pulse-trail
cd insight-pulse-trail
```

### 2. Pick a Pulse file and extract its `uid` and `attester`

```bash
jq '{uid, attester, data}' pulses/ETH/2026/11/22/1500-ETH.json
```

### 3. Cross-check the attester key

```bash
curl -s https://www.oracleinsight.xyz/.well-known/oracle-keys.json | jq '.keys'
```

The `attester` address from step 2 must be listed here with `role: "sample"` (demo trail — independent sample key, zero trust risk).

### 4. Locally verify the EIP-712 signature

```bash
# Any eth_signTypedData verifier works. The schema is in the Pulse file's `eip712` block.
# Quick check with Insight's API (optional):
curl -X POST https://www.oracleinsight.xyz/api/v1/attestations/verify \
  -H 'Content-Type: application/json' \
  -d @pulses/ETH/2026/11/22/1500-ETH.json
```

### 5. Reproduce the sources yourself

```bash
# The Pulse's `sources` block lists every price that entered the consensus.
# Re-run Chainlink / CoinGecko / Binance queries at that exact hour —
# prices should land in the same spread.
```

## File layout

```
pulses/
  SYMBOL/
    YYYY/MM/DD/
      HHMM-SYMBOL.json        ← one Pulse per 15min, per symbol
scripts/
  pulse.mjs                   ← sampler + EIP-712 signer (self-contained, Insight-free)
.github/workflows/
  pulse-every-15min.yml       ← GitHub Actions cron
```

## Schema

Domain: `Insight Pulse`, `version: "1"`, `chainId: 1` (identifier-only, not bound to any chain).

```solidity
struct OraclePulse {
    string   symbol;
    uint256  subjectChainId;
    uint256  consensusPrice;        // median × 1e8
    uint256  maxDeviationBps;       // bps from consensus
    uint256  agreementBps;          // cross-source agreement 0–10000
    uint256  participantCount;
    bool     quorumSatisfied;       // >= 3 sources
    uint256  trustScore;            // 0–100
    bytes32  providerObservationsHash;
    uint256  evaluatedAt;          // unix seconds
    uint256  validUntil;
    uint256  schemaVersion;        // 1
}
```

## What it does NOT prove

- A Pulse does **not** prove the oracle price is correct. It proves **the attester measured** the consensus among N independent providers at that moment and recorded the spread/deviation/signature.
- The 3-source consensus here is **simplified** (median + basic agreement). Insight production uses MAD outlier detection + weighted median + freshness guard against DB-backed feed registry. This trail is for exhibit, not production risk gating.

## Security note

The `PULSE_SAMPLE_PRIVATE_KEY` is stored in this repo's GitHub Secrets. It is a **dedicated sample key** — used for nothing except trail signing. Its role in the `.well-known/oracle-keys.json` registry is `"sample"`, so anyone verifying a Pulse can immediately identify it as non-production.

## See also

- Insight: https://oracleinsight.xyz
- Insight Pulse endpoint (optional data source): https://oracleinsight.xyz/api/v1/pulse/latest
- Pulse source code: https://github.com/imokokok/Insight/blob/wt/feat-pulse-attestation/src/lib/attestations/pulseAttestation.ts
