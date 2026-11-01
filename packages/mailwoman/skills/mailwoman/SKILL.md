---
name: mailwoman
description: Use when a project has installed mailwoman (or is deciding whether to) and you need to parse, geocode, or validate postal addresses — diagnosing a broken install, wiring the CLI or the library, setting up the gazetteer, or filing a precise bug report.
---

# Mailwoman

Mailwoman parses postal addresses into a tagged tree and, with a gazetteer on disk, geocodes them —
entirely inside the host process. A plain parse needs no API key and makes no network call. The parser and the
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
layer is a reported gap with a `fix:` line rather than a failure. Read that line before guessing at a fix.
`--json` emits the same report as `{ checks: [...], exitCode }` for scripting.

## Parse

```bash
npx mailwoman parse "350 5th Ave, New York, NY 10118"
```

or in code:

```js
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createRuntimePipeline } from "mailwoman"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const parse = createRuntimePipeline({ classifier })
const result = await parse(input)
```

`result.tree.roots` is an array of tagged nodes (`tag`, `value`, `confidence`, `children`) nested by
geographic containment rather than a flat record. Build the pipeline once and reuse it across calls —
loading the model is the expensive part rather than the parse.

The full `ComponentTag` vocabulary is the type of that name exported from `@mailwoman/codex/component`.
Read it before assuming a tag exists or guessing at its name.

**Confidence is the model's own score rather than a calibrated probability, by default.** Don't read `0.91`
as "91% likely correct" — on the held-out set this model is measurably under-confident (mean score
0.913 vs 0.980 accuracy). If you route decisions on the number — sending low-confidence spans to
review, say — wire the calibrator shipped in the weights package first (`createCalibrator` from
`@mailwoman/core/decoder`); only then does the score mean what it looks like it means.

## Geocode

The geocoder needs a gazetteer database on disk. One download is the whole setup:

```bash
npx mailwoman data pull candidate
npx mailwoman geocode "350 5th Ave, New York, NY 10118"
```

The file lands at `<data-root>/db/wof/candidate.db`, and since `8.7.0` every entry point looks there —
`geocode`, `parse --resolve`, `serve`, `registry`, the MCP server and the drop-in servers alike. The
`export MAILWOMAN_CANDIDATE_DB=...` line older releases print is a leftover from when that was required.
Ignore it. From the release after 10.7.0, the pull installs the gazetteer under
`<data-root>/db/candidate/<sha256>/`, selects it in `<data-root>/active.json`, prints no `export`
line, and every entry point reads the selected file before the conventional path. Set the variable only for a gazetteer outside the data root, or to the literal `none` to
pin the older FTS admin backend.

`registry run` is the one exception, and it is a boot check rather than a backend choice: it refuses to
start without `--resolve-db` or `$MAILWOMAN_WOF_DB`, then ignores the path and resolves against the
candidate gazetteer anyway. Pass the gazetteer's own path to get past it.

Do not pin `none` casually. The candidate backend ranks population-first, and on 150 committed
OpenAddresses rows per locale it is ahead on both tier-1 locales: US within-25 km 149/150 → 150/150
with worst case 692 km → 20 km, FR within-25 km 126/150 → 145/150 with p90 144.2 km → 2.4 km.

A `$MAILWOMAN_CANDIDATE_DB` that points at a missing file does **not** fall
back to the convention path. The variable resolves to no database, and you land on the FTS backend. Unset it rather
than fixing it.

`npx mailwoman data status` reports what's already on disk. Add `--check-remote` to compare against
the live remote size instead of trusting the local file.

## File a bug

Report a wrong parse or a wrong geocode precisely. Give a concrete address that broke rather than a
description of the class of address that broke:

- The exact input string, copied — not retyped. Whitespace and punctuation are the bug about half
  the time.
- The output of `npx mailwoman doctor` — names versions, the Node build, and which data layers are
  present.
- The output of `npx mailwoman parse --debug "<input>"` — the full pipeline trace (normalized form,
  query shape, locale, kind, per-stage timing, and the resulting tree) in one JSON object.
- Whether you resolved (`--resolve` on `parse`, or `geocode`) or only parsed — a missing coordinate
  on a parse-only call is documented behavior rather than a bug.
- The locale, if it isn't `en-US`.

File at https://github.com/sister-software/mailwoman/issues.

## Install this skill in a new project

```bash
npx mailwoman skill install
```

Copies this directory to `.claude/skills/mailwoman/` in the current project. Pass `--dest <dir>` to
target a different project root. The command is safe to re-run, because it overwrites the existing copy.
