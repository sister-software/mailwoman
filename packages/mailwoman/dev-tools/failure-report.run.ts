/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Failure report (#1104-adjacent): run N models over the schema-correct parity corpus, collect the
 *   per-floor-label DISAGREEMENTS with structural metadata, and emit a cross-model HTML report — which
 *   addresses remain beyond reach, which are model-specific regressions/fixes, and what those failures
 *   CORRELATE with (country, delimiter class, script, source). The tool that would have caught the v261
 *   country regression as "a shared class across the fragment lineage" at a glance.
 *
 *   Emits a Docusaurus MDX report into the evals tree so it folds into the docs build and accumulates a
 *   model-comparison history alongside the other eval reports. MDX-safe (every dynamic cell is
 *   backtick-wrapped + pipe/backtick-escaped, so an address can't break the table or trip the angle-lint).
 *
 *   Usage (label=cacheRoot pairs; label=shipped uses the installed default):
 *     node packages/mailwoman/dev-tools/failure-report.run.ts \
 *       [--corpus golden:<dir>[:N]] [--out docs/articles/evals/competitive-parity/<file>.mdx] [--date YYYY-MM-DD] \
 *       shipped=shipped v257=$MAILWOMAN_TEMP_ROOT/v257-cache v261=$MAILWOMAN_TEMP_ROOT/v261-cache
 *   Writes the MDX (default docs/articles/evals/competitive-parity/failure-report.mdx) plus
 *   `$MAILWOMAN_TEMP_ROOT/failure-report.json`.
 */

import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { readDirectory } from "@mailwoman/core/fs/readers"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { tempRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"
import { basename, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { PARITY_FIXTURES_PATH, PARITY_FLOORS, type ParityFixture } from "#eval-harness/parity-corpus"

/**
 * Token count at or below which a query is bucketed as short.
 */
const SHORT_QUERY_TOKENS = 3

/**
 * Gap from the leading count at which a row is emphasised in the report.
 */
const NOTABLE_COUNT_GAP = 3

/**
 * Common fixture shape both corpora reduce to.
 */
interface Fixture {
	id: string
	input: string
	country: string
	source: string
	expect: Record<string, string[]>
}

/**
 * Load the corpus. Default = the schema-correct parity corpus (street-family aware, campaign gate).
 * `golden:<dir>[:<sampleN>]` = the golden dev set (broad label coverage INCLUDING country/region, which parity is
 * sparse on) — note its `street` gold is FLAT-schema (pre-split), so street reads confounded there;
 * country/region/locality/postcode/house_number are single-tag and valid.
 */
async function loadCorpus(
	spec: string | undefined
): Promise<{ fixtures: Fixture[]; kind: "parity" | "golden"; name: string }> {
	if (spec?.startsWith("golden:")) {
		const [, dir, sampleArg] = spec.split(":")
		const sampleN = sampleArg ? Number(sampleArg) : Infinity
		const files = (await readDirectory(resolvePath(dir!))).filter((f) => f.endsWith(".jsonl"))
		const fixtures: Fixture[] = []

		for (const file of files) {
			const src = basename(file, ".jsonl")
			let i = -1

			for await (const row of JSONSpliterator.fromAsync<{ raw: string; components: Record<string, string> }>(
				resolvePath(dir!, file)
			)) {
				i++

				if (i >= sampleN) break

				if (!row.raw || !row.components) continue

				fixtures.push({
					id: `golden-${src}-${i}`,
					input: row.raw,
					country: (row.components.country || src.toUpperCase()).slice(0, 2).toUpperCase(),
					source: src,
					expect: Object.fromEntries(Object.entries(row.components).map(([k, v]) => [k, [v]])),
				})
			}
		}

		return { fixtures, kind: "golden", name: `golden:${basename(dir!)}` }
	}

	const fixtures = (await Array.fromAsync(JSONSpliterator.fromAsync<ParityFixture>(PARITY_FIXTURES_PATH)))
		.filter((f) => !f.dropped && f.expect)
		.map((f) => ({ id: f.id, input: f.input, country: f.country, source: f.source, expect: f.expect! }))

	return { fixtures, kind: "parity", name: PARITY_FIXTURES_PATH.split("/").pop()! }
}

interface StructuralFlags {
	whitespaceOnly: boolean // no separator punctuation — only whitespace between tokens
	hasComma: boolean
	hasNonAscii: boolean
	tokenCount: number
	hasCountryGold: boolean
}

function classify(fixture: Fixture): StructuralFlags {
	const input = fixture.input

	return {
		whitespaceOnly: !/[,."'/\\|;:]/.test(input),
		hasComma: input.includes(","),
		hasNonAscii: /\P{ASCII}/u.test(input),
		tokenCount: input.trim().split(/\s+/).length,
		hasCountryGold: !!fixture.expect.country?.length,
	}
}

interface FixtureFailures {
	id: string
	input: string
	country: string
	source: string
	flags: StructuralFlags
	// modelLabel -> the floor labels that DISAGREED, with expected/got.
	failsByModel: Record<string, { label: string; expected: string; got: string }[]>
}

const { values: flags, positionals } = parseArguments({
	options: {
		corpus: { type: "string", short: "c", description: "corpus=parity (default) or corpus=golden:<dir>[:<sampleN>]" },
		out: { type: "string", short: "o", description: "output MDX path" },
		date: { type: "string", short: "d", description: "date stamp for the report" },
	},
	allowPositionals: true,
})

const specs = positionals.map((a) => {
	const [label, root] = a.split("=")

	if (!label || !root) throw new Error(`bad spec ${a}; use label=cacheRoot (or label=shipped)`)

	return { label, root }
})

if (!specs.length)
	throw new Error(
		"usage: failure-report.run.ts [corpus=golden:<dir>] label=cacheRoot [label2=...] (label=shipped for default)"
	)

const { fixtures, kind: corpusKind, name: corpusName } = await loadCorpus(flags.corpus)

async function parseTags(cls: NeuralAddressClassifier, raw: string): Promise<Map<string, string[]>> {
	return groupTuplesByTag(await cls.parse(raw, { postcodeRepair: true }))
}

const records = new Map<string, FixtureFailures>()

for (const f of fixtures) {
	records.set(f.id, {
		id: f.id,
		input: f.input,
		country: f.country,
		source: f.source,
		flags: classify(f),
		failsByModel: {},
	})
}

for (const { label, root } of specs) {
	const cls =
		root === "shipped"
			? await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
			: await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: root })

	process.stderr.write(`grading ${label}…\n`)

	const floorTags = new Map<string, readonly string[]>(PARITY_FLOORS.map((f) => [f.label, f.tags as readonly string[]]))

	for (const f of fixtures) {
		const byTag = await parseTags(cls, f.input)
		const fails: { label: string; expected: string; got: string }[] = []

		// Grade EVERY gold label (not just the floors) so country/region/locality/venue failures — the
		// classes a candidate silently trades — are captured. Floor labels compare their tag FAMILY
		// (street = prefix/street/suffix/particle); all others compare by direct tag name.
		for (const [goldLabel, gold] of Object.entries(f.expect)) {
			if (!gold?.length) continue
			const tags = floorTags.get(goldLabel) ?? [goldLabel]
			const got = tags.flatMap((t) => byTag.get(t) ?? []).join(" ")

			if (foldCaseWhitespace(got) !== foldCaseWhitespace(gold.join(" "))) {
				fails.push({ label: goldLabel, expected: gold.join(" "), got })
			}
		}

		if (fails.length) {
			records.get(f.id)!.failsByModel[label] = fails
		}
	}
}

const all = [...records.values()]
const labels = specs.map((s) => s.label)
const anyFail = all.filter((r) => Object.keys(r.failsByModel).length > 0)
// "Beyond reach": failed on EVERY graded model.
const beyondReach = anyFail.filter((r) => labels.every((l) => r.failsByModel[l]))

// Per-LABEL failure count per model — the view where a silently-traded class (e.g. country on the
// fragment lineage) jumps out: a label whose failure count RISES across candidates.
const allLabels = [
	...new Set(
		all.flatMap((r) =>
			Object.values(r.failsByModel)
				.flat()
				.map((x) => x.label)
		)
	),
].toSorted()

function labelFailCount(label: string, model: string): number {
	return all.filter((r) => r.failsByModel[model]?.some((x) => x.label === label)).length
}

// Correlation: failure rate per attribute bucket, per model.
function rate(pred: (r: FixtureFailures) => boolean, model: string): [number, number] {
	const pool = all.filter(pred)
	const failed = pool.filter((r) => r.failsByModel[model]).length

	return [failed, pool.length]
}

const buckets: { name: string; pred: (r: FixtureFailures) => boolean }[] = [
	{ name: "whitespace-only", pred: (r) => r.flags.whitespaceOnly },
	{ name: "has comma", pred: (r) => r.flags.hasComma },
	{ name: "non-ASCII", pred: (r) => r.flags.hasNonAscii },
	{ name: "has country gold", pred: (r) => r.flags.hasCountryGold },
	{ name: "≤3 tokens", pred: (r) => r.flags.tokenCount <= SHORT_QUERY_TOKENS },
	{ name: "US", pred: (r) => r.country === "US" },
	{ name: "FR", pred: (r) => r.country === "FR" },
	{ name: "ZZ (synthetic)", pred: (r) => r.country === "ZZ" },
]

const summary = {
	corpus: corpusName,
	corpusKind,
	models: labels,
	liveFixtures: fixtures.length,
	perModelFailCount: Object.fromEntries(labels.map((l) => [l, all.filter((r) => r.failsByModel[l]).length])),
	beyondReachCount: beyondReach.length,
}

// --- MDX report (folds into the Docusaurus evals tree; #1104-adjacent) -------
// MDX-safe: every dynamic cell is backtick-wrapped (angle brackets / braces stay literal in a code
// span) with pipes + backticks escaped, so an address like "U12/345 <x>" can't break the table or trip
// the MDX angle-lint. Trades are marked in markdown (**N (+Δ)**), not color.

const outPath = flags.out || "docs/articles/evals/competitive-parity/failure-report.mdx"
const stamp = flags.date || new Date().toISOString().slice(0, 10)

const cell = (s: string): string => "`" + (s || "∅").replaceAll("`", "ˋ").replaceAll("|", "\\|") + "`"
// NOT `formatPercent`: this rounds `(n / d) * 100` where core computes `(100 * n) / d`, and the two can differ in the
// last bit at a .5 rounding boundary — the report's zero-decimal cells stay byte-stable under their own arithmetic.
const pct2 = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(0)}%` : "—")
const mdRow = (cells: (string | number)[]): string => `| ${cells.join(" | ")} |`

function failMark(r: FixtureFailures, model: string): string {
	const fails = r.failsByModel[model]

	if (!fails) return "✓"

	// " · " (not <br />) keeps the cell pure markdown — no JSX in a GFM table cell, no angle-lint risk.
	return fails.map((f) => `${f.label}→${cell(f.got)}`).join(" · ")
}

const perModel = [
	mdRow(["model", "fixtures with ≥1 label failure", "rate"]),
	mdRow(["---", "---:", "---:"]),
	...labels.map((l) =>
		mdRow([`\`${l}\``, summary.perModelFailCount[l]!, pct2(summary.perModelFailCount[l]!, fixtures.length)])
	),
].join("\n")

