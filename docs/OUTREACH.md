# Outreach pack

The finding is only worth what someone else does with it. This file is the
send-ready version: who to contact, the exact evidence for each of them, the
one-line fix, and a message that fits in a Discord DM.

**The one number that matters:** on **383 of 933** official mints, the on-chain
`multiplier` field is not the multiplier the runtime applies. Every case below
is reproducible by the recipient in two commands, which is why the messages ask
them to check rather than to trust us.

## Read this before sending

- **We are not accusing the issuer of a bug.** The runtime applies the scaled
  amount correctly. The defect is in *naive integrations* that read the stored
  field and stop. `docs/OUTREACH.md` and the messages below say exactly that,
  because a message that reads like a bug report against the issuer gets
  ignored, and a message that reads like a free audit of their integrators gets
  forwarded.
- **Why the field is stale is unknown.** A trap is consistent with an issuer
  that forgot to republish and with one that expects integrators to compute the
  effective value. Say so. `README.md` -> "What we could not establish" is the
  long version.
- **The fix is one line.** Lead with it. Anything longer than four lines before
  the fix is a message nobody finishes.

## The evidence, per target

### 1. Collateral and lending markets listing xStocks

If a position is priced off the stored field, the error is the factor column.

| symbol | mint | stored | chain applies | factor | stale for |
|---|---|---|---|---|---|
| PPLTx | `Xst6eFD4YT6sz9RLMysN9SyvaZWtraSdVJQGu5ZkAme` | 1 | **10** | **10x** | 130 days |
| NFLXx | `XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL` | 1 | **10** | **10x** | 311 days |
| PALLx | `XsTTtPA5V19YwHKDv4xeVXNM6kdsQNJvg3MyWkRUckt` | 1 | **5** | **5x** | 130 days |
| CRWDx | `Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw` | 1 | **4** | **4x** | 83 days |
| OPENx | `XsGtpmjhmC8kyjVSWL4VicGu36ceq9u55PTgF8bhGv6` | 1 | 1.02082 | 2.08% | 303 days |

A 10x understatement on collateral is the difference between a 50% LTV and a
500% LTV. That sentence is the whole message.

### 2. PreStocks (the second issuer)

Same template, different issuer, so this is a property of how the assets are
issued rather than one vendor's mistake. All 8 PreStocks mints carry the same
Token-2022 extension set as the xStocks set.

| symbol | mint | stored | chain applies | factor | stale for |
|---|---|---|---|---|---|
| SPACEX | `PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh` | 1 | **5** | **5x** | 105 days |
| OPENAI | `PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF` | 1 | 1.4861347 | **48.61%** | 68 days |

### 3. Wallets and portfolio trackers

Display-level, but the user-visible one: a holder of 1 PPLTx sees 1 token, while
the chain applies 10. The correct balance is the scaled amount, which the wallet
can get straight from `getTokenSupply` (`uiAmountString` is already scaled) or
from the SDK below.

### 4. Oracles, indexers and data vendors

The same trap at the data layer: whatever snapshot indexes `multiplier` as the
token's scale will keep serving the stale value after every activation. There
are 31 mints at 1% or more and 6 at 10% or more **today**; the set grows with
every dividend.

### 5. The Pyth angle (for anyone pricing these assets)

Pyth's own published reference accounts carry the same class of risk: of the 22
xStock wrapper feeds, 17 have a sponsored on-chain price account, and **16 of
those 17 were stale when we read them** - published 2 to 11 days earlier, with
only TSLAx fresh (4 hours). A consumer dividing by a stale oracle price adds an
error of the same order. We publish `staleReference` rather than a basis for
exactly that reason (`README.md` -> the Pyth lane).

## The one-line fix

```js
// Before: the stored field, which goes stale after every activation.
const m = mint.scaledUiAmountConfig.multiplier;

// After: the multiplier the runtime actually applies.
const m = await getEffectiveMultiplier(mintAddress);   // sdk/owed.mjs, no key needed
const display = toDisplayAmount(rawAmount, m);
```

Or, in any language, directly from the chain:

```
effective = now >= newMultiplierEffectiveTimestamp ? newMultiplier : multiplier
```

And the two-command repro you can hand them:

```bash
node sdk/example.mjs PPLTx        # stored 1, chain applies 10, stale 130 days
curl -s https://owed.sithunyein.com/feed/owed-risk.json | head -c 400   # the whole set
```

## Ready-to-send messages

### A. Lending market / collateral (Discord or Telegram dev channel)

> Hi - quick heads up that may touch your xStock collateral pricing. On 383 of
> 933 official tokenized-equity mints, the mint's `multiplier` field is not the
> multiplier the runtime applies (Token-2022 Scaled UI Amount: once the pending
> activation timestamp passes, the stored field stops being the value the runtime
> uses).
>
> Worst cases: PPLTx and NFLXx read 1 while the chain applies 10 (the two fields
> diverged 130 and 311 days ago); PALLx and CRWDx 5x and 4x. If you price a
> position off `scaledUiAmountConfig.multiplier`, you get that factor wrong.
>
> Fix is one line: read `effective = now >= newMultiplierEffectiveTimestamp ?
> newMultiplier : multiplier` (or `getTokenSupply.uiAmountString`, which is
> already scaled). Repro: `node sdk/example.mjs PPLTx` in
> github.com/thesithunyein/owed. Happy to send the exact mints you list if
> useful.

### B. Issuer (Backed / PreStocks)

> Hi - we built a public monitor for Token-2022 scaled-amount state on tokenized
> equity (github.com/thesithunyein/owed). Two things that may be useful:
>
> 1. Any integrator reading the stored `multiplier` field gets a different number
>    than the runtime applies once an activation has passed - on your set that is
>    381 of 925 mints right now, by up to 10x (PPLTx, NFLXx). It may be worth a
>    line in your integration docs: use the effective value, not the raw field.
> 2. The state is public and we publish it as an auditable feed
>    (owed.sithunyein.com/feed/owed-risk.json), with a schema, so integrators
>    can check themselves rather than take a number on faith.
>
> We are not claiming your runtime is wrong - the runtime is correct. We are
> claiming the field alone is not enough to build on. Happy to hand over the
> repro or answer questions.

### C. Wallet / portfolio tracker

> Hi - if your portfolio view reads a token's `scaledUiAmountConfig.multiplier`
> directly, balances for tokenized equities are wrong after every split or
> dividend: stored 1 vs effective 10 on PPLTx and NFLXx today (stale 130 and 311
> days). Fastest fix is `getTokenSupply` -> `uiAmountString`, which the runtime
> already scales. Repro and the full list: owed.sithunyein.com. Worth a check
> whichever of the 925 mints you list.

### D. Pyth / oracle consumer

> Hi - separate from the multiplier trap, we measured Pyth's sponsored on-chain
> price accounts for the 22 xStock wrapper feeds: 17 have live accounts and 16 of
> those were stale when read (2 to 11 days behind; only TSLAx was fresh, at 4
> hours). Consumer-side risk of the same kind. Details in the feed
> (`staleReference` per row: owed.sithunyein.com/feed/owed-risk.json). If you are
> pricing tokenized equities off these feeds, the freshness field is worth
> honouring.

## Tracker

One reply is worth more than any remaining line of code: "yes, this affects us"
is the traction proof judges ask for. Keep this table current.

| # | target | channel | sent | reply | what they said |
|---|---|---|---|---|---|
| 1 | Solana lending market listing xStocks |  |  |  |  |
| 2 | Second lending market / vault curator |  |  |  |  |
| 3 | xStocks issuer (integration docs) |  |  |  |  |
| 4 | PreStocks |  |  |  |  |
| 5 | Wallet or portfolio tracker |  |  |  |  |

## Ammunition if they push back

- **"The runtime handles it, so we are fine."** The runtime does; the reader is
  what goes stale. The claim is about the field, not the chain. Show the factor.
- **"We use the scaled amount already."** Point at `getTokenSupply.uiAmountString`
  in their own code path; if it is there, they are correct and the message
  becomes a forwarded heads-up to whoever indexes.
- **"Is this your measurement or the chain's?"** Both. `scripts/conformance.mjs`
  compares our reader to the runtime on all 925 mints at 1e-9 tolerance, and the
  trap mints are independently confirmed against the runtime's own supply.
- **"We cannot verify a stranger's numbers."** That is the point: the two-command
  repro and the JSON schema exist so verification does not require trusting us.
