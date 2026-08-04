# mailfail — robustness on garbage, malformed and hostile input

**Date:** 2026-08-02 · **Scope:** what the shipped stack does with input that is not an address.
Read-only investigation; no production code changed. 111 probe inputs across seven classes, run on
four paths, with the fixture committed at
`mailwoman/eval-harness/fixtures/mailfail.jsonl` so these cases can become a gate.

---

## Verdict

Three findings need action, and one of them is not a garbage-input problem at all.

The stack is well-behaved on the input classes you would expect to break it. Empty
strings, whitespace, punctuation runs, emoji, ZWJ sequences, box drawing, unpaired surrogates,
embedded NUL, BOM, zalgo, RTL overrides, CJK and Devanagari all pass through without a throw and
mostly without emitting anything. That is a real clean bill of health and it is stated plainly
below rather than buried.

What breaks is length. Two independent quadratics live in the preprocessing stages, and a
sequence-length cap in the ONNX runner desynchronises two arrays that the decoder then indexes in
lockstep. That last one is the finding that matters most, because it fires on a **plausible real
address of 325 characters** — not on garbage — and it is reachable from the shipped geocode path.

And separately: a single common English word, a single letter, or a single digit will resolve to a
real coordinate somewhere in the world, with a resolver score indistinguishable from a correct hit.

---

## What was measured, and on which path

Four paths, because they behave differently and carry different risk:

| Path         | How it was driven                                                                                                                                                                                 | Who is on it                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **stages**   | `normalize` → `computeQueryShape` → `detectLocale` → `classifyKindSync` → `groupPhrasesSync`, timed individually. No model.                                                                       | everything downstream                                       |
| **parse**    | `NeuralAddressClassifier.parse` with the exact opts `parseForGeocode` uses: `postcodeRepair: true`, `normalizeCase: true`, `queryShape`, `enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT`. | `geocode-core.ts` — the drop-in servers and the geocode CLI |
| **pipeline** | `createRuntimePipeline({ classifier })`, no resolver.                                                                                                                                             | `mailwoman parse`                                           |
| **resolve**  | `createRuntimePipeline({ classifier, resolver })` over `admin-global-priority.db` (5.2 GB, FTS backend).                                                                                          | `mailwoman parse --resolve`                                 |

The raw classifier defaults `enforceWordConsistency` to OFF; every measurement here passes
`WORD_CONSISTENCY_SHIP_DEFAULT` so it reflects what a consumer runs.

**Measurement scepticism.** The first resolve run reported zero garbage-to-coordinates, which would
have been a headline "clean" result. It was wrong: the walker looked for `node.resolved.latitude`,
and resolved coordinates land on `node.lat` / `node.lon`. A positive control — a real
address that must resolve — caught it. The control is now the first row of every resolve run, and
the 35 hits below are from the run where it passed. Two of those hits were re-confirmed through
the shipped CLI (`mailwoman parse --resolve`) rather than the eval script.

A second eval-script bug is worth recording because it produced a number that briefly went into this
report. The 1 MB run was watched with a shell loop whose own command line contained the string
`mailfail-e2e`, so `pgrep -f mailfail-e2e` matched **the watcher, not the job** — and
`ps -o etimes` was reporting the watcher's age as if it were the measurement. That is how ">5.5
minutes, still running" got written down for a job that had in fact been killed. The real figure
was recovered from the log file's mtime and the job's own wall-clock cap. Any process-liveness
check whose pattern can match the checker is measuring itself.

---

## Finding 1 — a 325-character real address throws an uncaught TypeError

**Severity: high.** Availability _and_ correctness, on the shipped geocode path, triggered by valid
input.

`OnnxRunner.infer` clamps the model input to a fixed window:

```ts
// neural/onnx-runner.ts:197
const seqLen = Math.min(tokenIds.length, this.fixedSeqLen) // fixedSeqLen defaults to 128
```

`logits` and `emissions` come back with exactly `seqLen` rows. `pieces` — from
`tokenizer.encode` at `neural/classifier.ts:662` — is never truncated to match. The decoder then
walks them together:

```ts
// neural/classifier.ts:959-961
let tokens: DecoderToken[] = pieces.map((p, i) => {
    const idx = labelIndices[i]!
    const probs = softmax(logits[i]!)      // logits[i] is undefined for i >= 128
```

