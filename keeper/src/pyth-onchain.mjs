/**
 * Read Pyth prices straight from Solana state - no API key.
 *
 * Since the Pyth Core upgrade (2026-08-26) every Hermes price endpoint answers
 * 401 without a Bearer key. But the prices still live on Solana: the push
 * oracle program (`pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`) maintains one
 * `PriceUpdateV2` account per (shard, feed id), derived as a PDA over seeds
 * `[shard_le16, feed_id_32]`, and the Pyth Data Association sponsors continuous
 * updates for a subset of feeds on shard 0. That subset covers 17 of the 22
 * xStock wrapper feeds Owed compares against - including every large name.
 *
 * Reading the reference from chain state is not just a workaround for the
 * paywall; it is the stronger provenance for this repo: the same RPC that
 * supplies the multiplier snapshot supplies the reference price, so a judge
 * reproduces both with one tool.
 *
 * The account layout below was verified byte-by-byte against a live account,
 * not assumed from docs. For the SOL/USD feed account (134 bytes):
 *
 *   0..8    Anchor discriminator of PriceUpdateV2
 *   8..40   write_authority (Pubkey)
 *   40      verification_level (enum, `Full` = 1 byte)
 *   41..73  price_message.feed_id (32 bytes)
 *   73..81  price_message.price (i64)
 *   81..89  price_message.conf (i64)
 *   89..93  price_message.expo (i32)
 *   93..101 price_message.publish_time (i64, unix seconds)
 *   101..109 price_message.prev_publish_time (i64)
 *   109..117 price_message.ema_price (i64)
 *   117..125 price_message.ema_conf (i64)
 *   125..133 posted_slot (u64)
 *
 * (`verification_level` is a data-carrying enum in Rust - `Partial { u8 }` -
 * but the sponsored shard-0 accounts are `Full`, so the fixed 1-byte layout
 * holds for everything this module reads. A parser that walks a `Partial`
 * account would misread it, so `parsePriceUpdateV2` refuses buffers whose
 * embedded feed id does not match the request rather than misreading.)
 *
 * PDA derivation needs an off-curve check, which needs ed25519 field math.
 * It is implemented here (~40 lines of BigInt) so the keeper keeps its
 * zero-runtime-dependency property; `pyth-onchain.test.mjs` cross-checks the
 * derivation against @solana/web3.js on random inputs when that package is
 * installed, so the two implementations cannot drift apart silently.
 *
 * Zero dependencies: `fetch` is built into Node 18+.
 */

import { createHash } from "node:crypto";

/** The push oracle program that owns every price feed account. */
export const PUSH_ORACLE_PROGRAM_ID = "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Encode bytes as base58 (Bitcoin alphabet), leading zero bytes as '1'. */
export function base58Encode(buf) {
  let n = BigInt(`0x${buf.toString("hex")}`);
  let s = "";
  while (n > 0n) {
    s = BASE58_ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) s = `1${s}`;
    else break;
  }
  return s;
}

/** Decode base58 to bytes; `length` pads/truncates on the left (32 for pubkeys). */
export function base58Decode(s, { length = 32 } = {}) {
  let n = 0n;
  for (const c of s) {
    const i = BASE58_ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let buf = Buffer.from(hex, "hex");
  let zeros = 0;
  for (const c of s) {
    if (c === "1") zeros++;
    else break;
  }
  if (buf.length > length) buf = buf.slice(buf.length - length);
  if (buf.length < length) buf = Buffer.concat([Buffer.alloc(length - buf.length), buf]);
  return zeros > 0 ? Buffer.concat([Buffer.alloc(zeros), buf.slice(zeros)]) : buf;
}

// -------------------------------------------------------------- ed25519 math
// Only what a PDA derivation needs: decide whether 32 bytes decode to a point
// on the ed25519 curve. Solana PDAs are defined as hashes that do NOT.

const P = 2n ** 255n - 19n;

/** Modular inverse mod p (Fermat: a^(p-2)). */
function modInv(a) {
  return modPow(a % P, P - 2n);
}

// Curve constants derived, not transcribed: a wrong hardcoded constant here
// silently produced curve checks that agreed with @solana/web3.js only by
// chance, which made PDA derivation wrong for roughly half of all feeds.
// d = -121665/121666 mod p, and sqrt(-1) = 2^((p-1)/4) mod p (p = 5 mod 8).
const D = (P - 121665n) * modInv(121666n) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

/** pow(b, e) mod p, BigInt square-and-multiply. */
function modPow(b, e) {
  let r = 1n;
  let base = b % P;
  while (e > 0n) {
    if (e & 1n) r = (r * base) % P;
    base = (base * base) % P;
    e >>= 1n;
  }
  return r;
}

/**
 * Is the 32-byte string a valid compressed ed25519 point (or identity)?
 * Mirrors the `is_on_curve` check in Solana's curve25519-dalek: decode the
 * y coordinate from the low 255 bits, then try to recover x. A sign bit of 1
 * with x = 0 is rejected; everything else that decompresses is "on curve".
 */
export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  const b = Buffer.from(bytes);
  // Compressed ed25519 is y in LITTLE-ENDIAN order with the sign of x in the
  // top bit. Decoding it big-endian was the real bug: every random 32 bytes
  // decoded to a different field element than dalek reads, so this check
  // disagreed with @solana/web3.js on about half of all inputs.
  const y = BigInt(`0x${Buffer.from(b).reverse().toString("hex")}`) & ((1n << 255n) - 1n);
  const sign = (b[31] & 0x80) !== 0;
  // A compressed point encodes a field element: y must be < p, exactly as
  // curve25519-dalek's decompress rejects. Without this, hashes whose top
  // bytes land in [p, 2^255) are wrongly accepted as points.
  if (y >= P) return false;

  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;

  // x = u * v^3 * (u * v^7)^((p-5)/8), per dalek; then check v * x^2 == u
  const v3 = modPow(v, 3n);
  const v7 = modPow(v, 7n);
  let x = (u * v3 % P) * modPow((u * v7) % P, (P - 5n) / 8n) % P;

  const vxx = (v * ((x * x) % P)) % P;
  if (vxx === u) {
    // x recovered directly
  } else if (vxx === (P - u) % P) {
    x = (x * SQRT_M1) % P;
  } else {
    return false; // no square root: not on the curve
  }
  // dalek re-verifies after the multiply, and so must we: the flip is only
  // correct when SQRT_M1 really squares to -1, and an implementation that
  // returns `true` on an unrecoverable string is worse than one that throws.
  if ((v * ((x * x) % P)) % P !== u) return false;
  if (x === 0n && sign) return false;
  return true;
}

