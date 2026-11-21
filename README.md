# Insight Pulse Trail

Bitcoin-anchored trail of Insight oracle quality pulses — EIP-712 signed, OpenTimestamps-proven.

## What this repo is

Every 15 minutes, this repo records one [Insight](https://oracleinsight.xyz/) oracle quality pulse:

- **EIP-712 signed** by the Insight attester key (`.well-known/oracle-keys.json`)
- **Human-readable** fields: symbol, consensus price, deviation, agreement, trust score
- **Commitment hash** — the `uid` is `hashTypedData(domain, types, message)`, locally verifiable
- **BTC-anchored** weekly via OpenTimestamps (see `.ots/`)

This is not an API. It's a **public, immutable, independently cloneable audit trail** that anyone can point at as evidence that oracle X on chain Y was measured and found healthy (or not) at time T.

## Why you should care

If your protocol, treasury, or AI agent relies on an oracle feed, this trail answers:

> Did this feed have a measurable anomaly in the hours before our incident?

Clone the repo, run `git log --oneline`, and you have a verifiable history of every Pulse Insight has published.

## How to verify a Pulse

### 1. Clone the trail

```bash
git clone https://github.com/imokokok/insight-pulse-trail
cd insight-pulse-trail
```

### 2. Pick a Pulse file and extract its `uid` and `attester`

```bash
jq '{uid, attester, data}' pulses/2026/11/22/1500-ETH.json
```

### 3. Cross-check the attester key

```bash
curl -s https://www.oracleinsight.xyz/.well-known/oracle-keys.json | jq '.keys'
```

The `attester` address from step 2 must be listed here with `role: "attester"` (production) or `role: "sample"` (demo trail).

### 4. Locally verify the EIP-712 signature

See Insight's [`verifyAttestationBySchema`](https://oracleinsight.xyz/api/v1/testing/attestations/verify) endpoint, or any `eth_signTypedData` verifier. The domain/shape are in the Pulse file's `eip712` block.

### 5. Check the anchor

Weekly OpenTimestamps proofs are in `.ots/`. Verify any of them:

```bash
pip install opentimestamps-client
ots verify .ots/weekly-2026-11-22.txt.ots
```

## File layout

```
pulses/
  YYYY/MM/DD/
    HHMM-SYMBOL.json        ← one Pulse per 15min, per symbol
.ots/
  weekly-YYYY-MM-DD.txt.ots ← weekly BTC anchor proofs (OpenTimestamps)
.github/workflows/
  pulse-every-15min.yml     ← fetches + commits
```

## What it does NOT prove

- A Pulse does **not** prove the oracle price is correct. It proves Insight measured the consensus among N independent providers at that moment and recorded the spread/deviation/score/signature.
- OpenTimestamps proves the Pulse **existed before** the BTC block that anchors it. It does not prove the Pulse is **true**.

## See also

- Insight: https://oracleinsight.xyz
- PriorSeal: https://priorseal.xyz
- Pulse attester registry: https://www.oracleinsight.xyz/.well-known/oracle-keys.json
- Source: [pulseAttestation.ts](https://github.com/imokokok/insight/blob/main/src/lib/attestations/pulseAttestation.ts)