`softmax(undefined)` reads `row[0]` at `neural/viterbi.ts:280` and throws
`TypeError: Cannot read properties of undefined (reading '0')`.

There is a second, earlier throw site on the same desync. `enforceWordConsistency` — default-ON in
production — iterates piece indices but indexes `emissions`:

```ts
// neural/word-consistency.ts:238
const probs = softmax([...emissions[pi]!]) // TypeError: emissions[pi] is not iterable
```

Whichever fires first depends on whether a word straddles the boundary with mixed labels.

**The boundary is exactly 128 pieces.** Measured with a controlled one-piece-per-character input:

```
digits=128 pieces=128 -> ok
digits=129 pieces=129 -> THREW
```

**It fires on plausible addresses.** Address-like text runs about 1.8–2.5 characters per piece, so
128 pieces is roughly 320 characters. Bisecting a realistic form-concatenated delivery address
(c/o line, building, floor, suite, street, borough, city, state, ZIP+4, country, delivery window):

```
last OK length: 320 chars (127 pieces)
first THROW   : 325 chars (131 pieces)
```

That is not exotic. Shipping systems, CRMs and government forms concatenate address lines to well
past 325 characters routinely.

**The 512-character drop-in cap does not protect against this.** `nominatim/cli.ts:67` and
`photon/cli.ts:60` both cap at `MAX_QUERY_LEN = 512`, with a comment explaining the cap exists
because a long query "would exceed the model's input window." The cap is roughly 4× too loose: a
415-character query — comfortably under it — tokenizes to 178 pieces and throws.

**What each caller sees:**

- `parseForGeocode` / `geocodeAddress` (`mailwoman/geocode-core.ts`) do **not** catch. The throw
  propagates. Nominatim `/search`, Photon `/api`, the libpostal drop-in and the geocode CLI all
  reach the parser through here.
- The four Hono servers each install `app.onError` (`nominatim/app.ts:72`, `photon/app.ts:73`,
  `libpostal/app.ts:78`, `api/app.ts:110`), so over the wire this is an HTTP **500 "internal
  error"**, not a process crash. Contained, but a 500 on a valid address is a product defect.
- Library and CLI consumers of `geocodeAddress` get an uncaught `TypeError`.
- `runPipeline` **does** catch, at `core/pipeline/runtime-pipeline.ts:648` (`safeClassify`) — see
  Finding 4, because the catch is not the mercy it looks like.

**Suggested fix.** Truncate `pieces` to the runner's `fixedSeqLen` immediately after
`classifier.ts:662`, so every downstream array is the same length by construction. That kills both
throw sites and stops `query-shape-prior.ts` / `span-proposal-prior.ts` allocating
`pieces.length × labels.length` matrices whose tail rows `addEmissionMatrix` discards anyway. It
also makes the truncation _visible_ — today a 400-character address is silently parsed from its
first ~320 characters with no signal to the caller, which is its own reportable defect. Tightening
`MAX_QUERY_LEN` to ~300 would bound the worst case on two of the four servers but is a
mitigation, not the fix.

---

## Finding 2 — `computeQueryShape` is quadratic in segment count

**Severity: high.** Availability. Reachable from every path, including `parseForGeocode`.

Stage-level timings, no model involved:

| input                    |     chars | segments | `computeQueryShape` |
| ------------------------ | --------: | -------: | ------------------: |
| repeated address, 1 KB   |       990 |       61 |              1.7 ms |
| repeated address, 10 KB  |     9,999 |      607 |             11.0 ms |
| repeated address, 100 KB |   100,023 |    6,063 |      **1,266.8 ms** |
| repeated address, 1 MB   | 1,000,032 |   60,609 |    **110,630.1 ms** |

Ten times the segments, roughly a hundred times the work. `normalize` over the same ladder is
linear (394.8 ms at 1 MB) and the grouper is linear on this shape, so query-shape is 98% of the
1 MB cost.

Isolating the sub-stages at 100 KB puts 1,228.9 ms of the 1,266.8 ms in one function:

