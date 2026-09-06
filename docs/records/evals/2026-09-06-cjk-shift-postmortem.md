# Shift postmortem — 2026-09-06 (CJK arc; living document, finalized at hand-off)

The shift that made `@mailwoman/neural-weights-cjk` real: the served path, the resolver behind it, and the
kana-register run that replaced the base. Direct-to-main after local checks (root `yarn health`, the affected
suites, `mwdev_compare` over the Latin board where a resolver mechanism moved), one Modal run (`v8-cjk-kana`,
24,000 steps, pre-registered in its config header before launch). Window: 02:00–13:00 UTC.

## What shipped

- **The served JP path resolves** (ba46cc6d9). A correct JP parse answered no coordinate: the placetype map carried no
  entry for `prefecture` / `municipality` / `district`, the admin ladder named no JP rung, and the normalizer stripped
  the `〒` the character model was trained with. All three measured on 300 board rows (0 → 271 accepted @15 km) and
  shipped; the Latin board did not move (0 of 674 rows, run `8eb39d63`).
- **The compound municipality resolves as a scoped pair** (3dbff6ab5, #2175). `神戸市西区` and `猿島郡五霞町` have no single
  key; the unscoped split lost rows (251 of 300) because a bare ward answers a namesake elsewhere. The head resolves
  first, the tail probes as its child with the parent fallback withheld and a region-scope re-admission refused: 271 →
  282 of 300, 1,823 → 1,889 of 2,000 (94.5%). Latin board 0 of 674 (run `4adaa780`).
- **The result hierarchy admits the JP tiers** (e24bcb710): Miyakonojō and Miyazaki with their WOF ids on a JP result.
- **`postalcode-jp.db` joins the postcode-database recipe** (a214ba990, #2176): 637 of 2,000 rows carry a code the
  walk probed and never found; the located codes sit 0.52 km (p50) from the entrance point. The candidate rebuild that
  carries it is the operator's.
- **The kana-register run is the CJK base** (d363d1955, #2165 closed). Pre-registered board, same scorer both arms:
  0.9924 blended against 0.9653, municipality macro 0.9821 against 0.9757, `かすみがうら市` 0 of 823 failed against 598;
  CN `locality_unit` 11 of 14; ONNX parity 6.4e-6. One trade, `中新川郡上市町` 66 → 121 failed rows (#2178).
- **Release preflight found a real defect** (fa6965011): `@mailwoman/corpus` promised `./test-kit` exports its tsconfig
  never compiled; `manifest-targets` now reads each workspace's `include` / `exclude` and refuses the shape at PR time.
- Records and docs: SCOPE's tier-5 row (JP, CN on the character path, 94.5% @15 km through the resolver), the CJK run
  record (`2026-09-06-v8-cjk-shared-head.md` §3b, §6), the Korean proposal
  (`docs/superpowers/specs/2026-09-06-kr-under-the-cjk-package.md`), AGENTS.md's corpus layout, #2119 closed.

## Measurements and their verdicts

| Read                                                                       | Value                                     |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| JP board through the resolver, 2,000 rows @15 km, before / after the shift | 0 (no JP tag queried) / 1,889 (94.5%)     |
| Same, projected with the JP postcode fold (#2176)                          | 1,925 (96.3%)                             |
| `v8-cjk-kana` vs `v8-cjk-full`, pre-registered board, blended / macro      | 0.9924 / 0.9821 vs 0.9653 / 0.9757        |
| Candidate gazetteer native-script keys: JP / CN / KR                       | 91.3% / 93.5% / 87.3% (Hangul stored NFD) |
| Latin regression board, two resolver mechanisms                            | 0 of 674 rows differed, both runs         |
| Release preflight, repo source                                             | 58 of 59 → 59 of 59 workspaces            |

## What could have gone better

- A precomposed-Hangul glob over NFD-stored keys read 0 of 52,894; the count contradicted a row already seen, and the
  re-measure in Python read 87.3%. The fourth instance of a measuring-tool false negative this quarter.
- The Modal log stream stalled after two heartbeat failures, so the monitor that watched it emitted nothing after
  step 4,000; the volume listing was the signal that worked. Watch the artifact, not the log.
- `zsh` does not word-split an unquoted variable: a loop that passed `"$1 $2 $3"` as one argument ran four silent
  no-ops before the shape was noticed.

## Decisions made autonomously

- The three JP tags join `DEFAULT_PLACETYPE_MAP` and the admin ladders (only the character model emits them).
- `NormalizeOpts.postalMark` keeps `〒` for a `char`-encoded classifier; the default stays `strip`.
- `release.config.json` `charWeights.cjk` points at the kana run; the package is still held out of the release list.

## Open for the operator

1. The release-list move for `packages/neural-weights-cjk` and the `ja-jp` / `zh-cn` overlays (#2164 step 7).
2. The candidate rebuild carrying `postalcode-jp.db` (#2176) — and the WOF county fixes (#2128, #2129) with it.
3. The named slots (`locality`, `region`) on a JP result stay null while `components` and `hierarchy` carry the tiers.
4. Korean: the four decisions in the spec (package, KOGL text, the `subregion` route, when to spend the probe).
5. #2178: whether a 市-inside-name register earns a run.
