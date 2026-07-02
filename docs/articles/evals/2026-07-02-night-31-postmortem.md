# 2026-07-02 → 03 — night 31 postmortem

Shift 05:56 → 16:00 UTC · $30 Modal ceiling · plan `nightshift/2026-07-02-NIGHT-SHIFT-PLAN.md`
(operator locks recorded at top of that file). Two agents-in-worktrees + local eval work +
two Modal training runs, both killed by their own pre-registered gates.

## What shipped

**Merged to main (6):**

- **#911** — #900 splice safety gate: codepoint-overlap assertion + per-locale report artifact in
  `tokenizer_splice.py`, gate rule in CONTRIBUTING (4/4 tests, incl. report-written-before-raise).
- **#913** — #905 bare-namesake acceptance rows into the gauntlet as `improvement_target` under
  **#912** (the cascade findings, below).
- **#915** — **Tier-3 panel sweep complete**: ES 98.7%/1.99 km, NL 95.7%/1.83, CH 91.9%/0.70,
  HR 99.6%/0.76, DK 91.1%/0.77, FI 98.7%/1.46 (n=1000 each; DK/FI via a new spatial CITY-fill);
  SCOPE tiers rewritten to the measured table. Fourteen locales now tier-2-paneled; unmeasurable
  remainder is IE/GB/HU (no OA source exists).
- **#917** — **production hotfix**: the v5.0.0 acronym sweep had renamed Docusaurus's external
  `siteConfig.baseUrl` key → the LIVE demo served `undefined…` sqljs/SW/prefetch paths since
  July 1. Found by an agent's typecheck, verified against the live page, deployed, and the live
  page RE-VERIFIED repaired (`undefinedmailwoman` count 0). Also fixed `PipelineExplorer`'s dead
  pre-#861 `runCascade` call.
- **#919** — SCOPE truth fix: the NO-tail caps hypothesis I wrote earlier the same night was
  read-falsified (0/208 offenders caps) and corrected to the namesake/coverage family.
- Plus the night's harness additions on the campaign branch (`--postcode-consistency` pin,
  multi-shard `--wof-db`, `si-bare-village` recipe + exporter, v1.9.8/v1.9.9 configs, sync fns).

**Flagged for operator review (not merged):** **#914** (ES/IT/NL order shards + goldens +
format-diversity findings — agent), **#916** (the missing multi-service recipe + recipes nav —
voice pass), **#918** (#473: TW postcode table + JP Overture gold — agent).

**Model artifacts:** none promoted, by design and by verdict — see below.

## The model campaign: two runs, two falsifications, one fork

- **Run 1 (v1.9.8** — fr-bare-street alone on the shipped spliced base, case-aug excluded on the
  v1.9.6 shelving record): probe PASS (FR bare 90→93%, US 12-row spot byte-identical). Full 12k +
  sweet-spot scan: FR plateaus 93% through 10k; **full gate at 10k: US/CZ/PL/SK ni PASS, SI ni
  FAIL** (−3.4pp resolve; 37 rows, all the Slovenian no-street "Village N, Postcode Village" form —
  "Apače 108" → street "Apače 10" + house "8"); intrinsic by 6k. The 12k corpus-val jump (macro
  .725→.739) was disregarded as a gate input — label-F1 on the training distribution.
- **Run 2 (v1.9.9** — + `synth-si-bare-village`, 6,285 real OA SI tuples, counter-polarity):
  probe FAILED as registered (SI lost-rows 0→19/37, bar 30; mechanism works, under-converged).
  ONE bounded extension to 6k, bars unchanged, kill explicit: **SI regressed 19→13/37 — kill
  fired.** Two compositions, one knob, no resolution → treadmill-guard shape → **fork posted to
  #901** (weight grid / drop the shard / unified bare-name-comma family across FR+SI+CZ / fold
  into a day campaign with #914). Recommendation: the unified family — the mechanism is identical
  in all three, only the leading name's referent differs.
- US stayed byte-identical through every checkpoint of both runs. Notable historical correction:
  v1.9.4 (the demo-only v4.16 model) was never SI-measured — its damage was invisible until the
  SI sets existed (two days old).

## The taxonomy arc (the night's biggest strategic finding)

1. **Cross-locale offender taxonomy** over all 14 panels (posted to #375): the non-US tail is
   **namesake collision, not coverage** — FI 300/1k, DK 167, CZ/SK 131, HR 94, SI 91, PL 75
   namesake rows vs single-digit unique-misses. US: 13/2000 (its region tokens + adminCoherence
   already do this job; EU formats carry no region token).
2. The shaped lever **already exists**: `postcodeConsistency` (#370 lever A, default-off).
3. Pre-registered experiment (FI/CZ, flag ON): **NULL — byte-identical.** Mechanism: the pass
   needs a RESOLVED postcode node, and `postalcode-intl.db` covers **NL/DE/FR/ES/IT only** — zero
   rows for every namesake-heavy locale. → **#920** filed.
4. **#920's experiment leg executed the same night** (scope re-derived once the clock was read
   right; EXPERIMENT-labeled shard from GeoNames postal FI+CZ, control leg added to the
   registration before measuring). Verdict: **the lever hypothesis is falsified — and the control
   is the discovery.** `postcodeConsistency` is inert (ctrl≡pcc byte-identical); **postcode-shard
   COVERAGE alone collapses the tail: FI namesake 300→1 (unresolved 13→0), CZ 131→4 (12→2), ni
   PASS everywhere** — a resolvable postcode feeds the existing coordinate-first candidate
   injection; the binding machinery existed all along. Format normalization is load-bearing
   (spaced GeoNames CZ codes made things WORSE, +13, before strip-whitespace at build).
   **Extension (same night): all eight tail locales measured** — SK −98%, DK −77%, SI −71%,
   HR −52%, NO −47%, PL null. Three production-spec findings: (1) crude postcode centroids tax
   p50 on already-correct rows (SK/SI/HR ni-failed the 1 km leg — build needs per-postcode fine
   centroids); (2) PL's null = names must be stored in the SANITIZED-QUERY token shape (the
   hyphen-strip law — third format law of the night); (3) resolve rates held or rose everywhere.
   **Production #920 is fully spec'd from measurement: the biggest lever on the board, zero GPU.**

