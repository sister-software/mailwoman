---
name: five-whys
description: Root-cause diagnosis by successive why questions, with judgment jargon stripped to its facts. Ask each why of the evidence rather than the operator. Tag every claim observation, inference, decision, or unknown. Stop at an actionable cause or an unverified assumption. Give numbers their denominator and IDs their names. Use before proposing a fix, or whenever a diagnosis leans on a verdict adjective or a value judgment of its own work in place of the evidence.
---

# Five Whys Skill

## Why this exists

The repo already treats Five Whys as diagnostic doctrine: the invariance mini-suite is the #886 five-whys
follow-up, and the suffix-boundary interface change records its #1569 five-whys root cause. What the method
never had here is a language interface. Diagnoses kept shipping judgment words where facts belonged:

```text
The negative twin was mis-constructed — with Lyon in the raw text the register never hits, so nothing is
deleted.

The refutation is decisive and belongs on the issue.

The tightening paid for itself twice.
```

Each sentence has a fact underneath it, but the sentence does the reader's work: the adjective states the
conclusion and the mechanism stays in the author's head. Five Whys forces the mechanism out, because a
chain is only as strong as its weakest word — a link written as a judgment cannot survive the next why.

This skill operationalizes the house style's "Find the cause before proposing the fix" section. That section's
interface lives at `.claude/output-styles/mailwoman-development.md` — the output style the harness loads,
and the one authority for agent prose. It is a reasoning discipline rather than a
writing style: published docs pages are governed by `docs/engineering/writing-system.md` and its Vale
rules, and this skill governs diagnostic prose Vale never sees — chat messages, status reports, handoffs,
PR descriptions. Where the lists overlap (filler intensifiers, weasel quantities, anthropomorphism), this
skill inherits the same words rather than redefining them.

## When to use

- A failure's cause is not established and a fix is being considered.
- A draft diagnosis or another agent's report contains a judgment word (`decisive`, `mis-constructed`,
  `clearly`, `obviously`, `warrants its place`, `paid for itself`, `the real question is`) or a
  number with no denominator.
- The operator reports that a report is unintelligible, or asks what a term means.
- The operator asks "why", and the answer stops at an adjective.
- Before publishing any diagnosis: run the checklist at the bottom.

## When not to use

- Routine status narration with no failure at stake.
- A cause that is already direct and verified — do not force five levels.
- Prose for published docs pages — that is the writing system's register rather than a diagnosis.
- Small talk. Warmth is allowed. Agreement must contain information, per the house style.

## The method

Reproduce first, then ask why of the evidence rather than of the operator. The canonical chain and the evidence
categories come from `.claude/output-styles/mailwoman-development.md` § Find the cause before proposing
the fix:

1. Why did the final result fail?
2. Why did that stage choose the wrong value?
3. Why did its input or rule permit that choice?
4. Why did the test or pipeline fail to catch the condition?
5. Why does the system interface allow the condition?

Do not force exactly five levels. Use fewer when the cause is direct, more when evidence supports the
longer chain. Stop the chain at an **actionable cause**, meaning a specific stage, rule, input, or interface clause a
change can touch. Otherwise stop it at an **unverified assumption**, where the current evidence cannot answer the next
why. An unverified assumption is the chain's end and the next action's start: the probe that would answer
it is the next step.

Tag every link as one of:

- **observation** — a command, artifact, address, score, or log shows it
- **inference** — the evidence supports it, but no direct observation proves it. Write `LIKELY`.
- **decision** — the team chooses a tradeoff or product behavior. Name the tradeoff.
- **unknown** — the current evidence cannot answer it. The chain stops here.

A correlation is not a cause. Same antecedent plus same failure is a lead rather than a link. A link states the
mechanism by which the antecedent produces the failure. When the repository can answer the next why with a
focused diagnostic, run it before asking anyone anything.

## Which tool answers which why

The measurement tools answer the rungs in order. Use the ones present in the session. Prefer them to
asking the operator.

- **Rung 1** — what failed: a board run or comparison. Show the address.
- **Rung 2** — what the stage chose and why: `mwdev_trace`, `mwdev_diff_parse`, `mwdev_diagnose`.
- **Rung 3** — which input or constraint permitted it: `mwdev_minimal_pairs` (which token), `mwdev_lookup`
  (does the source know the string), `mwdev_constraints` (what a constraint cost).
