/**
 * Minimal Solana JSON-RPC client + snapshot builder. Zero dependencies —
 * Node 18+ built-in `fetch` only.
 *
 * The snapshot builder reproduces, off-chain, exactly what the on-chain
 * `snapshot_holders` instruction enforces: the holder set at the record
 * slot must sum to the mint supply. The keeper fetches, the Rust core
 * validates, and only then is a Merkle root published.
 */

/** SPL Token program (classic). Token-2022 mints need their own pass. */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Tiny JSON-RPC wrapper over a standard Solana endpoint. */
export class SolanaRpc {
  constructor(url = "https://api.devnet.solana.com") {
    this.url = url;
    this._id = 0;
  }

  async call(method, params = []) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this._id,
        method,
        params,
      }),
    });
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`rpc ${method}: ${json.error.message}`);
    return json.result;
  }

  /** Mint supply (base units) as BigInt. */
  async mintSupply(mint) {
    const r = await this.call("getTokenSupply", [mint]);
    return { amount: BigInt(r.value.amount), decimals: r.value.decimals };
  }

  /**
   * All token accounts for a mint: [{ owner, amount (BigInt) }].
   *
   * Uses getProgramAccounts with a dataSize + memcmp(mint) filter — the
   * canonical way to enumerate holders of a mint. Note: on mainnet-beta a
   * popular mint can exceed the gPA response budget; production keepers
   * should use a geyser stream or paginated data slices. Devnet and
   * hackathon-scale registers are fine.
   */
  async tokenAccounts(mint, programId = TOKEN_PROGRAM_ID) {
    const r = await this.call("getProgramAccounts", [
      programId,
      {
        encoding: "jsonParsed",
        filters: [
          { dataSize: 165 }, // classic SPL token account layout
          { memcmp: { offset: 0, bytes: mint } }, // mint field is first
        ],
      },
    ]);
    return r.value.map((acc) => ({
      owner: acc.account.data.parsed.info.owner,
      amount: BigInt(acc.account.data.parsed.info.tokenAmount.amount),
    }));
  }
}

/**
 * Fetch the holder register for `mint` and validate it the same way the
 * on-chain instruction will. Zero-balance accounts are dropped.
 * Throws if the remaining holders do not sum exactly to the supply.
 */
export async function fetchSnapshot(rpc, mint) {
  const [{ amount: supply }, accounts] = await Promise.all([
    rpc.mintSupply(mint),
    rpc.tokenAccounts(mint),
  ]);

  // Merge by owner (a wallet can hold several token accounts), drop zeros.
  const byOwner = new Map();
  for (const { owner, amount } of accounts) {
    byOwner.set(owner, (byOwner.get(owner) || 0n) + amount);
  }
  const holders = [...byOwner.entries()]
    .filter(([, amount]) => amount !== 0n)
    .map(([owner, amount]) => ({ owner, amount }));

  const sum = holders.reduce((a, h) => a + h.amount, 0n);
  if (sum !== supply) {
    throw new Error(
      `supply mismatch: holders sum to ${sum}, mint supply is ${supply}`
    );
  }
  return { holders, supply };
}

// ---------------------------------------------------------------------------
// Base58 — encode + decode, Bitcoin-style alphabet, no '0OIl'.
// ---------------------------------------------------------------------------

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58_ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes) {
  const bytesArr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (bytesArr.length === 0) return "";
  let num = 0n;
  for (const b of bytesArr) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  // Leading zero bytes -> leading '1's.
  for (const b of bytesArr) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

export function base58Decode(str) {
  if (str.length === 0) return new Uint8Array(0);
  let num = 0n;
  for (const c of str) {
    const v = B58_MAP.get(c);
    if (v === undefined) throw new Error(`invalid base58 character: ${JSON.stringify(c)}`);
    num = num * 58n + BigInt(v);
  }
  // Count leading '1's -> leading zero bytes.
  let zeros = 0;
  for (const c of str) {
    if (c === "1") zeros++;
    else break;
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  return out;
}

/** Assert the input decodes back to exactly `len` bytes (pubkey check). */
export function decodePubkey(str, len = 32) {
  const bytes = base58Decode(str);
  if (bytes.length !== len) {
    throw new Error(`expected ${len}-byte pubkey, decoded ${bytes.length}`);
  }
  return bytes;
}
