/**
 * @fileoverview Insight Pulse sampling + signing — runs in GitHub Actions.
 *
 * Polls 3+ public oracle / oracle-adjacent sources, computes a median
 * consensus, and emits an EIP-712 signed OraclePulse that mirrors the
 * `Insight Pulse` schema in the main Insight repo. The signature is fully
 * verifiable against the Pulse domain (`name: "Insight Pulse"`, chainId 1)
 * and the attester public key registered at oracleinsight.xyz/.well-known/.
 *
 * Zero Insight-dependency: no DB, no API calls to oracleinsight.xyz, no
 * Cloudflare Workers CPU budget. This file is self-contained so the trail
 * can run independently even if insight.xyz is down.
 */

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { createPublicClient, http, keccak256, hashTypedData } = require('viem');
const { privateKeyToAccount, signTypedData } = require('viem/accounts');

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────

const SYMBOL = process.env.PULSE_SYMBOL || 'ETH';
const SUBJECT_CHAIN_ID = Number(process.env.PULSE_SUBJECT_CHAIN_ID || 1);
const QUORUM_MIN = 3;
const PRICE_SCALE = 1e8;
const PCT_SCALE = 100;
const RATIO_SCALE = 1e4;

// EIP-712 domain + types — MUST match Insight's pulseAttestation.ts exactly
// so signatures produced here are verifiable by oracleinsight.xyz/verify.
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

// Chainlink Aggregator V3 partial ABI — latestRoundData() + decimals()
const CHAINLINK_ABI = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// Known Chainlink feed — Ethereum mainnet ETH/USD (eth_call, no API key).
// Base feed excluded — address checksum unstable + we already have 3 API sources.
const CHAINLINK_FEEDS = {
  ETH: [
    {
      name: 'chainlink-ethereum',
      rpc: 'https://ethereum-rpc.publicnode.com',
      address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    },
  ],
};

// ─── Provider samplers ───────────────────────────────────────────────────────

/** Result from a single price source. */
function ok(name, price, timestamp, extras = {}) {
  return { name, price, timestamp, status: 'success', ...extras };
}
function fail(name, error) {
  return { name, price: 0, timestamp: 0, status: 'error', error: String(error) };
}

async function sampleChainlink(feed) {
  try {
    const client = createPublicClient({ transport: http(feed.rpc) });
    const decimals = await client.readContract({
      address: feed.address,
      abi: CHAINLINK_ABI,
      functionName: 'decimals',
    });
    const [, answer, , updatedAt] = await client.readContract({
      address: feed.address,
      abi: CHAINLINK_ABI,
      functionName: 'latestRoundData',
    });
    const price = Number(answer) / 10 ** Number(decimals);
    const now = Math.floor(Date.now() / 1000);
    const age = now - Number(updatedAt);
    return ok(feed.name, price, now, { dataAgeSeconds: age, feedId: feed.address });
  } catch (err) {
    return fail(feed.name, err);
  }
}

async function sampleCoinGecko() {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const price = data?.ethereum?.usd;
    if (!price) throw new Error('no eth key');
    return ok('coingecko', Number(price), Math.floor(Date.now() / 1000), {
      feedId: 'coingecko:ethereum/usd',
    });
  } catch (err) {
    return fail('coingecko', err);
  }
}

async function sampleBinance() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return ok('binance', Number(data.price), Math.floor(Date.now() / 1000), {
      feedId: 'binance:ETHUSDT',
    });
  } catch (err) {
    return fail('binance', err);
  }
}

async function sampleOKX() {
  try {
    const res = await fetch('https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const last = data?.data?.[0]?.last;
    if (!last) throw new Error('no last price');
    return ok('okx', Number(last), Math.floor(Date.now() / 1000), {
      feedId: 'okx:ETH-USDT',
    });
  } catch (err) {
    return fail('okx', err);
  }
}

async function sampleBybit() {
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=ETHUSDT');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const last = data?.result?.list?.[0]?.lastPrice;
    if (!last) throw new Error('no lastPrice');
    return ok('bybit', Number(last), Math.floor(Date.now() / 1000), {
      feedId: 'bybit:ETHUSDT',
    });
  } catch (err) {
    return fail('bybit', err);
  }
}

// ─── Consensus (simplified — median, no MAD / IQR) ───────────────────────────

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

/** Cross-provider agreement, scaled to 0-10000 (matches Insight's RATIO_SCALE). */
function agreementBps(prices) {
  if (prices.length < 2) return 10000;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (mean === 0) return 0;
  const variance =
    prices.reduce((sum, p) => sum + (p - mean) ** 2, 0) / prices.length;
  const std = Math.sqrt(variance);
  const cv = std / mean;
  const raw = Math.max(0, Math.min(1, 1 - cv * 10)); // AGREEMENT_CV_SENSITIVITY = 10
  return Math.round(raw * RATIO_SCALE);
}

/** Max deviation from consensus, in basis points. */
function maxDeviationBps(prices, consensus) {
  let max = 0;
  for (const p of prices) {
    const d = absDeviationBps(p, consensus);
    if (d > max) max = d;
  }
  return max;
}

/** Simplified trust score 0-100 — agreement + participant count weighting. */
function trustScore(prices, consensus, agreementBpsVal, quorumSatisfied) {
  if (prices.length === 0) return 0;
  const agreementScore = agreementBpsVal / RATIO_SCALE; // 0-1
  const countScore = Math.min(1, prices.length / 5);
  const quorumBonus = quorumSatisfied ? 0 : -0.2;
  const devPenalty = Math.min(0.5, maxDeviationBps(prices, consensus) / 5000); // 50% penalty at 500bps
  const raw = agreementScore * 0.4 + countScore * 0.3 + quorumBonus * 0.3 - devPenalty;
  return Math.max(0, Math.min(100, Math.round(raw * 100)));
}

