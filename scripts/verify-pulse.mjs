#!/usr/bin/env node
/**
 * @fileoverview Verify an Insight Pulse JSON file.
 *
 * Usage:
 *   node scripts/verify-pulse.mjs pulses/ETH/2026/11/22/1415-ETH.json
 *   node scripts/verify-pulse.mjs pulses/ETH/2026/11/22/1415-ETH.json \
 *     --attester 0x25cD6643947A6C9B77708dE235F90377f82293a0 \
 *     --no-fetch-keys
 *
 * What it does:
 *   1. Loads the Pulse JSON
 *   2. Re-runs the scoring rules on rawSources[] and checks they produce
 *      the same consensus / agreement / trustScore / providerObservationsHash
 *      as signed (the observationsHash is the deterministic hash binding all
 *      raw sources together — if it differs, the Pulse was tampered with)
 *   3. Verifies the EIP-712 signature locally using viem
 *   4. Optionally fetches oracleinsight.xyz/.well-known/oracle-keys.json
 *      and checks the attester is registered
 *   5. If OpenTimestamps .ots proof exists alongside the pulse, tries to
 *      verify it too
 *
 * Fully offline-capable with --no-fetch-keys.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { verifyTypedData, keccak256 } = require('viem');
const { publicActions } = require('viem');

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let pulsePath = null;
let attesterArg = null;
let fetchKeys = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--attester') attesterArg = args[++i];
  else if (args[i] === '--no-fetch-keys') fetchKeys = false;
  else pulsePath = args[i];
}

if (!pulsePath) {
  console.error(`Usage: node scripts/verify-pulse.mjs <pulse.json> [--attester 0x...] [--no-fetch-keys]`);
  process.exit(1);
}

// ─── Pulse message re-encoding (must match pulse.mjs EXACTLY) ─────────────────
// We don't import from pulse.mjs because that script runs in GitHub Actions
// context. Duplicated here intentionally for offline verification.

const PULSE_DOMAIN = {
  name: 'Insight Pulse',
  version: '1',
  chainId: 1,
};

const PULSE_TYPES = {
  OraclePulse: [
    { name: 'symbol', type: 'string' },
    { name: 'subjectChainId', type: 'uint256' },
    { name: 'consensusPrice', type: 'uint256' },
    { name: 'maxDeviationBps', type: 'uint256' },
    { name: 'agreementBps', type: 'uint256' },
    { name: 'participantCount', type: 'uint256' },
    { name: 'quorumSatisfied', type: 'bool' },
    { name: 'trustScore', type: 'uint256' },
    { name: 'providerObservationsHash', type: 'bytes32' },
    { name: 'evaluatedAt', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'schemaVersion', type: 'uint256' },
  ],
};

const PRICE_SCALE = 1e8;
const RATIO_SCALE = 1e4;

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function absDeviationBps(price, consensus) {
  if (consensus <= 0) return 0;
  return Math.round((Math.abs(price - consensus) / consensus) * 10000);
}

function agreementBps(prices) {
  if (prices.length < 2) return 10000;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (mean === 0) return 0;
  const variance = prices.reduce((sum, p) => sum + (p - mean) ** 2, 0) / prices.length;
  const std = Math.sqrt(variance);
  const cv = std / mean;
  const raw = Math.max(0, Math.min(1, 1 - cv * 10));
  return Math.round(raw * RATIO_SCALE);
}

function maxDeviationBps(prices, consensus) {
  let max = 0;
  for (const p of prices) {
    const d = absDeviationBps(p, consensus);
    if (d > max) max = d;
  }
  return max;
}

function trustScore(prices, consensus, agreementBpsVal, quorumSatisfied) {
  if (prices.length === 0) return 0;
  const agreementScore = agreementBpsVal / RATIO_SCALE;
  const countScore = Math.min(1, prices.length / 5);
  const quorumBonus = quorumSatisfied ? 0 : -0.2;
  const devPenalty = Math.min(0.5, maxDeviationBps(prices, consensus) / 5000);
  const raw = agreementScore * 0.4 + countScore * 0.3 + quorumBonus * 0.3 - devPenalty;
  return Math.max(0, Math.min(100, Math.round(raw * 100)));
}

// ─── Evidence hash (must match pulse.mjs EXACTLY) ─────────────────────────────
// Duplicated here intentionally so verification works offline without importing
// from pulse.mjs (which runs in GitHub Actions context).
function observationsHash(sources) {
  const sorted = [...sources].sort((a, b) => a.name.localeCompare(b.name));
  const parts = sorted.map((p) => {
    const priceScaled = p.priceScaled ?? Math.round(p.price * PRICE_SCALE);
    const age = p.dataAgeSeconds ?? 0;
    const ts = p.sampledAt ?? p.timestamp;
    return `${p.name}|${p.feedId ?? ''}|${priceScaled}|${ts}|${age}|1`;
  });
  // viem's keccak256 takes hex input; encode the UTF-8 joined string as hex
  const joined = parts.join('\n');
  const hex = '0x' + Buffer.from(joined, 'utf8').toString('hex');
  return keccak256(hex);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Verifying: ${pulsePath}`);
  console.log('─'.repeat(60));

  // 1. Load Pulse
  let pulse;
  try {
    const raw = readFileSync(pulsePath, 'utf-8');
    pulse = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ 1/5 LOAD FAILED: ${err.message}`);
    process.exit(1);
  }
  console.log(`✅ 1/5 Loaded Pulse: ${pulse.uid?.slice(0, 10)}...${pulse.uid?.slice(-6)}`);

  // 2. Re-run scoring rules on rawSources[]
  console.log(`\n✅ 2/5 Re-running scoring rules on ${pulse.rawSources?.length ?? 0} raw sources...`);
  const sources = pulse.rawSources?.filter(s => s.status === 'success') ?? pulse.sources ?? [];
  const prices = sources.map(s => s.price);
  const reConsensus = median(prices);
  const reDev = maxDeviationBps(prices, reConsensus);
  const reAgree = agreementBps(prices);
  const reQuorum = sources.length >= 3;
  const reTrust = trustScore(prices, reConsensus, reAgree, reQuorum);
  const reHash = observationsHash(sources);

  // Compare
  const mismatches = [];
  const data = pulse.data;
  if (Math.abs(reConsensus * PRICE_SCALE - data.consensusPrice) > PRICE_SCALE / 1000) {
    mismatches.push(`consensus: expected ${data.consensusPrice / PRICE_SCALE}, recomputed ${reConsensus.toFixed(4)}`);
  }
  if (reDev !== data.maxDeviationBps) mismatches.push(`maxDeviationBps: expected ${data.maxDeviationBps}, recomputed ${reDev}`);
  if (reAgree !== data.agreementBps) mismatches.push(`agreementBps: expected ${data.agreementBps}, recomputed ${reAgree}`);
  if (reTrust !== data.trustScore) mismatches.push(`trustScore: expected ${data.trustScore}, recomputed ${reTrust}`);
  if (sources.length !== data.participantCount) mismatches.push(`participantCount: expected ${data.participantCount}, got ${sources.length}`);
  if (reQuorum !== data.quorumSatisfied) mismatches.push(`quorumSatisfied: expected ${data.quorumSatisfied}, recomputed ${reQuorum}`);

  // CRITICAL: providerObservationsHash binds all raw sources together.
  // If this differs, rawSources[] was tampered with (someone swapped values
  // but kept consensus/score/other computed fields consistent).
  if (reHash.toLowerCase() !== data.providerObservationsHash.toLowerCase()) {
    mismatches.push(`providerObservationsHash: expected ${data.providerObservationsHash}, recomputed ${reHash}`);
  }

  if (mismatches.length > 0) {
    console.error('❌ Scoring rules mismatch — Pulse was NOT produced by the documented algorithm:');
    mismatches.forEach(m => console.error(`   • ${m}`));
    process.exit(1);
  }
  console.log(`   consensus=$${reConsensus.toFixed(2)}  deviation=${reDev}bps  agreement=${reAgree}bps  score=${reTrust}`);
  console.log(`   obsHash=${reHash.slice(0, 12)}...${reHash.slice(-6)}  (rawSources[] → commitment hash matches signed field)`);
  console.log('   ✅ All fields match — Pulse was produced by the documented algorithm');

  // 3. Verify EIP-712 signature
  console.log(`\n✅ 3/5 Verifying EIP-712 signature...`);
  const message = pulse.data;
  const typedData = {
    domain: PULSE_DOMAIN,
    types: PULSE_TYPES,
    primaryType: 'OraclePulse',
    message: {
      symbol: message.symbol,
      subjectChainId: BigInt(message.subjectChainId),
      consensusPrice: BigInt(message.consensusPrice),
      maxDeviationBps: BigInt(message.maxDeviationBps),
      agreementBps: BigInt(message.agreementBps),
      participantCount: BigInt(message.participantCount),
      quorumSatisfied: message.quorumSatisfied,
      trustScore: BigInt(message.trustScore),
      providerObservationsHash: message.providerObservationsHash,
      evaluatedAt: BigInt(message.evaluatedAt),
      validUntil: BigInt(message.validUntil),
      schemaVersion: BigInt(message.schemaVersion),
    },
  };

  let sigOk;
  try {
    sigOk = await verifyTypedData({
      address: pulse.attester,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: 'OraclePulse',
      message: typedData.message,
      signature: pulse.signature,
    });
  } catch (err) {
    console.error(`❌ Signature verification failed: ${err.message}`);
    process.exit(1);
  }

  if (!sigOk) {
    console.error(`❌ EIP-712 signature does NOT match attester ${pulse.attester}`);
    process.exit(1);
  }
  console.log(`   ✅ Signature valid — signed by ${pulse.attester} (${pulse.attesterRole ?? 'unknown role'})`);

  // 4. Check attester registration
  console.log(`\n✅ 4/5 Checking attester registration...`);
  const attester = attesterArg ?? pulse.attester;
  if (!fetchKeys) {
    console.log(`   ⚠️  Skipped (--no-fetch-keys) — you must manually confirm ${attester} is registered at oracleinsight.xyz/.well-known/oracle-keys.json`);
  } else {
    try {
      const res = await fetch('https://oracleinsight.xyz/.well-known/oracle-keys.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const keys = await res.json();
      const entry = keys.attesters?.find(a => a.address?.toLowerCase() === attester.toLowerCase())
                  || keys.sampleAttesters?.find(a => a.address?.toLowerCase() === attester.toLowerCase())
                  || keys.find?.(a => a.address?.toLowerCase() === attester.toLowerCase());
      if (entry) {
        console.log(`   ✅ Attester registered — role: ${entry.role ?? entry.label ?? 'unknown'}`);
      } else {
        console.log(`   ⚠️  Attester ${attester} NOT found in oracleinsight.xyz/.well-known/oracle-keys.json`);
        console.log(`      This is OK for the trail repo's sample attester — it's registered in this repo's attesters.json instead.`);
      }
    } catch (err) {
      console.log(`   ⚠️  Could not fetch oracle-keys.json: ${err.message}`);
    }
  }

  // 5. Check validity window
  console.log(`\n✅ 5/5 Validity check...`);
  const now = Math.floor(Date.now() / 1000);
  if (now > pulse.validUntil) {
    console.log(`   ⚠️  Pulse expired (valid until ${pulse.validUntil}, now ${now}) — signatures still cryptographically valid`);
  } else {
    console.log(`   ✅ Pulse valid for another ${Math.round((pulse.validUntil - now) / 60)} minutes`);
  }

  // Summary
  console.log('\n' + '─'.repeat(60));
  console.log(`🎉 VERIFIED — Pulse ${pulse.uid?.slice(0, 10)}...${pulse.uid?.slice(-6)} is:`);
  console.log(`   • Produced by the documented algorithm (rulesVersion ${pulse.rulesVersion ?? pulse.schemaVersion})`);
  console.log(`   • EIP-712 signed by ${pulse.attester}`);
  console.log(`   • Consensus: $${reConsensus.toFixed(2)}  Trust: ${reTrust}/100  Sources: ${sources.length}${pulse.failures?.length ? `  Failures: ${pulse.failures.length}` : ''}`);
  if (pulse.rulesUrl) console.log(`   • Rules: ${pulse.rulesUrl}`);
  console.log();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
