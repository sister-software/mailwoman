# R9 — Germany, and the campaign's first carrier package

Campaign R9, 2026-08-02. Every locale after GB/US/FR was blocked on the same thing, and it was
never data: the pair index is hard-gated on the resolved locale's country, so an artifact shipped
inside another locale's package can never fire. Germany is the first locale to get its own
**carrier package**, which is what unblocks the rest.

## Source: WOF, not a postal register

Deutsche Post routes `PLZ Stadt` and carries **no Ortsteil field**, so there is no postal source to
harvest — the same situation as the US, and the opposite of France, where BAN's `nom_ld` IS the
postal line. WOF's German borough/neighbourhood records are the Ortsteile and Stadtteile that
German addresses do carry when they carry anything: **85,605 pairs**, the largest instance in the
campaign after France. Top parents are Köln (170), Wuppertal (159), Solingen (157).

## The R6 prediction, confirmed on first contact

The FR rung predicted DE/ES/IT would each need a `LEADING_POSTCODE_COUNTRIES` entry, since all
three write the postcode before the locality. That is exactly what happened, and the failure was
silent: **the artifact built correctly, probed correctly, and changed nothing.** `Neusser Str. 12,
Nippes, 50733 Köln` produced no dependent locality with the index loaded, because the parent segment
folded to `"50733 köln"` — a key no bare-Gemeinde entry matches.

Adding `de` to `SEGMENT_PARENT_POSTCODE_SHAPES` (codex's `PLZ_PATTERN`, already in the repo) and to
`LEADING_POSTCODE_COUNTRIES` fixed all four probes at once. **A correct artifact that changes
nothing is a mechanism bug** — the R6 lesson, now applied rather than rediscovered.

## Bars

- **B-R9.1 (no regression).** Gauntlet PASS; neural suite 503/503.
- **B-R9.2 (venue-confound floor).** 70-row board: 45 directional-class surfaces (`Nord`, `Süd`,
  `Ober`, `Neu`, `Groß`… from 9,406 available) plus 25 others, each opening a German venue name
  (`Apotheke`, `Bäckerei`, `Autohaus`). **0/70 false positives.**
- **B-R9.3 (positive side).** 60 sampled pairs in German address shape: **60/60 emit, 60/60
  tag-correct.**
- **D-R9.4 (disclosure).** A fusion fix worth naming: without the index, `Venloer Str. 300,
Ehrenfeld, 50823 Köln` fused the locality as `"Ehrenfeld Köln"` — a wrong span, not merely a
  missing one. With it, the two split correctly.

## The carrier package

`@mailwoman/neural-weights-de-de` is data-only: it declares `mailwoman.baseWeights` and shares the
base model and tokenizer with en-us, shipping exactly one artifact. Six committed files
(package.json, model-card.json, README, .gitignore, .npmignore, link-dev-weights) plus the
gitignored binary. Wired into `.release-it.json`, `release.config.json` (locales + softFeed),
publish.yml's fetch/preflight/guard, and the pair-index↔card parity test.

**Operator action required at release: the first publish.** npm Trusted Publishing cannot CREATE a
package, so `@mailwoman/neural-weights-de-de` needs one credentialed publish before CI can take
over — the same gap that bit `sentencepiece-wasm`, `bdc` and `filer` at v8.4.0. Publish it at the
version its dependents pin.

## What this unblocks

ES and IT are now purely mechanical: WOF has 1,327 and 1,183 pairs respectively, both write the
postcode first, and both need a codex postcode module (neither has one today — `codex/` covers au,
ca, de, fr, gb, jp, nz). Ireland still additionally needs its licence survey.
