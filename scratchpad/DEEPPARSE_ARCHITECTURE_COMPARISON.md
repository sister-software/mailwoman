# Deepparse's approach vs ours — and why it wins house_number

2026-07-16. Deeper architectural read requested before the H1 findings go to the digit-ownership
agent. **This supersedes nothing in `DEEPPARSE_H1_RESULT.md`; it explains it.**

## Verdict in one line

Deepparse's house_number lead is **not a better prior. It is a different tagging unit.** They emit
one tag per WORD; we emit one tag per SUBWORD PIECE and assemble BIO. A digit run like `39A` gets one
decision from them and three from us — and ours disagree with each other.

## The architectures, side by side

|                     | mailwoman v6.3.0                            | deepparse (bpemb)                                                                      |
| ------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| encoder             | transformer, 6 layers, h=384                | LSTM encoder                                                                           |
| tagging unit        | **SentencePiece piece**                     | **word**                                                                               |
| word representation | pieces stay separate                        | subwords LSTM-pooled → **one vector per word** (`EmbeddingNetwork`, last hidden state) |
| label dependency    | **none learned**                            | **autoregressive**: `P(tag_t \| tag_{t-1}, hidden)`, teacher-forced p=0.5              |
| decode              | Viterbi over a **0/-inf legality mask**     | LSTM decoder loop, prev tag feeds next step                                            |
| schema              | 33 BIO labels over the `ComponentTag` union | 8 flat fields + EOS                                                                    |
| intra-word split    | **possible** (and happens)                  | **impossible by construction**                                                         |

## The measured mechanism

`Tindvegen nedre 44B`, every piece, our model:

```
i  span    text   ARGMAX           P(B-pc)  P(B-hn)  P(I-pc)  P(I-hn)
7  16,17   "4"    B-house_number   0.105    0.604    0.074    0.001
8  17,18   "4"    I-postcode       0.013    0.058    0.587    0.194
9  18,19   "B"    I-postcode       0.004    0.005    0.765    0.134
```

The model **starts** the span as a house number (0.604!) and **continues** it as a postcode.
`B-house_number → I-postcode` is an illegal BIO transition (NEG_INF in the structural mask), so
Viterbi must pick a legal path, and the postcode-consistent one scores higher because the
continuations are confident. **Viterbi is doing its job correctly. The emissions are incoherent.**

Same shape on `Epleskogen 39A` (piece `"3"` → B-house_number 0.313 vs B-postcode 0.227; pieces
`"9"`,`"A"` → I-postcode 0.657/0.643).

### The word-consistency heal can't save it — and that's not a bug

`word-consistency.ts` is precisely the intra-word repair: collapse B-X/I-X per `▁`-delimited word,
vote by summed softmax mass, force one tag. Run the vote on `▁3|9|A`:

```
postcode mass     0.227 + 0.657 + 0.643 = 1.53   <- wins
house_number mass 0.313 + 0.117 + 0.219 = 0.65
```

It works exactly as designed and still lands on postcode, because the first piece is outvoted 3-to-1
by its own continuations. That is why toggling it changes nothing (measured: ship / no-heal /
no-repair / argmax-decode all → postcode on all four failing rows).

**So the defect is not in any decoder, mask, vote, or repair pass.** It is the model's belief that a
digit-run _continuation_ is a postcode. Everything downstream faithfully propagates that belief.

## Why deepparse cannot have this bug

`EmbeddingNetwork` — "aggregate the byte-pair embeddings from decomposed words" — runs an LSTM over
each word's BPE pieces and keeps the **last hidden state**: one vector per word. The decoder then
emits one tag per word. There is no such thing as an intra-word disagreement in their model. `39A` is
one word, gets one vector, gets one tag.

Their digit prior is then free to be clean, and it is — measured, 3/3 per cell, zero exceptions:

```
1-3 digits (± letter)  -> house_number   18/18
4-6 digits (± letters) -> postcode       15/15
```

Ours is a constant function (`postcode`, 33/33) because **every multi-piece digit run gets dragged to
postcode by its continuations**.

## Our tokenizer makes this maximally likely

Digits tokenize **one piece per character**:

```
121 -> [1|2|1]      9600 -> [9|6|0|0]      90210 -> [9|0|2|1|0]      39A -> [3|9|A]
16a -> [16|a]       (some multi-digit pieces exist, e.g. "16")
```

So **fertility ≡ digit-run length** for this class. Every digit run of length N produces N
independent tag decisions, N-1 of which are continuations, and continuations are where the postcode
mass lives.

**Caveat, stated because it limits the claim:** fertility and digit-length are _confounded_ in our
vocab — they are the same variable — so no experiment on the current tokenizer can separate "long
digit run" from "many pieces". H10 also refuses to be a clean law: `44B` → house_number in both
`Main St 44B` and `Epleskogen 44B`, yet `Tindvegen nedre 44B` → postcode; `Main St 7` → street. It is
a mass competition modulated by context, not a rule.

## Against the plan: this is #727's part 2, and the research called it

