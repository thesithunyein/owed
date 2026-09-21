# Owed — Demo Script

~2:30. Every number on screen is reproducible from the repo in one command.

> **Note on an earlier draft.** This script previously opened with "a tokenized
> equity nobody adjusted is quoting the wrong price on every Solana AMM, 4× wrong."
> That is **false** and was removed. The Token-2022 runtime *does* apply the
> effective multiplier, and the venues we checked agree with each other to within
> 0.6%. The real defect is narrower and is what this script now shows: the *stored
> field* is stale, and anything reading it computes the wrong balance.

---

## 0. The line (0:00–0:15)

> "379 of the 925 tokenized stocks on Solana have a stale multiplier field
> on-chain right now. Two of them are off by a factor of ten. Here is the proof
> against the chain, and here is the drop-in fix."

Say it flatly. No adjectives. The numbers carry it.

## 1. The harm, clickable (0:15–0:55)

Open `web/differential.html`. It works from disk — no server, no build, no key.

1. It loads showing **379 stale of 925**, re-classified against the viewer's clock.
2. Select `NFLXx` (the default, worst first). Set position `100000`, debt `10000`.
3. The two panels read **$10,000** against **$100,000**. Same position.
4. The verdict banner: *"sees this position at 100.0% loan-to-value and liquidates
   it — while it is genuinely at 10%."*

Say: *"Price and position size cancel out of this, so it holds at any size. A
lending market reading the stored field liquidates a healthy position, and the
error belongs to the stale field, not the borrower."*

Then scroll the table. Say: *"Most of these are small — the median is a third of a
percent. Two are not."* Saying that is the point.

## 2. The reader is verified against the chain (0:55–1:25)

Terminal:

```bash
node scripts/conformance.mjs --all
```

It prints one dot per mint, then:

```
924/924 mints match the Token-2022 runtime (tolerance 1e-9), 1 not checked
```

Say: *"This compares our rule against `getTokenSupply` — the runtime's own scaled
amount — for all 925 official mints. Nine decimal places. The rule was an
assumption this morning; now it's measured. One mint hit a transient 403, and
`--only ARx` retries it on its own."*

Optionally also:

```bash
node scripts/verify-trap.mjs        # 8/8 traps match the pending multiplier
node scripts/collateral-scenario.mjs
```

## 3. The integration surface (1:25–1:55)

Open `feed/owed-risk.json` beside `feed/schema.json`. Show two things:

1. Each token carries the **raw `scaledUiAmountConfig` state** next to our answer.
2. `effectiveMultiplier` is stamped with the `clock` it was computed at.

Say: *"You don't have to trust this feed — it publishes the raw state so you can
recompute the rule and disagree with us. And a test enforces that: every published
value has to be reproducible from the published inputs, or CI fails. A feed that
only publishes its own conclusions is unauditable."*

## 4. Breadth, and the surface nobody markets (1:55–2:15)

Open `web/board.html`. Say: *"All 925 mints, same offline property."*

Then point at the control column: *"Every single official xStock carries a
permanent delegate and a pause authority — 925 of 925. One compromised issuer key
can freeze or confiscate any holder's balance. That is not an attack, it is a
capability, and no wallet UI shows it."*

## 5. What is not done (2:15–2:30)

> "What you just saw is real and reproducible: the scan, the conformance proof,
> the feed, both pages. What is not: the on-chain registry that would *fix* this
> rather than report it is reference source — `programs/owed/` has not been
> compiled, deployed, or audited, and I am not going to pretend otherwise. And we
> tried to show a major aggregator misstating these supplies; our own controls
> failed, so we dropped the claim instead of shipping it."

That paragraph is worth more than a third feature.

## 6. Why Solana (2:30–2:40)

> "Tokenized equities are on Solana, and the mechanism causing this —
> Token-2022 Scaled UI Amount — only exists here. A correctness layer for it can
> only be built where the tokens are."

---

## Definition of done

- [ ] Harm page opens from disk with numbers live at recording time
- [ ] `node scripts/conformance.mjs --all` runs on camera and prints 924/924
- [ ] Feed and schema shown side by side, recomputability stated
- [ ] Board's 925/925 control-surface count shown
- [ ] The honesty paragraph is in the video, not only in the README