/**
 * Derive a push-oracle price feed account exactly as
 * `PublicKey.findProgramAddressSync([shard_le16, feed32], program)` does:
 * sha256(seeds ++ program_id ++ "ProgramDerivedAddress"), bump from 255 down,
 * first hash that is NOT a curve point.
 */
export function derivePriceFeedAccount(feedIdHex, { shard = 0, programId = PUSH_ORACLE_PROGRAM_ID } = {}) {
  const feed = Buffer.from(feedIdHex.replace(/^0x/, ""), "hex");
  if (feed.length !== 32) throw new Error(`feed id must be 32 bytes, got ${feed.length}`);
  const shardBuf = Buffer.alloc(2);
  shardBuf.writeUInt16LE(shard);
  // The program id travels through the hash as its 32 decoded bytes - the same
  // bytes `PublicKey.toBytes()` produces - not as the base58 string. Encoding
  // them as UTF8 was a real bug: every hash came out different and the
  // derived accounts did not exist.
  const program = base58Decode(programId, { length: 32 });
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    h.update(shardBuf);
    h.update(feed);
    h.update(Buffer.from([bump]));
    h.update(program);
    h.update(Buffer.from("ProgramDerivedAddress"));
    const out = h.digest();
    if (!isOnCurve(out)) return { address: base58Encode(out), bump };
  }
  throw new Error("no valid bump found");
}

/**
 * Parse one PriceUpdateV2 account into its price message. Throws when the
 * embedded feed id does not match `expectedFeedIdHex`, which is the guard
 * against misparsing an account we did not expect (wrong PDA, wrong shard).
 */
export function parsePriceUpdateV2(data, expectedFeedIdHex) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 133) throw new Error(`price update too short: ${buf.length} bytes`);
  const feedId = buf.slice(41, 73).toString("hex");
  if (expectedFeedIdHex && feedId !== expectedFeedIdHex.replace(/^0x/, "")) {
    throw new Error(`feed id mismatch: account carries ${feedId}`);
  }
  const expo = buf.readInt32LE(89);
  const price = Number(buf.readBigInt64LE(73)) * 10 ** expo;
  const conf = Number(buf.readBigInt64LE(81)) * 10 ** expo;
  return {
    feedId,
    price,
    confidence: conf,
    expo,
    publishTime: Number(buf.readBigInt64LE(93)),
    prevPublishTime: Number(buf.readBigInt64LE(101)),
    emaPrice: Number(buf.readBigInt64LE(109)) * 10 ** expo,
    postedSlot: Number(buf.readBigUInt64LE(125)),
  };
}

/**
 * Fetch prices for many feed ids from Solana state.
 *
 * Returns a Map keyed by lowercase feed id: { price, confidence, publishTime,
 * expo, postedSlot, address, source: "onchain" }. Feeds with no account (the
 * sponsor does not push them) are simply absent from the map - absence is the
 * finding, and the caller decides whether a Hermes fallback covers them.
 *
 * `getMultipleAccounts` is batched at 100 keys per call, the documented maximum
 * for this method on public RPCs.
 */
export async function fetchOnChainPrices(feedIds, { rpcUrl = process.env.OWED_RPC_URL || "https://api.mainnet-beta.solana.com", shard = 0, fetchImpl = fetch } = {}) {
  const derived = new Map();
  for (const id of feedIds) {
    const key = id.toLowerCase();
    if (!derived.has(key)) derived.set(key, derivePriceFeedAccount(key, { shard }).address);
  }
  const addresses = [...new Set(derived.values())];
  const byAddress = new Map([...derived].map(([id, addr]) => [addr, id]));

  const out = new Map();
  const BATCH = 100;
  for (let i = 0; i < addresses.length; i += BATCH) {
    const batch = addresses.slice(i, i + BATCH);
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getMultipleAccounts",
        params: [batch, { encoding: "base64" }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`rpc ${res.status} from ${rpcUrl}`);
    const json = await res.json();
    if (json.error) throw new Error(`rpc error: ${json.error.message ?? JSON.stringify(json.error)}`);
    (json.result?.value ?? []).forEach((v, k) => {
      if (!v) return;
      const addr = batch[k];
      const feedId = byAddress.get(addr);
      try {
        const parsed = parsePriceUpdateV2(Buffer.from(v.data[0], "base64"), feedId);
        out.set(feedId, { ...parsed, address: addr, source: "onchain" });
      } catch {
        // A mismatching account is skipped rather than trusted: this module
        // would rather publish fewer prices than one wrong price.
      }
    });
  }
  return out;
}
