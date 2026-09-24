# Owed - Demo Script

Target **2:00-2:20**. One take is the goal: the app ships a guided tour (the
**"60-second guided tour"** button on the front page), so the screen does the
sequencing and you narrate over it. Press `→` to advance, `Esc` to exit.

The page is now written for someone who has never used a wallet: it opens with
*"Know what your tokenized stocks are really worth"*, explains the problem in
three steps under **How it works**, and answers the obvious objections under
**Questions**. Narrate in that register. A judge scoring "could this be a real
app that people will actually use?" is watching for whether you can explain it
without jargon - so the words *mint*, *rebase*, *stored field* and *runtime*
should not be spoken once on camera. Say *stock*, *split*, *the number apps
show*, *the number the blockchain uses*.

> **Two corrections to earlier drafts, both worth knowing before you record.**
>
> 1. An early version opened with *"a tokenized equity nobody adjusted is quoting
>    the wrong price on every Solana AMM, 4x wrong."* That is **false** and was
>    removed. The Token-2022 runtime applies the effective multiplier correctly,
>    and the venues we checked agree with each other to within 0.6%. The real
>    defect is narrower: the *stored field* stops matching the runtime, and
>    anything reading it computes a different balance.
> 2. A later version said the on-chain registry *"has not been compiled, deployed,
>    or audited."* Two of those three are now out of date. The program **is**
>    compiled for SBF and **is** live on devnet with explorer-verifiable
>    signatures. Only the audit is still missing, and so is mainnet. Saying
>    otherwise on camera undersells the strongest engineering artifact here.

Also stale: a third draft sent the camera to *"Two RPC calls on the same mint"*
and *"Three independent sources, not our reading alone"*. Both sections were
removed from the page when it became a product instead of an argument. The
two-RPC disagreement is now a terminal command (beat 5) and the corroboration
lives in the README. Do not scroll looking for them.

<!-- NOTE FOR THE PRESENTER: the counts move as activations pass. Read them off the
     page's own counter - it re-checks against your clock - or from the README's
     generated block. Saying an out-of-date number out loud, in a demo about
     out-of-date numbers, is the one unforced error available here. -->

---

## 0. The line (0:00-0:15)

Front page, hero. Let the headline sit on screen.

> "When a company splits its stock, the price per share changes. The blockchain
> makes that change on its own - but the app you use can keep showing the old
> number, and nothing tells you. Owed shows you both."

Then point at the counter under the search box, and read it off the page:

> "Three hundred and eighty-five of nine hundred and thirty-three tokenized
> stocks are showing a number the blockchain does not use - and five of them are
> out by a factor rather than a fraction. That is not a warning: it is a
> measurement, and it updates every six hours."

Do not open with a number you have memorised. Open with the split, because a
split needs no explanation, and the viewer already believes it.

## 1. Why you would not have noticed (0:15-0:40)

Scroll to **How it works** and read the three steps as you pass them. This is
the section that makes the product legible to someone who has never held a
token.

> "Step one, a split is not supposed to change what you own: more shares, each
> worth less. Step two, apps keep their own copy of the price per share, and a
> copy can fall behind - when it does, the value it shows is too low by exactly
> the size of the split, and the screen looks normal. Step three is the product:
> paste a ticker or a whole list and see both numbers, side by side, in your
> browser, with no wallet and nothing to install."

If you have fifteen spare seconds, open one question in **Questions** - *"Why
would the number my app shows be wrong?"* - and let the answer do the work
instead of saying it twice.

## 2. The checker, on the worst one (0:40-1:05)

`PPLTx` is already rendered - the page opens on the worst case, so there is
nothing to search for. (Searching it again re-renders the same card.)

> "This is the worst case on the page. Most apps show one times; the blockchain
> uses ten. An app showing the first number is wrong by nine hundred percent."

Read the day count off the card rather than from memory - it is live, and it
moves. "...and it has been that way for {card} days."

Open **What that means in money** on the same card and leave the defaults.

> "Price and position size cancel out, so this holds at any size: a lender
> reading the wrong number sees a hundred thousand dollars of collateral as ten
> thousand, and sells a healthy position. The mistake is the app's, not the
> borrower's."

## 3. A whole book, no wallet (1:05-1:20)

Scroll to **Check your holdings** and paste four tickers with amounts -
`AAPLx 12.5`, `PPLTx 3`, `SPACEX 2 50000`, `TSLAx 10`. Press the button.

> "This is the question a risk desk actually asks, and it needs no address and
> no connection: three of four lines are valued with a number the blockchain
> does not use. Nothing typed here leaves the browser."

## 4. The scale, and the honest tail (1:20-1:40)

Open the fold: *"Everything found across 933 stocks"* - and read the *"need
attention"* count on the right of that heading, not the one you memorised.