const labelTable = [
	mdRow(["label", ...labels]),
	mdRow(["---", ...labels.map(() => "---:")]),
	...allLabels
		.map((lab) => {
			const counts = labels.map((m) => labelFailCount(lab, m))

			return {
				max: Math.max(...counts),
				row: mdRow([
					`\`${lab}\``,
					...counts.map((c, i) =>
						i > 0 && c - counts[0]! >= NOTABLE_COUNT_GAP ? `**${c} (+${c - counts[0]!})**` : `${c}`
					),
				]),
			}
		})
		.toSorted((a, b) => b.max - a.max)
		.map((x) => x.row),
].join("\n")

const corrTable = [
	mdRow(["structural class", ...labels]),
	mdRow(["---", ...labels.map(() => "---:")]),
	...buckets.map((b) =>
		mdRow([
			b.name,
			...labels.map((l) => {
				const [f, d] = rate(b.pred, l)

				return `${f}/${d} (${pct2(f, d)})`
			}),
		])
	),
].join("\n")

// Beyond-reach: per-country correlation summary (the shape the operator asked for) + a capped sample.
const byCountry = new Map<string, number>()

for (const r of beyondReach) {
	byCountry.set(r.country, (byCountry.get(r.country) ?? 0) + 1)
}

const countryTable = [
	mdRow(["country", "beyond-reach fixtures"]),
	mdRow(["---", "---:"]),
	...[...byCountry.entries()].toSorted((a, b) => b[1] - a[1]).map(([c, n]) => mdRow([`\`${c}\``, n])),
].join("\n")

