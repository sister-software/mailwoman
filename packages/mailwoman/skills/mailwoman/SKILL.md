---
name: mailwoman
description: Use when a project has installed mailwoman (or is deciding whether to) and you need to parse, geocode, or validate postal addresses — diagnosing a broken install, wiring the CLI or the library, setting up the gazetteer, or filing a precise bug report.
---

# Mailwoman

Mailwoman parses postal addresses into a tagged tree and, with a gazetteer on disk, geocodes them —
entirely inside the host process. No API key, no network call for a plain parse. The parser and the
gazetteer ship separately: the parser works the moment `npm install` finishes, the gazetteer is a
download you fetch once.

## Run doctor first

Before debugging anything else:

```bash
npx mailwoman doctor
```

It checks seven things: model weights, the Node runtime, the ONNX runtime, the data root, the admin
gazetteer, the POI layer, and any locale overlays (e.g. fr-fr), and prints the one command that
closes each gap. Exit code 0 means the two CORE checks
(weights + runtime) passed — parsing works even with every data layer missing. A red `✗` on a data
layer is a reported gap with a `fix:` line, not a failure; read that line before guessing at a fix.
`--json` emits the same report as `{ checks: [...], exitCode }` for scripting.

## Parse

```bash
npx mailwoman parse "350 5th Ave, New York, NY 10118"
```

or in code:

```js
import { createRuntimePipeline } from "mailwoman"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const parse = createRuntimePipeline({ classifier })
const result = await parse(input)
```

`result.tree.roots` is an array of tagged nodes (`tag`, `value`, `confidence`, `children`) nested by
geographic containment, not a flat record. Build the pipeline once and reuse it across calls —
loading the model is the expensive part, not the parse.

The full `ComponentTag` vocabulary is the type of that name exported from `@mailwoman/core/types`.
Read it before assuming a tag exists or guessing at its name.

**Confidence is the model's own score, not a calibrated probability, by default.** Don't read `0.91`
as "91% likely correct" — on the held-out set this model is measurably under-confident (mean score
0.913 vs 0.980 accuracy). If you route decisions on the number — sending low-confidence spans to
review, say — wire the calibrator shipped in the weights package first (`createCalibrator` from
`@mailwoman/core/decoder`); only then does the score mean what it looks like it means.

## Geocode

Geocoding needs a gazetteer database on disk. Downloading it is the whole setup:

```bash
npx mailwoman data pull candidate
npx mailwoman geocode "350 5th Ave, New York, NY 10118"
```

The file lands at `<data-root>/wof/candidate.db`, and since `8.7.0` every entry point looks there —
`geocode`, `parse --resolve`, `serve`, `registry`, the MCP server and the drop-in servers alike. The
`export MAILWOMAN_CANDIDATE_DB=...` line the pull prints is a leftover from when that was required;
ignore it. Set the variable only for a gazetteer outside the data root, or to the literal `none` to
pin the older FTS admin backend.

`registry run` is the one exception, and it is a boot gate rather than a backend choice: it refuses to
start without `--resolve-db` or `$MAILWOMAN_WOF_DB`, then ignores the path and resolves against the
candidate gazetteer anyway. Pass the gazetteer's own path to get past it.

Do not pin `none` casually. The candidate backend ranks population-first, and on 150 committed
OpenAddresses rows per locale it is ahead on both tier-1 locales: US within-25 km 149/150 → 150/150
with worst case 692 km → 20 km, FR within-25 km 126/150 → 145/150 with p90 144.2 km → 2.4 km.

One trap worth knowing: a `$MAILWOMAN_CANDIDATE_DB` naming a file that is not there does **not** fall
back to the convention path. It resolves to nothing and you land on the FTS backend. Unset it rather
than fixing it.

`npx mailwoman data status` reports what's already on disk; add `--check-remote` to compare against
the live remote size instead of trusting the local file.

## Filing a bug

A wrong parse or a wrong geocode is worth a precise report — a concrete address that broke, not a
description of the class of address that broke:

- The exact input string, copied — not retyped. Whitespace and punctuation are the bug about half
  the time.
- The output of `npx mailwoman doctor` — names versions, the Node build, and which data layers are
  present.
- The output of `npx mailwoman parse --debug "<input>"` — the full pipeline trace (normalized form,
  query shape, locale, kind, per-stage timing, and the resulting tree) in one JSON object.
- Whether you resolved (`--resolve` on `parse`, or `geocode`) or only parsed — a missing coordinate
  on a parse-only call is documented behavior, not a bug.
- The locale, if it isn't `en-US`.

File at https://github.com/sister-software/mailwoman/issues.

## Installing this skill in a new project

```bash
npx mailwoman skill install
```

Copies this directory to `.claude/skills/mailwoman/` in the current project. Pass `--dest <dir>` to
target a different project root. Safe to re-run — it overwrites cleanly.