```
chars=100023 tok=21217 seg=6063 | tokenize=3.0 classify=1.4 segment=8.0 knownFormats=13.8 regionAbbrev=1228.9 fold=0.1
```

The cause is a plain nested loop over two collections that both grow with input length:

```ts
// query-shape/region-abbreviations.ts:28-40
for (const seg of segments) {
    if (seg.separator !== "comma") continue
    for (const tok of tokens) {
        if (tok.span.start < seg.span.start || tok.span.end > seg.span.end) continue
        ...
```

At 1 MB that is 60,609 × 212,170 ≈ 12.9 billion iterations.

A comma-dense input with no whitespace (`"a,"` repeated) hits the same quadratic through segment
count alone: 3.8 ms → 103.4 ms across a 16× size increase.

**Suggested fix.** Both arrays are position-sorted, so a two-pointer merge makes this O(S + T) with
no behaviour change. Filtering tokens by `REGION_ABBREV_RE` and class _before_ the segment loop is
a cheaper partial mitigation but stays quadratic when the abbreviation repeats.

---

## Finding 3 — the phrase grouper is quadratic on capitalized and street-suffix runs

**Severity: high.** Availability. This is the worst of the three by constant factor.

`phrase-grouper/rules.ts:718-780` runs an outer loop over tokens with an inner unbounded walk to
the end of the capitalized run, and explicitly declines to skip past the run
(`rules.ts:812-814`). The 6-proposal cap at `rules.ts:780` bounds _emission_, not the walk — so the
adjacent comment claiming "O(n) per segment" is wrong. `rules.ts:613-627` has the same shape for
street suffixes.

Grouper time, by input shape and repetition count:

|     n |  chars | `Aa ` repeated | `St ` repeated | repeated address (baseline) |
| ----: | -----: | -------------: | -------------: | --------------------------: |
|   500 |  1,500 |        49.7 ms |        11.4 ms |                      3.4 ms |
| 1,000 |  3,000 |       138.3 ms |        33.8 ms |                      5.1 ms |
| 2,000 |  6,000 |       397.1 ms |        87.3 ms |                     10.0 ms |
| 4,000 | 12,000 |     1,382.8 ms |       387.1 ms |                     20.4 ms |
| 8,000 | 24,000 | **5,328.1 ms** |     1,461.2 ms |                     38.3 ms |

The baseline column is the control: a real repeated address of comparable size costs 38 ms. The
capitalized-run shape costs 5,328 ms — 139× more for the same byte count, because commas break the
run and cap the walk.

End-to-end through `createRuntimePipeline`:

```
repeated-address 100 KB       100023 chars      18.99 s
capitalized-run  100 KB        99999 chars     156.42 s
```

**156 seconds of blocked event loop for 100 KB of `"Aa Aa Aa …"`.** Node is single-threaded; that
is the whole server.

**Suggested fix.** A token-count guard in `groupPhrasesSync` (`phrase-grouper/group.ts:74`, which
today only checks `if (!text.length) return []`) bounds this cheaply. The structural fix is to
advance `i` past the consumed run, or memoize the run-end per start index.

---

## Exposure map

Where the two quadratics and the 128-piece throw can be reached:

| Surface                                     | Length guard                                                                                                                   | Exposed to                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `@mailwoman/api` `/v1/parse`, `/v1/geocode` | 2 MiB body limit (`api/app.ts:23`); **no per-string cap** — `address: z.string()` at `api/schema.ts:38,68` carries no `.max()` | both quadratics, the 128-piece throw                                |
| `@mailwoman/api` `/v1/batch`                | 2 MiB body, 500 rows (`api/routes.ts:49`)                                                                                      | both quadratics × up to 500 rows                                    |
| `@mailwoman/libpostal` `/parse`             | 100 KB body (`libpostal/app.ts:24`); no per-query cap                                                                          | both quadratics (bounded at 100 KB ≈ 19 s), the 128-piece throw     |
| `@mailwoman/nominatim` `/search`            | `MAX_QUERY_LEN = 512` (`nominatim/cli.ts:67`)                                                                                  | 128-piece throw only — quadratics are bounded harmless at 512 chars |
| `@mailwoman/photon` `/api`                  | `MAX_QUERY_LEN = 512` (`photon/cli.ts:60`)                                                                                     | same                                                                |
| CLI / library                               | none                                                                                                                           | all three                                                           |