const SAMPLE = 40

const beyondSample = [
	mdRow(["country", "input", "source"]),
	mdRow(["---", "---", "---"]),
	...beyondReach
		.slice()
		.toSorted((a, b) => a.country.localeCompare(b.country) || a.source.localeCompare(b.source))
		.slice(0, SAMPLE)
		.map((r) => mdRow([`\`${r.country}\``, cell(r.input), `\`${r.source}\``])),
].join("\n")

// Model-specific: failed on SOME but not all graded models — a fix or regression between candidates.
const diffs = anyFail.filter((r) => !beyondReach.includes(r))

const diffTable = [
	mdRow(["country", "input", ...labels]),
	mdRow(["---", "---", ...labels.map(() => "---")]),
	...diffs
		.slice()
		.toSorted((a, b) => a.country.localeCompare(b.country))
		.map((r) => mdRow([`\`${r.country}\``, cell(r.input), ...labels.map((l) => failMark(r, l))])),
].join("\n")

const goldenNote =
	corpusKind === "golden"
		? "\n> **Note:** golden gold uses the flat pre-split `street` schema, so the `street` row reads confounded here (the model splits prefix/street/suffix). `country` / `region` / `locality` / `postcode` / `house_number` are single-tag and valid — that is where a class trade shows.\n"
		: ""