> "Across nine hundred and thirty-three stocks from two issuers, three hundred and
> eighty-five are in that state. Most of them are small - the median is a
> fraction of a percent. Two are off by ten times, and those are the ones that
> matter. An earlier version of this project claimed the whole set was dangerous;
> it isn't, and saying so is the difference between a finding and a pitch."

## 5. The fix, and the one command that proves it (1:40-2:05)

Open `/integrate`.

> "The fix is a function call. JavaScript: `getEffectiveMultiplier`, zero
> dependencies, no key. Rust, if you are a program rather than a client. Or read
> the feed - there is a `jq` one-liner for each."

Then switch to a terminal and run the proof:

```
node scripts/verify-rpc-mechanism.mjs PPLTx
```

> "Two RPC calls to the same node, same stock, and they disagree: the account
> response says one times, the supply the node itself returns says ten, and
> neither response is marked as the wrong one. That is the whole reason this
> exists, and it is reproducible from a clean checkout in one command."

Scroll to the devnet table.

> "The registry that settles these corporate actions is compiled for SBF and
> running on devnet, with fifteen steps - thirteen signed transactions and two
> paths that must refuse - all linked to the explorer. It runs on a throwaway
> validator on every push, so it is not a one-off."

## 6. What is not done (2:05-2:15)

Say this plainly. It is worth more than another feature.

> "What is not done: the program is not audited, and it is on devnet, not
> mainnet - so it is not pointed at real assets and I am not claiming it is. The
> Pyth lane publishes one measured basis, not many, because most of the reference
> feeds for these wrappers are out of date and I would rather publish one real
> number than twenty manufactured ones. And the traction is honest: no external
> team has adopted the reader yet. The outreach is written; one reply is what
> this needs."

## 7. Why Solana (2:15-2:20)

> "Tokenized equities are on Solana, and the mechanism causing this - Token-2022
> Scaled UI Amount - only exists here. A correctness layer for it can only be
> built where the tokens are."

---

## Shot list

| # | Time | On screen | Beat |
|---|---|---|---|
| 0 | 0:00 | Hero, headline and counter | A split changes the price; five of 933 are out by a factor |
| 1 | 0:15 | `#how` | Three steps, plain words, no wallet needed |
| 2 | 0:40 | `PPLTx` result + *What that means in money* | 1x vs 10x, and a lender selling a healthy position |
| 3 | 1:05 | `#holdings` | A whole book checked with no wallet |
| 4 | 1:20 | `#findings` fold | 385 of 933, and the honest median |
| 5 | 1:40 | `/integrate` + terminal | The fix, then `verify-rpc-mechanism.mjs PPLTx` |
| 6 | 2:05 | Back to camera | What is not done |
| 7 | 2:15 | Close | Why it can only be built here |

## Definition of done

- [ ] Front page opens and the counter is live at recording time
- [ ] The **How it works** three steps are on screen long enough to read
- [ ] `node scripts/verify-rpc-mechanism.mjs PPLTx` runs on camera and prints `10.000000x`
- [ ] No jargon words spoken: no *mint*, *rebase*, *stored field*, *runtime*
- [ ] The median-is-small sentence is in the video, not only in the README
- [ ] The devnet table is shown with its signatures
- [ ] The not-audited, not-on-mainnet, no-adopters paragraph is spoken, not skipped

## PreStocks bounty cut (record this second, ~35s)

The same footage serves both tracks, but the PreStocks bounty asks a narrower
question - what does this do for PreStocks' own tokens - so answer that directly
instead of making the judge find it inside a 933-row board.

1. Go to `board.html?issuer=prestocks` (or pick **PreStocks only (private,
   pre-IPO)** in the filter). All eight tokens on one screen.

   > "There are eight PreStocks tokens. Two of them are showing a number the
   > blockchain does not use: SPACEX is off by five times, OPENAI by one point
   > four eight six. The other six are clean, and I am naming them on purpose -
   > a monitor that only ever screams is not a monitor."

2. Type `SPACEX` into the front-page checker and put a position behind it.

   > "Anything reading the old number values a SpaceX position five times too
   > low, silently. That is a wallet, a lending market, or a tax tool - not a
   > hypothetical."

3. Show the feed's `preStocks` lane, then `/integrate`.

   > "All eight are in the feed, one row shape with the xStocks lane, and the fix
   > is one function call - `getEffectiveMultiplier`. Six hours later it re-runs,
   > and it only alerts when something actually changes."

4. Say the scope line once, because the bounty makes it an eligibility rule.

   > "Tessera is deliberately not integrated, so this stays inside the bounty's
   > token scope."

Keep the honesty paragraph (section 6): "six of the eight are fine" is worth
more to this judge than another divergent row.

## If you only get one minute

Section 0 and section 2. One sentence on the split, then `PPLTx`: most apps show
1x, the blockchain uses 10x, and here is what that does to a position. That is
the whole argument, and it asks the judge to trust nothing.