## What went well

- **Gates killed two plausible-looking runs** and each kill produced a mechanism, not a shrug.
  Total GPU for both falsifications ≈ $4.
- **Verify-before-verdict fired four times on MY OWN claims:** the probe grade that was secretly
  the baseline (missing ONNX download), the caps-tail hypothesis (read-falsified same night, #919),
  the case-aug coverage claim (#829 correction — `normalizeCase` is caps-only), and the
  postcodeConsistency null (traced to data, not plumbing).
- **Agents compounding:** four dispatched, four delivered (OA fetch ×5 countries incl. a
  city-less-trap dodge; #914 with real format-audit findings; #473 at gate with two WOF-TW data
  findings; #916 which verify-before-verdicted its own issue and then caught the live demo bug).
- Salvage-first: the night's biggest lever candidate was an existing flag; the SI shard rode the
  existing recipe scaffold; DK/FI panels rode the existing R-tree.

## What could've gone better

- **Run-1's probe gate lacked the failure slice that later killed it.** The SI leg existed as
  data (the sets were built nights ago) but wasn't in the probe registration. Fixed for run 2;
  rule of thumb: a probe gate should include every locale the full gate will grade, at reduced n.
- A `pkill -f <script>` matched its own background shell's argv and killed it (exit 144, ~20 min
  lost). Pattern-pkill against argv you also occupy.
- My first export fetch graded the SHIPPED baseline as the probe (silent volume-get failure +
  fail-open linker path). The md5/guard discipline caught it, but the linker's missing-source path
  should probably hard-fail rather than warn when `MAILWOMAN_DEV_*` is set.
- Docs typecheck was 7-errors-red on main and nobody knew (the #917 bug lived there). Candidate:
  wire `docs` typecheck into CI.
- Clock discipline: I mis-read local-vs-UTC twice early in the shift (harmless, but the ledger
  timestamps wobbled until corrected).

## Decisions made autonomously

- Case-aug excluded from run 1 (v1.9.6 shelving conditions re-derived, still binding) — later
  partially corrected on #829: the deterministic cover is caps-only; the shelving stands on its
  own regressions regardless.
- init_from (not resume) for the campaign — the surgery export carries no optimizer state;
  v1.9.7 idiom.
- Run-2's bounded 6k extension after a probe FAIL (bars unchanged, kill explicit) — spent $0.5 to
  distinguish under-convergence from non-convergence; the kill then fired honestly.
- #917 split-and-merged as production REPAIR under tonight's merge mode (distinct from the
  demo-default wall; live breakage verified before and after).
- #920 scoped as a filed follow-up rather than a rushed night build (canonical-adjacent data
  artifact + blind heat monitoring at hour 4 = wrong conditions).

## Open questions for the operator

1. **The #901 fork** — recommendation: option 3 (unified bare-name-comma shard family), weighed
   against the taxonomy finding that the resolver-side #920 lever likely dominates it on impact.
2. **#920 as next-night primary?** The full arc is pre-registered and CPU-only.
3. Review queue, in merge order: **#918** (TW/JP data + convention row), **#914** (run-2 shards),
   **#916** (voice pass on one recipe).
4. **#912 direction** (placer abstention on bare single-locality inputs + exact-tier placetype
   prominence + CLI locale-defaultCountry) — needs a gate design.
5. Morning chores: Modal `output-v05x/v06x` dirs deletion proposal; `coretemp` modprobe (sudo);
   docs-typecheck-in-CI.

## Concrete next steps

- #920: GeoNames-postal shard extension → re-run the FI/CZ pre-registration → default-flip eval.
- #901 fork decision → run 3 design (if option 3: one recipe over FR/SI/CZ with balanced polarity,
  probe gate includes ALL graded locales at reduced n).
- #294 is unblocked by #918's TW table (after review/merge).
- v198/v199 volume outputs kept for the fork review; propose cleanup WITH the v05x dirs after.

## Numbers

| item                        | value                                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| Shift                       | 05:56 → 14:29 UTC (operator returned early; wrapped on request)       |
| Modal spend                 | ≈ $4–5 of $30 (2 training runs, 2 probes, ~8 exports/quants, syncs)   |
| Training                    | v1.9.8 (2k+10k, falsified at full gate), v1.9.9 (2k+4k, killed at 6k) |
| NaN incidents               | 0                                                                     |
| GPU lost to error           | 0                                                                     |
| PRs merged                  | 6 (#911 #913 #915 #917 #919 + format sweep)                           |
| PRs flagged for review      | 3 (#914 #916 #918)                                                    |
| Issues filed                | #912, #920                                                            |
| Issue records posted        | #901 fork, #897 diagnostic, #375 taxonomy, #829 correction, #473 gate |
| Panels added                | 9 locales (ES NL CH NO HR DK FI + BE SE) — Tier-3 sweep closed        |
| Production incidents        | 1 found (live since Jul 1), fixed, deployed, re-verified              |
| Verification (end of shift) | gauntlet PASS · metamorphic PASS (6 tracked) · 1,441 tests green      |