const mdx = `---
title: "Failure report — ${labels.join(" · ")}"
description: "Cross-model parser failure comparison over ${corpusName} — which address classes each candidate trades, and what stays beyond reach."
date: ${stamp}
tags: [eval, failure-report]
---

# Parser failure report

**Corpus** \`${corpusName}\` · **${fixtures.length}** fixtures · **models** ${labels.map((l) => `\`${l}\``).join(", ")}. Every gold label is graded (floor labels compare the street/prefix/suffix family); a fixture "fails" a label when the parse disagrees with the hand gold.
${goldenNote}
## Per-model failure count

${perModel}

## Failures by label — the class each candidate trades

A count that **rises** across candidates (bold, with the delta vs the first model) is a class the candidate silently traded. This is the row that flags a regression the floor gates miss — e.g. \`country\` degrading across the fragment lineage.

${labelTable}

## Correlation — failure rate by structural class

Read across a row: a class that fails **more** on one model is the shape of what that candidate traded (delimiter-free, non-ASCII, short inputs, per country).

${corrTable}

## Beyond reach — fails on every model (${beyondReach.length})

The persistent core: addresses no current candidate parses. Per-country breakdown (the correlation), then a sample.

${countryTable}

### Sample (first ${Math.min(SAMPLE, beyondReach.length)} of ${beyondReach.length})

${beyondSample}

## Model-specific — where candidates disagree (${diffs.length})

A ✓ under one model and a failure under another = a fix or a regression **between** candidates — the diff you track release-over-release.

${diffTable}
`

await writeLocalFile(mdx, outPath)

// The machine-readable twin of the MDX above. It goes under `$MAILWOMAN_TEMP_ROOT` rather than a repo-relative
// path, which git ignores — a file written there exists only on the machine that wrote it.
const jsonPath = tempRootPath("failure-report.json")

await writeLocalJSONFile({ summary, records: all }, jsonPath)

process.stderr.write(
	`\nfailure-report: ${fixtures.length} fixtures, ${beyondReach.length} beyond-reach, ${diffs.length} model-specific.\n` +
		`  per-model label-failures: ${JSON.stringify(summary.perModelFailCount)}\n` +
		`  wrote ${outPath} + ${jsonPath}\n`
)