The single highest-value mitigation is a `.max()` on the API `address` field. It closes the
quadratics on the most exposed surface without touching the parser.

I did **not** stand up a server and issue HTTP requests. The timings above are of the parse the
endpoint performs, measured in-process. The exposure column is read from the code, not observed
over the wire.

---

## Finding 4 — the pipeline masks the classifier crash and substitutes rule-based output

**Severity: medium.** Silent wrongness.

`safeClassify` catches any classifier throw and returns `{ raw: text, roots: [] }`
(`core/pipeline/runtime-pipeline.ts:648`). The later grouper/reconcile stages then repopulate the
tree from rule-based proposals. The caller gets a normal-looking parse with no indication the model
never ran.

Instrumenting the pipeline to record whether the inner classifier threw, 10 of 110 probes crashed
the classifier while the pipeline reported success:

| probe                  | bytes | inner throw                           | pipeline output                                                                               |
| ---------------------- | ----: | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `size-10kb`            | 9,999 | `emissions[pi] is not iterable`       | `{"house_number":"350","street":"5th Ave","locality":"Ave","region":"NY","postcode":"10118"}` |
| `size-1kb`             |   990 | `emissions[pi] is not iterable`       | same                                                                                          |
| `adv-repeat-suite-100` |   900 | `Cannot read properties of undefined` | `{"locality":"Suite","house_number":"1"}`                                                     |
| `num-very-long-digits` |   200 | `emissions[pi] is not iterable`       | `{"house_number":"9"×144}`                                                                    |

The `size-10kb` row is the sharp one: 10 KB of repeated addresses yields a tidy five-field parse
that looks like a correct read of one address. The tree behind it holds 3,031 nodes.

The `num-very-long-digits` row exposes a second, unrelated issue: the emitted `house_number` is
144 characters, truncated from 200 by `MAX_SPAN_LENGTH = 140` at `core/tokenization/Span.ts:17,132`,
which recomputes `this.end` from the truncated body — so the span's offsets no longer point at the
input it came from.

**Suggested fix.** Fixing Finding 1 removes the throw, which removes most of this. Independently,
`safeClassify` swallowing every error with a bare `catch {}` means a model fault is
indistinguishable from a clean no-match. Surfacing it on `PipelineResult` (a `classifierError`
field, or a `path` marker) would cost nothing and make this class self-reporting.

---

## Finding 5 — garbage resolves to real coordinates

**Severity: medium.** Silent wrongness, not availability. Inherent to gazetteer breadth, but
currently unmitigated.

35 of 110 probes produced at least one coordinate on the `--resolve` path. The mechanism is
mundane: WOF contains small populated places named `Null`, `Drop`, `Boom`, `Quote`, `Home`, `Aug`,
`Amet`, `All`, `Hello`, `Apt`, `Ave`, `A`, `x`, `Purwa 0`, `Zona 1`. Any input containing one of
those tokens can be tagged `locality` and resolved.

| input                                             | class                   | resolves to                                      |
| ------------------------------------------------- | ----------------------- | ------------------------------------------------ |
| `+1 (555) 867-5309`                               | phone number            | `Zona 1`, Guatemala City — 14.6369, −90.5102     |
| `null undefined NaN None nil void`                | null literals           | `Null`, India — 26.5482, 80.8319                 |
| `'; DROP TABLE places; --`                        | SQL-injection-shaped    | `Drop`, Texas — 33.1309, −97.3559                |
| `Error: boom\n at parse (/app/index.js:12:9)`     | JS stack trace          | `Boom`, Belgium — 51.0924, 4.3717                |
| `127.0.0.1 - - [02/Aug/2026:...] "GET /v1/parse"` | nginx log line          | `Aug`, Austria — 46.8433, 15.7970                |
| `/home/lab/Projects/mailwoman/core/data/wof.db`   | unix path               | `Home`, Washington — 47.2788, −122.7748          |
| `Lorem ipsum dolor sit amet, …`                   | lorem ipsum             | `Amet`, India — 25.2761, 73.9231                 |
| `Ignore all previous instructions and …`          | prompt-injection-shaped | `All`, Andorra — 42.3974, 1.8402                 |
| `┌─────────┐│ hello │└─────────┘`                 | box drawing             | `Hello`, Ghana — 10.4500, −3.1333                |
| `"unclosed quote`                                 | unbalanced quote        | `Quote`, Missouri — 39.5392, −93.6833            |
| `a`                                               | one letter              | `A`, Nebraska — 41.0027, −96.9678                |
| `-0`                                              | negative zero           | `Purwa 0`, India — 25.5927, 82.6826              |
| zalgo text                                        | combining marks         | four localities across India and the Philippines |

