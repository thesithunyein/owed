/**
 * Minimal Solana JSON-RPC client + snapshot builder. Zero dependencies —
 * Node 18+ built-in `fetch` only.
 *
 * The snapshot builder reproduces, off-chain, exactly what the on-chain
 * `snapshot_holders` instruction enforces: the holder set at the record
 * slot must sum to the mint supply. The keeper fetches, the Rust core
 * validates, and only then is a Merkle root published.
 */

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

  /** All token accounts for a mint: [{ owner, amount (BigInt) }]. */
  async tokenAccounts(mint) {
    const r = await this.call("getTokenAccountsBySupply", [
      mint,
      {
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        encoding: "jsonParsed",
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

/**
 * Base58 encode 32-byte pubkeys without dependencies (Bitcoin-style
 * alphabet, no '0OIl'). Enough for devnet tooling and tests.
 */
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes) {
  const bytesArr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
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
