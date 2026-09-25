/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Compares labeled parse failures across model caches and writes an MDX report and a JSON summary.
 */

import { tempRootPath } from "@mailwoman/core/data-root"
import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isoDate } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"
import { basename, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { PARITY_FIXTURES_PATH, PARITY_FLOORS, type ParityFixture } from "#eval-harness/parity-corpus"

/**
 * Sets the largest token count in the short-query bucket.
 */
const SHORT_QUERY_TOKENS = 3

/**
 * Sets the rise in failure count over the first model that bolds a label-table cell.
 */
const NOTABLE_COUNT_GAP = 3

/**
 * Holds one fixture from either corpus.
 */
interface Fixture {
	id: string
	input: string
	country: string
	source: string
	expect: Record<string, string[]>
}

/**
 * Loads the parity corpus, or a golden JSONL directory when `spec` is `golden:<dir>[:<sampleN>]`.
 *
 * Golden street labels use the flat schema from before street was split into prefix, name and suffix.
 */
async function loadCorpus(
	spec: string | undefined
): Promise<{ fixtures: Fixture[]; kind: "parity" | "golden"; name: string }> {
	if (spec?.startsWith("golden:")) {
		const [, dir, sampleArg] = spec.split(":")
		const sampleN = sampleArg ? Number(sampleArg) : Infinity
		const files = Globerator.files("jsonl", { cwd: resolvePath(dir!), absolute: false, recursive: false })
		const fixtures: Fixture[] = []

		for await (const file of files) {
			const src = file.replace(/\.jsonl$/, "")
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

	const fixtures = await JSONSpliterator.fromAsync<ParityFixture>(PARITY_FIXTURES_PATH)
		.filter((f) => !f.dropped && f.expect)
		.map((f) => ({ id: f.id, input: f.input, country: f.country, source: f.source, expect: f.expect! }))
		.toArray()

	return { fixtures, kind: "parity", name: PARITY_FIXTURES_PATH.split("/").pop()! }
}

/**
 * Holds the input-shape flags that bucket the failure rates.
 */
interface StructuralFlags {
	/**
	 * Reports that the input has no separator punctuation.
	 */
	whitespaceOnly: boolean
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

/**
 * Holds one fixture's failures under each graded model.
 */
interface FixtureFailures {
	id: string
	input: string
	country: string
	source: string
	flags: StructuralFlags
	/**
	 * Maps a model label to the labels it failed.
	 * A model with no failure has no key.
	 */
	failsByModel: Record<string, { label: string; expected: string; got: string }[]>
}

async function runFailureReport(): Promise<void> {
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

		const floorTags = new Map<string, readonly string[]>(
			PARITY_FLOORS.map((f) => [f.label, f.tags as readonly string[]])
		)

		for (const f of fixtures) {
			const byTag = await parseTags(cls, f.input)
			const fails: { label: string; expected: string; got: string }[] = []

			// A floor label compares its whole tag family.
			// Every other label compares its own tag.
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
	const anyFail = all.filter((r) => Object.keys(r.failsByModel).length)
	// A fixture is beyond reach when every model fails it.
	const beyondReach = anyFail.filter((r) => labels.every((l) => r.failsByModel[l]))

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

	// This returns the failed count and pool size for one bucket and model.
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

	const outPath = flags.out || "docs/articles/evals/competitive-parity/failure-report.mdx"
	const stamp = flags.date || isoDate()

	// Addresses are escaped so a backtick or pipe cannot break an MDX table.
	const cell = (s: string): string => "`" + (s || "∅").replaceAll("`", "ˋ").replaceAll("|", "\\|") + "`"
	const pct2 = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(0)}%` : "—")
	const mdRow = (cells: (string | number)[]): string => `| ${cells.join(" | ")} |`

	function failMark(r: FixtureFailures, model: string): string {
		const fails = r.failsByModel[model]

		if (!fails) return "✓"

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

	// The beyond-reach section prints counts per country and then a capped sample.
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

	// A fixture that fails on some models but not all shows a fix or regression between candidates.
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

A count that **rises** across candidates (bold, with the delta vs the first model) is a class the candidate silently traded. This is the row that flags a regression the floor checks miss — e.g. \`country\` degrading across the fragment lineage.

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

	// The JSON summary goes to the temp root, outside the repository.
	const jsonPath = tempRootPath("failure-report.json")

	await writeLocalJSONFile({ summary, records: all }, jsonPath)

	process.stderr.write(
		`\nfailure-report: ${fixtures.length} fixtures, ${beyondReach.length} beyond-reach, ${diffs.length} model-specific.\n` +
			`  per-model label-failures: ${stringifyJSON(summary.perModelFailCount)}\n` +
			`  wrote ${outPath} + ${jsonPath}\n`
	)
}

await runFailureReport()