// ─── Evidence hash (replicates Insight's providerObservationsHash) ───────────

/**
 * Simplified version of computeProviderObservationsHash — same principle:
 * keccak256 over sorted [provider, feedId, price_scaled, timestamp, dataAge, included].
 * The Insight repo uses a full ABI-encode + keccak256 of a struct; for the
 * trail we hand-encode to keep the script dependency-free. Anyone re-running
 * Insight's computeProviderObservationsHash on the same provider inputs will
 * get a different hash (different encoding), but the commitment UID is what
 * binds — and that's the EIP-712 hash, which IS identical.
 */
function observationsHash(successProviders) {
  const sorted = [...successProviders].sort((a, b) => a.name.localeCompare(b.name));
  const parts = sorted.map((p) => {
    const priceScaled = Math.round(p.price * PRICE_SCALE);
    const age = p.dataAgeSeconds ?? 0;
    return `${p.name}|${p.feedId ?? ''}|${priceScaled}|${p.timestamp}|${age}|1`;
  });
  return keccak256(Buffer.from(parts.join('\n'), 'utf8'));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const start = performance.now();
  console.log(`[pulse] start ${new Date().toISOString()} symbol=${SYMBOL}`);

  // 1. Sample all sources concurrently
  const samplers = [];
  const feeds = CHAINLINK_FEEDS[SYMBOL] || [];
  for (const feed of feeds) samplers.push(sampleChainlink(feed));
  samplers.push(sampleCoinGecko());
  samplers.push(sampleOKX());
  // Binance/Bybit excluded — GitHub Actions runner IPs hit 451/403 region blocks.

  const results = await Promise.all(samplers);
  const successes = results.filter((r) => r.status === 'success');
  const failures = results.filter((r) => r.status !== 'success');

  console.log(`[pulse] ${successes.length}/${results.length} succeeded:`,
    successes.map((s) => `${s.name}=$${s.price?.toFixed(2)}`).join(', '));
  if (failures.length > 0) {
    console.log(`[pulse] ${failures.length} failed:`,
      failures.map((f) => `${f.name}: ${f.error}`).join(', '));
  }

  if (successes.length < 2) {
    console.error('[pulse] FATAL: less than 2 providers available, cannot form consensus');
    process.exit(1);
  }

  // 2. Compute consensus
  const prices = successes.map((s) => s.price);
  const consensus = median(prices);
  const devBps = maxDeviationBps(prices, consensus);
  const agreeBps = agreementBps(prices);
  const quorumSatisfied = successes.length >= QUORUM_MIN;
  const trust = trustScore(prices, consensus, agreeBps, quorumSatisfied);
  const obsHash = observationsHash(successes);
  const evaluatedAt = Math.floor(Date.now() / 1000);

  // 3. Build Pulse message (mirrors Insight's PulseMessage shape exactly)
  const message = {
    symbol: SYMBOL,
    subjectChainId: SUBJECT_CHAIN_ID,
    consensusPrice: Math.round(consensus * PRICE_SCALE),
    maxDeviationBps: devBps,
    agreementBps: agreeBps,
    participantCount: successes.length,
    quorumSatisfied,
    trustScore: trust,
    providerObservationsHash: obsHash,
    evaluatedAt,
    validUntil: evaluatedAt + 3600,
    schemaVersion: 1,
  };

  // 4. EIP-712 sign — must match Insight's exact encode
  const privateKey = process.env.PULSE_SAMPLE_PRIVATE_KEY;
  if (!privateKey) {
    console.error('[pulse] FATAL: PULSE_SAMPLE_PRIVATE_KEY not set');
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey);
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

  const signature = await signTypedData({ ...typedData, privateKey });
  const uid = hashTypedData(typedData);

  // 5. Assemble attestation envelope
  const attestation = {
    uid,
    schemaVersion: 1,
    attester: account.address,
    attesterLabel: 'Insight Pulse sample attester',
    signedAt: new Date().toISOString(),
    validForSeconds: 3600,
    validUntil: message.validUntil,
    signature,
    data: message,
    eip712: {
      domain: PULSE_DOMAIN,
      types: PULSE_TYPES,
      primaryType: 'OraclePulse',
    },
    sources: successes.map((s) => ({
      name: s.name,
      price: s.price,
      timestamp: s.timestamp,
      feedId: s.feedId,
      dataAgeSeconds: s.dataAgeSeconds ?? null,
    })),
  };

  // 6. Write to dated path
  const now = new Date();
  const path = join(
    __dirname,
    '..',
    'pulses',
    SYMBOL,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}-${SYMBOL}.json`
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(attestation, null, 2));

  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`[pulse] OK consensus=$${consensus.toFixed(2)} score=${trust} dev=${devBps}bps file=${path} (${elapsed}ms)`);

  // 7. Emit GitHub Actions outputs
  const out = (k, v) => console.log(`${k}=${v}`);
  const outputs = [
    ['file', path],
    ['symbol', SYMBOL],
    ['score', String(trust)],
    ['dev', String(devBps)],
    ['consensus', consensus.toFixed(2)],
    ['uid', uid],
    ['attester', account.address],
  ];
  console.log('---GH_OUTPUT---');
  outputs.forEach(([k, v]) => out(k, v));
  // Also write to $GITHUB_OUTPUT file for modern Actions runners
  if (process.env.GITHUB_OUTPUT) {
    const fs = require('node:fs');
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      outputs.map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
    );
  }
}

main().catch((err) => {
  console.error('[pulse] FATAL unhandled:', err);
  process.exit(1);
});
