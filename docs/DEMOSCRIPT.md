# Owed - Demo Script

This is the script of the **recorded cut**: <https://youtu.be/kjw0M-7p0D4>
(2:10). It is PreStocks-first, so the bounty judge sees their eight tokens in
the first twenty seconds, and it serves the main track unchanged.

The video is five stops in one take. Three browser tabs, left to right, then a
terminal. `Ctrl+1/2/3` switch tabs; `Alt+Tab` reaches the terminal. Nothing is
hunted for with the mouse on camera.

| Stop | Tab | Screen | Keystroke |
|---|---|---|---|
| 1 | Tab 1 | Front page hero | start here |
| 2 | Tab 2 | `/board?issuer=prestocks` - the roster | `Ctrl+2` |
| 3 | Tab 1 | Holdings paste, then Connect wallet | `Ctrl+1` |
| 4 | Tab 3 | `/integrate` - the fix and the devnet evidence | `Ctrl+3` |
| 5 | Terminal | `node scripts/verify-rpc-mechanism.mjs PPLTx` | `Alt+Tab` |

> **Presenter rules that held on the recording and hold for any re-take.**
>
> - The hero count moves with every six-hourly refresh. Read it off the page;
>   never quote a memorised number in a video about out-of-date numbers. The
>   stable clause is *"for five of them the number an app shows is at least 2x
>   too low."*
> - Say *stock*, *split*, *the number apps show*, *the number the blockchain
>   uses*. The words *mint*, *rebase*, *stored field* and *runtime* appear on
>   screen (the terminal prints them); the voiceover never speaks them.
> - The terminal is live: `clock now` changes every run. That is the point -
>   it proves the call is real. Do not read the printed jargon lines aloud.
> - Wallet on camera: connecting exposes the address in a public video, so it
>   is shown on a wallet that is fine being public. No signature is requested.

---

## Beat 1 - Tab 1 - 0:00 - The hero

Top of the page, nothing clicked. Let the line land before speaking.

> "In this video I want to show you one thing, and it is simpler than it
> sounds. When a company splits its stock you end up with more shares at a
> lower price each, and on Solana the blockchain applies that change on its
> own. Your app can still show the old number while nothing warns you, so Owed
> checks what an app would read against what Solana actually applies."

## Beat 2 - Tab 2 - 0:20 - The PreStocks roster

Eight rows. Point at SPACEX (`1 5 400%`) and OPENAI (`1 1.4861 48.6%`), glance
at the six clean rows so the "only screams" line has something behind it.

> "Here is the full official PreStocks roster, all eight tokens on one screen,
> and six of them are fine today. I show you those on purpose, because a
> monitor that only ever screams is not one anyone would trust. Two are not
> fine. SPACEX carries a value of one while the blockchain applies five, so
> anything reading it is five times too low, and OPENAI sits at one against
> one point four eight six."

## Beat 3 - Tab 1 - 0:45 - A real position

Scroll to **Check your holdings** and paste two lines, Enter between them:
`SPACEX 2 50000`, then `OPENAI 10 1200`. Click **Check my holdings**; it must
read "2 of the 2 holdings". One silent beat on the dollar pair.

> "So here is a real position. I paste two lines, two units of SpaceX and ten
> of OpenAI, with the value my app reports, and Owed marks both as valued with
> a number the blockchain does not use. The app says fifty thousand dollars,
> the chain says two hundred fifty thousand, and a lender reading the old
> number sees a fifth of the collateral that is really there."

## Beat 4 - Tab 1 - 1:10 - The wallet

Click **Connect wallet**; let the count render before speaking.

> "When I connect a real wallet, Owed reads what that address actually holds
> and gives the same verdict for every position it finds, so this is not a
> calculator you type into, it is a check against the chain."

## Beat 5 - Tab 3 - 1:25 - The fix

Frame three things only: the two badges (**Measurement / reads mainnet**,
**Settlement / devnet, unaudited**), the Program and Deploy transaction rows,
and the two **rejected** rows. Do not narrate all fifteen steps.

> "The fix is one call. Owed ships a function called get effective
> multiplier, you give it the token, and it returns the number the blockchain
> is applying right now. It also comes as a feed with a schema, so anything
> you build can pick it up."

## Beat 6 - Terminal - 1:45 - The proof, then the close

Start the sentence, then press Enter. The output prints in about a second;
point at `multiplier 1`, `which one applies? not in the response`, and
`disagreement 10.000000x`.

> "Here are two calls to the same node on the same token. One reads the value
> inside the account, the other reads the scaled supply, and they disagree by
> a factor of ten. The chain is correct and the mistake lives in code that
> reads the old value. The settlement program is devnet only and not audited,
> and that is the point, because the number you trust should come from the
> chain and not from a field someone forgot to update."

Hold two seconds. Stop recording.

---

## Shot list (as recorded)

| # | Time | On screen | Beat |
|---|---|---|---|
| 1 | 0:00 | Hero, headline and counter | The split, and the two numbers |
| 2 | 0:20 | `/board?issuer=prestocks` | Eight tokens, six clean, two wrong |
| 3 | 0:45 | `Check your holdings` verdict | $50,000 shown, $250,000 real |
| 4 | 1:10 | Connected wallet count | Not a calculator - a check against the chain |
| 5 | 1:25 | `/integrate` badges + devnet rows | The one-call fix, the honest scope |
| 6 | 1:45 | Terminal, `verify-rpc-mechanism.mjs PPLTx` | 10.000000x, then the close |

## Depth the cut skipped (optional beats for a longer or re-recorded take)

The recorded cut stays inside two minutes and leaves the front page's own
explanations out. They are still the fastest way to answer follow-up questions
live, and each cue below is guarded against the page renaming itself:

- **How it works** - the three-step explanation (a split does not change what
  you own; apps keep a copy that falls behind; Owed shows both). The section
  that makes the product legible to someone who has never held a token.
- **What that means in money** - the fold on a token card that puts a position
  behind the percentage. Price and position size cancel out of the error, so
  the consequence holds at any size: a lender reading the wrong number sees a
  fraction of the collateral that is really there.
- **Everything found across 933 stocks** - the findings fold, and its
  *"need attention"* count. Most gaps are a fraction of a percent; the median
  is small, and saying so is the difference between a finding and a pitch. Two
  are off by ten times, and those are the ones that matter.

## Definition of done (as met by the recorded cut)

- [x] One continuous take, five stops, no mouse hunting
- [x] The roster beat shows all eight PreStocks tokens inside the first half minute
- [x] The holdings paste reads "2 of the 2 holdings" with both dollar facts on screen
- [x] The wallet beat renders a real count before it is narrated
- [x] `node scripts/verify-rpc-mechanism.mjs PPLTx` runs on camera and prints `10.000000x`
- [x] No jargon words spoken: no *mint*, *rebase*, *stored field*, *runtime*
- [x] The devnet-only, not-audited scope is spoken, not skipped

## If you only get one minute

Beats 1 and 3. One sentence on the split, then the paste: fifty thousand
shown, two hundred fifty thousand real. That is the whole argument, and it
asks the judge to trust nothing.