`project-727-fix-path-research` (2026-06-19) says the fix is **two-part**:

> (1) Span-level head … word-pool subwords → score whole `(i,j)` spans as atomic units →
> `VERMONT→VER+MONT` **impossible by construction**. (2) Lower-fertility multilingual vocab …
> **Tokenizer fix is UPSTREAM of the span fix** — a span head needs a defined "word" to pool over,
> which byte runs don't give it. Real remedy = vocab + head, **NOT a decode-time vote**.

Three things line up:

1. **`39A` → `B-house_number` + `I-postcode` IS `VERMONT → VER+MONT`.** Same bug class — intra-word
   tag fragmentation — one tag family over. The research diagnosed it on admin tokens; this is the
   digit family. It is one defect, which is what the v2 brief's "one defect, four instruments"
   section already suspected.
2. **Deepparse is a shipping instance of the research's part 1.** Word-pooling subwords into one
   vector is exactly "impossible by construction", and it is precisely where they beat us.
3. **"NOT a decode-time vote" was right.** `enforceWordConsistency` is the decode-time vote, it is
   default-ON since #1132, and the arithmetic above shows why it cannot reach this class.

### The uncomfortable part: ordering

The span head (part 1) was closed 2026-07-16 on a pre-registered kill shot (seg@1 54/63 vs token@1
56/63, −3.2pp). That verdict is legitimate **under the conditions it ran in** — and those conditions
were: _without part 2 underneath_. The research's own claim is that the tokenizer fix is **upstream**,
because "a span head needs a defined 'word' to pool over, which byte runs don't give it." Digit runs
are exactly byte runs: `[9|6|0|0]`.

I am not re-opening the closure — it was pre-registered and it held. I am flagging that
[[feedback-scar-tissue-conditional-not-universal]] applies with unusual force here: the span head was
tried in the order the research predicted would fail. Whether that's worth anything is an operator
call, not mine, and it costs nothing to leave the verdict standing while part 2 gets tested on its
own.

## The one lever the scar tissue does NOT forbid

`reference-crf-ce-only-divergence` is precise: v0.4.0's **dual loss** diverged because the CRF NLL
gradient dominated CE 8–20×, so v0.5.0 dropped the CRF _loss_ and kept "CRF for inference only —
frozen transition mask + Viterbi." That scar forbids `crf_loss_weight > 0`. **It does not forbid
having informed transitions.**

And the slot is already built, documented, and empty:

```ts
// weights.ts — resolves crf-transitions.json → { transitions, start_transitions, end_transitions }
export function readCrfTransitions(crfPath) …   // "learned CRF transition parameters"

// classifier.ts — composes ADDITIVELY over the legality mask
this.transitions = cfg.transitions ? addMatrices(structural, cfg.transitions) : structural

// viterbi.ts — the mask is pure legality, zero preference
row[to] = isValidTransition(fromLabel, toLabel) ? 0 : NEG_INF
```

`crf-transitions.json` ships in **neither** weights package. A **corpus-counted label-bigram
log-probability matrix** — count `P(tag_t | tag_{t-1})` over the training corpus, log it, write the
file — fills that slot with **no training, no gradient, and no `crf_loss_weight`**, so it cannot
re-open the v0.4.0 divergence. It buys the one capability deepparse gets from its autoregressive
decoder.

**Feasibility, measured:** every emission margin on the failing rows is **under 2 nats**
(`Epleskogen 39A` −0.32, `aleja Wojska Polskiego 178` +0.20, `Øvste Skogen 121` +0.54,
`14 Glen Neaves` +1.65). That is the regime where a few-nat transition prior can decide the outcome.

**Honest caveats, because this is a hypothesis and not a result:**

- A first-order bigram sees only the previous tag. Deepparse's decoder carries an LSTM hidden state
  over the whole prefix plus optional attention. Strictly weaker.
- The decisive competition here is `B-hn → I-pc` vs `B-pc → I-pc`. A bigram prior **can** express
  that (it would penalise `street → B-postcode` and reward `street → B-house_number`), but the
  continuation mass is large (0.587–0.765) and a log-prob delta may not overcome it. **Unmeasured.**
- It does not touch the root cause. The model still believes digit continuations are postcodes; this
  would paper a prior over it. The vocab fix is the actual remedy the research names.

## What I'd tell the digit-ownership agent

1. Stop looking for the flip downstream. It isn't Viterbi, the heal, postcodeRepair, the anchor
   (already ablated), or class weights (identical, verified). All four measured inert on this class.
2. The defect is **intra-word emission incoherence**: first piece says house_number, continuations
   say postcode, everything downstream faithfully resolves to postcode.
3. It is the same defect as `VERMONT → VER+MONT`, so it should be fixed by the same lever, and the
   research already named that lever: **lower-fertility vocab**, upstream of any head.
4. The cheap, scar-tissue-legal probe in the meantime is the empty `crf-transitions.json` slot.
5. Nothing here proposes a hard postcode validator; the house rule stands and the shape of the fix
   is representation, not veto.