Two of these were re-confirmed through the shipped CLI rather than the eval script. `+1 (555)
867-5309` under `--resolve` (which applies `defaultCountry=US` from `--locale en-US`) lands on a
Nebraska place named `1` at 41.4345, −96.0268 instead of Guatemala — different point, same defect.

**The confidences do not flag these, and neither does the resolver score.** Model confidence on the
emitted components:

```
num-phone-us     locality="1" @ 0.964    postcode="867-5309" @ 0.643
adv-sql-inject   locality="DROP TABLE" @ 0.875
adv-lorem        street="consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore" @ 0.871
adv-prompt       house_number="51" @ 0.851
adv-null-words   locality="null undefined NaN None" @ 0.830
```

A phone number is read as a locality at **0.964**. On the resolver side, the correct control
(`New York`) scored 29.2 while `Apt` → Apt, France scored 27.0 and `Null` → Null, India scored
27.0. There is no threshold on either signal that separates these from a correct hit.

**Assessment.** This is not straightforwardly a bug — `Boom` is a real Belgian municipality and a
geocoder should find it. The defect is that nothing downstream can tell the two cases apart. A
plausible mitigation is a population/importance floor for single-token localities with no
corroborating component (no house number, no postcode, no region), which would drop the whole
table above while leaving `Springfield` — a bare city name a user might type — intact.
That trades recall for precision and should be measured against the fragment boards before anyone
ships it.

---

## What held up

Stated plainly, because these are real results and not padding. Across all four paths, none of the
following threw, hung, or emitted anything:

