# Owed - Demo Script

Target **2:00-2:20**. One take is the goal: the app ships a guided tour
(`docs` aside, it is the **"60-second guided demo"** button on the front page),
so the screen does the sequencing and you narrate over it. Press `→` to advance,
`Esc` to exit.

Every number on screen is reproducible from the repo in one command. Nothing here
is read from a slide.

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

<!-- NOTE FOR THE PRESENTER: the counts move as activations pass. Read them off the
     page's own counter - it re-classifies against your clock - or from the
     README's generated block. Saying a stale number out loud, in a demo about
     staleness, is the one unforced error available here. -->

---

## 0. The line (0:00-0:12)

> "Two RPC calls to the same node, for the same mint, disagree - and neither one
> is marked as the wrong one."

Do not open with a number. Open with the disagreement, because it needs no trust:
the viewer can run it themselves in ten seconds. Say it flat, no adjectives.

## 1. The proof, before any product (0:12-0:45)

Press the **guided demo** button, or scroll to *"Two RPC calls on the same mint"*.
Both commands are on the page and copyable.

1. `getAccountInfo` returns `multiplier: 1` beside `newMultiplier: 10` and the
   timestamp the switch takes effect. Point at the line that says
   **"which one applies?  not in the response."**

   > "There is no field in this response that says which of the two is in force.
   > The answer is that timestamp compared against the clock, and only the
   > consumer can do it. Nothing here warns you."

2. `getTokenSupply`, same node, same mint, returns a `uiAmount` the runtime has
   **already scaled**.

   > "So the same node tells me two different things about the same mint, and
   > neither response is marked wrong. On this mint they differ by ten times."

Then say the line that makes it a product problem rather than an anecdote:

> "This is verified in one command against a live mint -
> `node scripts/verify-rpc-mechanism.mjs PPLTx`. It exits non-zero when a mint
> does *not* diverge, so a clean result counts as a result."

## 2. Not one team's reading (0:45-1:05)

Scroll to *"Three independent sources, not our reading alone"*.

> "This is understood elsewhere. Solana's own explorer implements the same
> selection rule in production. Kamino's lending oracle parses this extension
> from raw bytes - at the same offsets we derived independently - and it suspends
> its price for twenty-four hours ahead of a scheduled switch. It even documents
> that an activation timestamp may already be in the past when it is published.

> So the hazard is known. What nobody publishes is **which mints are in that state
> right now**. That is the gap, and it is the whole product."

## 3. The scale, and the honest tail (1:05-1:35)

Step to *"What we found"* (the fold behind the counter).

> "Across 933 official mints, 385 read a stored multiplier the runtime does not
> apply. Two issuers, same Token-2022 template."

Then scroll the table, and say the sentence that earns credibility:

> "Most of these are small. The median error is a fraction of a percent. Two are
> off by ten times, and those are the ones that matter. An earlier version of this
> project claimed the whole set was dangerous; it isn't, and saying so is the
> difference between a finding and a pitch."

## 4. What it costs someone (1:35-1:55)

Search `PPLTx` and put a position behind it. The two panels read the same
position at two different values; the verdict banner names the loan-to-value.

> "Price and position size cancel out of this entirely, so it holds at any size.
> A lender reading the stored field liquidates a healthy position - and the error
> belongs to the field, not to the borrower."

If there is time, go to the pasted-holdings box and paste two tickers. It needs
**no wallet**: the answer comes before any connection prompt.

## 5. The fix, in the language you already use (1:55-2:15)

Open `/integrate`.

> "The fix is a function call. JavaScript: `getEffectiveMultiplier(mint)`, zero
> dependencies, no key. Rust, if you are a program rather than a client -
> `read_multiplier` rides along with the mint account you already load. Or read
> the feed. There is a `jq` one-liner for each."

Scroll to the devnet table.

> "And the registry that *settles* these actions is compiled for SBF, running on
> devnet, with fifteen steps - thirteen signed transactions and two paths that
> must refuse - all linked to the explorer. It runs on a throwaway validator on
> every push too, so it is not a one-off."

## 6. What is not done (2:15-2:30)

Say this plainly. It is worth more than another feature.

> "What is not done: the program is **not audited**, and it is on devnet, not
> mainnet - so it is not pointed at real assets and I am not claiming it is. The
> Pyth lane publishes one measured basis, not many, because most of the reference
> feeds for these wrappers are stale and I would rather publish one real number
> than twenty manufactured ones. And the traction is honest: no external team has
> adopted the reader yet. The outreach is written and sent; one reply is what this
> needs."

## 7. Why Solana (2:30-2:40)

> "Tokenized equities are on Solana, and the mechanism causing this -
> Token-2022 Scaled UI Amount - only exists here. A correctness layer for it can
> only be built where the tokens are."

---

## Shot list

| # | Time | On screen | Beat |
|---|---|---|---|
| 0 | 0:00 | Front page, hero | The disagreement, stated flat |
| 1 | 0:12 | `#mechanism` section | Two calls, two answers, no warning |
| 2 | 0:45 | `#corroboration` | The explorer and Kamino already implement the rule |
| 3 | 1:05 | The findings fold | 385 of 933, and the honest median |
| 4 | 1:35 | `PPLTx` result + holdings box | What it costs a position, no wallet needed |
| 5 | 1:55 | `/integrate` | The fix in JS, Rust and HTTP; devnet table |
| 6 | 2:15 | Back to camera | What is not done |
| 7 | 2:30 | Close | Why it can only be built here |

## Definition of done

- [ ] Front page opens and the counter is live at recording time
- [ ] The two-RPC section is on screen long enough to read the **"not in the response"** line
- [ ] `node scripts/verify-rpc-mechanism.mjs PPLTx` runs on camera and prints `10.000000x`
- [ ] The agreement section names both outside implementers, not just us
- [ ] The median-is-small sentence is in the video, not only in the README
- [ ] The devnet table is shown with its signatures
- [ ] The not-audited, not-on-mainnet, no-adopters paragraph is spoken, not skipped

## If you only get one minute

Section 1. Two RPC calls that disagree, on a live mint, reproducible in one
command. That is the whole argument, and it asks the judge to trust nothing.
