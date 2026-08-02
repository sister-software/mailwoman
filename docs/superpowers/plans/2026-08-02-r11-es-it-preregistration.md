# R11 — Spain and Italy, and the alias rule generalized

Campaign R11, 2026-08-02. Both were "mechanical" after R9/R10 — and both turned out to need the
alias mechanism India motivated, in their own languages rather than English.

## Two things measured before building

**The fold does not strip accents.** `Córdoba` → `córdoba`, `Cordoba` → `cordoba`: different keys.
WOF stores the unaccented form for several Spanish cities, so a bare WOF surface would never match
a real Spanish address.

**WOF's preferred name is often English.** It stores `Rome` — an Italian address says `Roma`, which
WOF carries as the `ita` preferred name. R10's alias rule was scoped to `language = 'eng'`, which
would have missed every Italian and Spanish form.

## The generalization

Alias expansion now selects names whose language is **official for the country** (via codex's
`isOfficialLanguage`, the same table the WOF ingest consults) **plus English** as the lingua franca,
and requires the surface be **Latin-script**.

The script filter is not cosmetic: India has 22 official languages, and WOF carries Devanagari,
Tamil and Bengali forms this model never sees. Without it, generalizing from `eng` would have
bloated the Indian artifact with scripts no input can contain. The check is on the ALIAS rather than
the language tag, because a language can be written in more than one script.

Effect on shipped locales, verified: **US 47,878, GB 30,825, DE 85,603 — all unchanged**. India
moved 175,744 → 176,086 (+342 Latin-script official-language forms).

## Codex modules

`codex/es/codigo-postal.ts` and `codex/it/cap.ts`, both five digits. The docstrings carry the part
worth knowing: a Spanish código postal's first two digits ARE the province (assigned alphabetically,
01 Álava … 28 Madrid), so a Spanish region is derivable from the postcode. An Italian CAP is the
opposite — large cities span ranges (Rome 00118–00199) and provinces share leading digits, so it
narrows geography without identifying a province, the same trap German Leitzonen set.

## Bars

- **B-R11.1 PASS** — gauntlet green; typecheck clean across 40 workspaces; GB/US/DE byte-identical.
- **B-R11.2 PASS** — **0/60** confound false positives for each locale (30 directional-class
  surfaces + 30 others, each opening a Spanish/Italian venue name).
- **B-R11.3 PASS** — ES **46/50 tag-correct (92%)**, IT **49/50 (98%)**, bar ≥70%.
- **D-R11.4** — before/after: `Corso Buenos Aires 8, Barona, 20141 Milano` previously emitted
  `locality=Milano` with **Barona lost entirely**; it now yields `dependent_locality=Barona`.

Final: ES 3,559 pairs, IT 4,026.

## Both packages were scaffolded, not copied

`scripts/scaffold-weights-overlay.ts` (shipped hours earlier, after the template-copy bug cost three
fixes) created both and registered all four automatable points. Neither reproduced the
`repository.directory` defect that hit de-de and en-in.