- **Rung 4** — why the test did not catch it: read the test; `mwdev_census` (does the mechanism fire at
  all), `mwdev_interface` (does the tree obey its interface).
- **Rung 5** — why the interface allows it: read the interface, then the issue.
- **Assumption checks** — `mwdev_provenance` (which artifacts the engine is really reading),
  `mwdev_coverage`, `mwdev_sources`.

## The language interface

Jargon in a diagnosis is a judgment word or an undefined mechanism doing the work of a fact. The entries
below convert each into its fact. Every entry quotes a sentence that shipped in a `text` block, then states
what the sentence hides and gives its correction.

### 1. The construction error

```text
The negative twin was mis-constructed — with Lyon in the raw text the register never hits, so nothing is deleted.
```

What it hides: the construction error, and what the register matches on.

Write instead: "The negative twin contains Lyon in its raw text, so the delete register never matches it and deletes
no token. The fix is to rebuild the twin from the real control shape (no Lyon)."

### 2. The test's purpose

```text
Proving the test warrants its place — reverting the one-line fix and confirming it fails.
```

What it hides: a value judgment where the test's purpose belongs.

Write instead: "Reverting the one-line fix makes the test fail. The test detects that regression."

### 3. The differing row

```text
The board subset reads 41/58 resolved; the scoping agent's pre-fix baseline was 40/58. One row differs... Committing first so the comparison is against a clean tree.
```

What it hides: which row differs, whether the 17 unresolved share a cause, what was committed and whether the
measurement decides it.

Write instead: "The board subset reads 41/58 resolved (baseline 40/58). The one differing row is <address>. The 17
unresolved rows are separate until evidence groups them. I committed the fix before measuring so the comparison runs
against a clean tree. This measurement decides whether to keep the commit."

### 4. The verdict

```text
The refutation is decisive and belongs on the issue.
```

What it hides: the evidence behind the verdict.

Write instead: "Posting the refutation to the issue: it shows <observation>, which the issue's premise <quote> rules
out."

### 5. The remaining gap

```text
A refusal is already distinguishable — `intent_markers` carries `kind: poi_query` with a full message. The issue's framing is stale at HEAD. The real remaining gap is that the successful parse is discarded.
```

What it hides: what is distinguishable from what, what changed at HEAD, and why the gap is "real".

Write instead: "The trace records `intent_markers.kind = poi_query` with the full message, so a refusal is recoverable
from the parse output. The issue's example no longer matches HEAD (<the one thing that changed>). The remaining gap:
the successful parse is discarded at <stage> instead of being passed forward."

### 6. The overlay

```text
...under the harness's fr-FR overlay the street span swallows the commune (`street "Allée Pierre Barthas, Sète"`). The two production parse paths diverge (#1669), and the harness is the one that grades.
```

What it hides: what an overlay does, and what the divergence implies for the probe's result.