- **Degenerate input is clean.** Empty string, single/multiple spaces, tab, newline, CRLF, only
  newlines, `.`, `,`, ten commas, `,` interleaved with spaces, `-`, `"`, `\` — every one returns
  `{}` with no throw. Single alphanumerics (`a`, `X`, `7`, `0`) emit one component, which is
  defensible for a single-token query; only `a` resolves.
- **Emoji.** Single emoji, ten building emoji, ZWJ family sequences, skin-tone modifiers,
  regional-indicator flags — all emit nothing. Keycap sequences (`1️⃣2️⃣3️⃣`) emit
  `{"locality":"3","street":"2","house_number":"1"}`, which is the digits inside them being read,
  not an emoji failure.
- **Encoding stress.** Unpaired high and low surrogates, embedded NUL, BOM, zero-width spaces
  inside tokens, RTL override wrapping, NFD-decomposed accents, fullwidth Latin, non-breaking
  spaces, U+2028/U+2029 — no throw anywhere. The BOM and line-separator cases still parse and
  resolve the underlying address correctly.
- **Scripts.** Arabic, Hebrew, Chinese, Japanese, Korean, Devanagari (with Devanagari digits), Thai
  (with Thai digits), and a five-script mixed line all handled. The Hebrew address resolves to
  Tel Aviv correctly.
- **Structured data.** JSON, XML, HTML, YAML, CSV, base64, URLs, Windows paths, email addresses,
  UUIDs, 200-deep bracket nesting — no throw. Several resolve (Finding 5), none crash.
- **Numeric nonsense.** ISO dates, datetimes, latitude/longitude pairs, DMS coordinates, IPv4, UUIDs,
  SSN-shaped digits, scientific notation, credit-card-shaped digits — none resolve. The bare
  latitude/longitude pair `40.748817, -73.985428` correctly yields no coordinate.

One untidy case worth a line: `[31m` (control characters plus an ANSI
colour escape) emits `{"postcode":"31m"}`. Cosmetic, low severity, but the control bytes should
have been stripped in Stage 1.

**A predicted problem that is not real.** The static pass flagged
`neural/span-proposer-lexicon.ts:138` as polynomial-ReDoS-shaped — `\s*#?\s*` before a required
digit, on a default-ON path. Measured against `"PO Box" + " ".repeat(n) + "x"` for n up to 8,000,
the time is flat at 0.1–0.6 ms with no growth. Ruled out; recording it so nobody re-derives it.

---

## What I did not test

- **No HTTP-level testing.** No server was started, no request issued. Timings are of the parse the
  endpoint performs. The exposure map is read from source.
- **No concurrency or sustained-load testing.** Every measurement is a single call on an idle
  process. Event-loop blocking is inferred from wall time on a single-threaded runtime, not
  observed under load.
- **No memory-pressure measurement.** RSS and GC behaviour were not instrumented. The
  `pieces.length × labels.length` allocations noted in Finding 1 are read from source, not measured.
- **No locale coverage beyond en-US.** The classifier is `loadFromWeights({ locale: "en-US" })`
  throughout. The two quadratics are locale-independent (both are in pre-model stages), but the
  crash boundary is a tokenizer property and the piece-per-character ratio will differ for
  non-Latin scripts — 128 pieces will be reached at a _shorter_ character count for CJK.
- **Only the FTS resolver backend.** The candidate-table backend (`$MAILWOMAN_CANDIDATE_DB`) ranks
  population-first and may behave differently on Finding 5.
- **The 1 MB end-to-end pipeline case never completed.** It ran for **~2,220 s (37 minutes)** and
  was killed by a 2,400 s wall-clock cap without producing a result, so the defensible statement is
  ">37 minutes," not a figure. That is 20× the 110.6 s `computeQueryShape` cost, which says the
  stages after query-shape also degrade badly at 60,609 segments — worth its own measurement, but
  not one I have. The 1 MB row in Finding 2 is the stage-level number, which stands on its own.
- **Not a security review.** SQL-injection- and FTS-syntax-shaped strings were probed for _parser_
  behaviour. Neither reached a query engine in a way this investigation examined, and no claim is
  made about injection safety.
- **The `size` class in the committed fixture is truncated.** Rows above ~10 KB are generated, not
  committed — a 1 MB JSONL line is a hostile artifact for a test gate. The generator lives in
  `scripts/diagnostic/mailfail-probes.ts` (gitignored).

---

## The fixture

`mailwoman/eval-harness/fixtures/mailfail.jsonl` — 105 rows, one per probe:

```json
{"raw": "<input>", "class": "<category>", "expect": "no-throw" | "no-component" | "no-resolve", "note": "<what it is>"}
```

Classes: `degenerate` 18, `numeric` 16, `symbolic` 14, `script` 21, `size` 3, `structured` 15,
`adversarial` 18. Bars: 35 `no-throw`, 35 `no-component`, 35 `no-resolve`.

`expect` records the bar the row _should_ meet, not today's behaviour — 19 rows currently violate
it, and those are exactly Findings 4 and 5. Control characters, NUL and lone surrogates are
JSON-escaped; the file was verified to round-trip line-by-line through `JSON.parse` with every
`raw` byte-identical to its source.

---

## Ranked actions

1. **Truncate `pieces` to `fixedSeqLen`** (`neural/classifier.ts:662`). One line; removes both
   throw sites and the 500s on valid 325+ character addresses. Consider surfacing the truncation
   rather than performing it silently.
2. **Add `.max()` to the API `address` field** (`api/schema.ts:38,68`). Closes both quadratics on
   the most exposed surface without touching the parser.
3. **Two-pointer merge in `detectRegionAbbreviations`** (`query-shape/region-abbreviations.ts:28`).
   O(S + T), no behaviour change.
4. **Token-count guard in `groupPhrasesSync`** (`phrase-grouper/group.ts:74`), and correct the
   `rules.ts:778-779` complexity comment.
5. **Surface classifier faults on `PipelineResult`** instead of `safeClassify`'s bare `catch {}`.
6. **Investigate a population floor for uncorroborated single-token localities** — measured against
   the fragment boards first, since it trades recall for precision.
7. **Tighten `MAX_QUERY_LEN` from 512 to ~300** on the nominatim and photon drop-ins. Mitigation
   only; item 1 is the fix.