Write instead: "Under the harness's per-row country config for fr-FR, the street span's boundary includes the commune
text: `street "Allée Pierre Barthas, Sète"`. The CLI probe and the board run different parse paths (#1669). The
board's path is the graded one, so the probe's clean run does not transfer."

### 7. The standing failure

```text
The eval reads 383/384 — the new row passes, and the only failure is the standing es-op3-southeast-portopetro.
```

What it hides: what the eval keeps, what the new row asserts, why the standing row stands.

Write instead: "The eval reads 383/384. The new row (<address>) passes. The one failure is the standing es-op3 row for
`07691 Portopetro, Illes Balears, Spain` — open as <issue link> rather than caused by this change. I checked whether
other gauntlet rows share its failure shape (<n> do / none do)."

### 8. The presumed absence

```text
wof-hot.db does not exist on this host, so that test has never run here and cannot validate the deletion.
```

What it hides: where the agent looked. Absence is presumed rather than shown.

Write instead: "I checked <the paths the test resolves> and found no wof-hot.db on this host, so that test has never
run here. To verify the deletion I read <file:line> instead: does an unresolvable parent ever set query.parentID?" If
the file is later found to exist, triage why this check missed it. The one-call check is `mwdev_provenance` — see
§Artifact absence claims.

### 9. The tool's vocabulary

```text
Census reproduces exactly: 196 firings, 196 resolved nothing, 0 conversions.
```

What it hides: which tool, against what baseline, and whose vocabulary "firing" is.

Write instead: "`mwdev_census` over the board matches the pre-fix run: `parent_fallback_retry` fired 196 times and
every firing resolved no place. The constraint is inert on this set."

### 10. The bare ID

```text
A5 works: the firing lookup now records query.parentID=9000000119609.
```

What it hides: the entity behind the ID, what A5 is.

Write instead: "A5 works: the firing lookup now records the parent for Five Star Island (WOF 9000000119609). A5 =
<issue link>. Its task list asserts this completion."

### 11. The undefined terms

```text
The soft posterior is assigned at line 1129, before the dominant probe that already exists at 1156 — so the hardening declines but the re-rank still flips.
```

What it hides: what each term is: a country-guess probability, an existing country check, a new constraint, a ranking
change.

Write instead: "The country-guess probability (`soft posterior`) is assigned at line 1129, before the existing country
check (`dominant probe`, line 1156) runs. The new constraint declines the guess, but the ranking has already used it
and still flips. Hoist the check above line 1129 so both constraints read the same value."

### 12. Distance as the score

```text
The 95-row namesake grid must go to 0/95, and the FR rows must still differ... 5,274 km recovered.
```

What it hides: what 0/95 asserts, what the FR rows assert, and distance presented as the score.

Write instead: "The pre-registered namesake grid (95 rows) asserts the resolver picks the asserted place for each row,
so a pass is 0 wrong picks. The FR rows assert the fr-FR overlay cases still differ as pinned. After the change,
`Queen Street, Bristol` resolves to Bristol, England — the asserted place. The old pick was the other Bristol, 5,274 km
away. The distance only sizes the old miss. It is not a score."

### 13. The value judgment

```text
The tightening paid for itself twice.
```

What it hides: a value judgment where the concrete consequence belongs.

Write instead: "Returning `ComponentTag` instead of `string` from `flattenTreeNodes` breaks four comparisons — `n.tag
=== "city" | "state" | "postal_code" | "house_number_prefix"` — in the demo and its smoke mirror. None of those
literals is a `ComponentTag`. They are libpostal labels and could never match."

The rules the entries encode:

1. **A judgment about your own work states the fact instead.** `Warrants its place`, `paid for itself`, and
   `decisive` as praise → what was done and what it changed. The repo's own records contain live examples:
   `The #511 lint paid for itself the first time it ran` means the lint caught 9 contradictions on its
   first run.
2. **A defect described by an adjective is described by its mechanism.** Name the object, the operation,
   and the consequence. "Swallows" is established repo idiom for span-boundary inclusion and is fine when
   the boundary is stated. It is jargon when the mechanism stays implied.
3. **A number states its denominator, threshold, artifact, and arm.** "41/58" must answer what the other
   17 have in common, or say they are not one class. A delta is never unattributed: name the rows that
   moved.
4. **An entity is a name rather than an ID.** WOF IDs, row names, and test names get the address or place name
   beside them.
5. **A technical term in prose is defined in one sentence at first use, or replaced by its mechanism.**
   Code comments may use the identifier. Prose must define it or state the mechanism beside it.
6. **A claim of absence states where it looked.** "Does not exist on this host" → the paths checked and
   the tool that reported them. Presumption of absence is not evidence. A repo with this project's
   history does not accept "no one built it" without receipts. For known artifacts the one call is
   `mwdev_provenance` (§Artifact absence claims).
7. **A report gives the tool's name and attributes the tool's vocabulary.** "Census reproduces" → `mwdev_census`.
   State that "firings" and the tool's "resolved" count are the tool's terms.
8. **Work links its issue, and a task's name states what it does.** "The A5 trace repair" → the issue, and
   the task list asserts completion. If a task needs a short name, the name states the change.
9. **Distance is not a success metric unless the task grades on distance.** A parse and a geocode are
   graded on identifying the right place: conformance, span coherence to gazetteer ancestry, currency,
   provenance. State distance only when the eval uses it, and say why it matters for this task.
10. **A conclusion word appears after its evidence rather than instead of it.** The gauntlet defines one
    such condition, a remaining name with a winning margin, and states its threshold
    (`DECISIVE_MARGIN_LOG10`) in `packages/mailwoman/tools/eval-harness/gauntlet/ablation-expectation.md`.
    A verdict word survives only in a defined sense like that one. As praise, the word is deleted and the
    evidence remains without it.
11. **A decision is specified.** "One judgment call needs your eyes" → the interface being changed, both
    options, and what each costs. "Needs your eyes" is a handoff heading rather than a description: the item
    under it states the decision.
12. **Stock forms are banned.** The full list lives in `.claude/output-styles/mailwoman-development.md`
    § Keep the conversation human. The docs-page subset is enforced by Vale
    (`docs/styles/Mailwoman/StockPhrases.yml`, `BannedWords.yml`); in chat this skill is the
    enforcement.

## Worked example: the soft anchor

Written (shipped on #1814):

> One judgment call needs your eyes
>
> #1814 changes a tested interface. geocode-core-place-country.test.ts pinned #1738's "a disagreeing bearer
> keeps the posterior soft"; the fix withholds it. My argument is that at w = 1 the soft anchor overturns a
> 0.88 prominence lead by 0.04 — a prior that decides is not a prior — and Montréal's outcome is unchanged
> either way. The alternative (keep it at a reduced weight) needs a measured weight and has no population
> to measure on. That's flagged on the PR.

The same report, written against this skill's interface:

> #1814 changes a tested interface. When someone types `Queen Street, Bristol`, the resolver picks between
> the two Bristols by adding two numbers: prominence (how big and well-known the place is) and a country
> guess — a small model that reads the whole input and outputs a probability per country.
>
> The code calls the country guess a _soft anchor_: a gentle nudge real evidence can override. But the
> guess is a probability between 0 and 1, added at full strength, and the gap between the two Bristols is
> only 0.885. The "nudge" is larger than the thing it is nudging. It does not tip close calls. It decides
> them. The word "soft" in its name is not true.
>
> #1738 exists because `1001 Boulevard Saint-Laurent, Montréal` used to answer Montréal-la-Cluse, a
> village in France. When the guesser disagrees with the country the most prominent place of that name is
> in, the rule stops using the guess as a filter but keeps it as a nudge. My change drops the guess
> entirely on disagreement, so the test asserting "the nudge survives" failed — correctly.
>
> "Montréal's outcome is unchanged either way" means: I ran that address, and it still answers Montréal,
> Canada — 45.5079, −73.5593. The address still answers Montréal, Canada, as #1738 requires. Only the internal weighting differs. The
> alternative (keep the guess at a reduced weight) needs a measured weight and has no population to
> measure it on — flagged on the PR.

Every judgment word resolves to a mechanism, every mechanism to a number or a run, and the decision the
operator must make is stated with its evidence and its cost.

## Present the chain

- Lead with the failure and the address, per `.claude/output-styles/mailwoman-development.md` § Always
  put the address in view: input, expected, observed, first diverging stage, smallest useful next test.
- Present the chain when the operator will audit the diagnosis. Compress to a cause statement when the
  intermediate steps add no value.
- Tag each link. A link without a tag is a claim without a basis.
- A chain that ends at `unknown` ends with the probe that would answer the next why. That probe is
  the next action.

## Checklist before publishing a diagnosis

- [ ] The failure is reproduced, and the address is in view.
- [ ] Every link is tagged observation / inference / decision / unknown. Inferences are marked `LIKELY`.
- [ ] Every number has its denominator, threshold, artifact, and arm. Deltas list their rows.
- [ ] Every ID, row name, and WOF id appears beside the entity's name.
- [ ] Every mechanism term is defined at first use or replaced by its mechanism.
- [ ] Distance appears only when the task grades on distance.
- [ ] Absence claims state where they looked and how the next agent can re-check.
- [ ] The work links its issue, and the issue's task list asserts completion.
- [ ] No judgment word stands where a fact belongs, and no stock form survived.

## Artifact absence claims

`mwdev_provenance` answers "does this artifact exist, and at which path?" It reports each artifact's
presence, size, mtime, symlink target, and sealed state, including `wof-hot.db`. For that database it uses
`promotion-eval.ts`'s lookup order: `$MAILWOMAN_WOF_HOT_DB`, then the staged demo database. An
absence claim for a known artifact cites that report. A fresh search is for artifacts the report does
not list, and finding one is a reason to add it there.
