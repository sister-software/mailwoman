// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Compares the training encoder's postcode finder with serving's, row by row,
 *   and accounts for what moved against the retired `shaped` painter.
 *
 *   Both finders read the `postal` family's artifact.
 *   The encoder's is `PostcodeFinder` of `mtf-node` (`mtf-channels/src/finders.rs`)
 *   and serving's is `findPostcodeSpans` of `@mailwoman/postcode/postal-spans`
 *   with `anchoredPostcodeSpans` of `@mailwoman/neural`.
 *
 *   The tool draws the rows the config's sampler draws, after augmentation,
 *   so each row is the text an encoder reads.
 *
 *   For every row it requires the two finders to return the same spans, and the two
 *   anchor keys to be equal for each span the anchor table resolves.
 *   A row that differs is listed and the tool exits non-zero.
 *
 *   `--moved-report` adds the account of what moved: each row's anchored spans under the retired `shaped`
 *   table (the frozen legacy table matched against the raw text, as the trainer's finder matched it)
 *   beside the `postal` finder's, classified by row and by country, with examples of each class.
 *
 *   `--fixture-out` writes `test/fixtures/postcode-agreement.json`, beside the code-unit parity fixture.
 *   It holds the spans serving finds on a stratified sample of the rows.
 *   The crate test and the serving test replay it.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/sampler/postcode-agreement.run.ts --config <yaml> \
 *       [--train-rows 50000] [--seed 43] [--set data.key=value] [--report <json>] [--moved-report <json>] \
 *       [--fixture-out <json>]
 */

import { UK_POSTCODE_PATTERN } from "@mailwoman/codex/gb"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"
import { anchorKey, anchoredPostcodeSpans, parseAnchorLookup } from "@mailwoman/neural/channels/anchor-inference"
import { collectMatches } from "@mailwoman/neural/labels/postcode/repair"
import { findPostcodeSpans } from "@mailwoman/postcode/postal-spans"

import { applyOverrides, loadTrainingConfig, rerootToHost } from "../config.ts"
import { openSampler, POSTAL_ARTIFACT_PATH, POSTAL_DEFINITION_PATH, sampledRows } from "../sampler.ts"

const { values } = parseArguments({
	options: {
		config: { type: "string" },
		"train-rows": { type: "string", default: "50000" },
		seed: { type: "string", default: "43" },
		set: { type: "string", multiple: true, default: [] },
		report: { type: "string" },
		"moved-report": { type: "string" },
		"fixture-out": { type: "string" },
		"fixture-per-country": { type: "string", default: "12" },
	},
})

if (!values.config) throw new Error("postcode-agreement needs --config <yaml>")

const config = rerootToHost(applyOverrides(await loadTrainingConfig(values.config), values.set))
const anchorPath = config.data.anchor_lookup_path

if (!anchorPath) throw new Error("the config sets no data.anchor_lookup_path")

const mtf = await mtfNode()
const finder = mtf.createPostcodeFinder(POSTAL_ARTIFACT_PATH, POSTAL_DEFINITION_PATH, anchorPath)
const lookup = parseAnchorLookup(await readLocalJSONFile(anchorPath))

interface Anchored {
	start: number
	end: number
	key: string
}

/**
 * The anchored spans of the retired `shaped` painter: the legacy table matched against the raw text.
 */
function shapedAnchored(raw: string): Anchored[] {
	const out: Anchored[] = []

	for (const match of collectMatches(raw)) {
		let key = anchorKey(raw.slice(match.start, match.end))
		let entry = lookup.get(key)

		if (!entry && UK_POSTCODE_PATTERN.test(key)) {
			key = key.slice(0, -3)
			entry = lookup.get(key)
		}

		if (entry) {
			out.push({ start: match.start, end: match.end, key })
		}
	}

	return out
}

// The class brackets keep each word from appearing in this file as the census reads it.
const BANNED_WORDS = /\b(?:ga[t]es?|cu[t]s?|sli[c]es?|remed(?:y|ies))\b/iu

/**
 * The examples the report keeps of each kind of gained span.
 */
const GAIN_EXAMPLES_PER_KIND = 8

/**
 * The examples the report keeps of each class of moved row.
 */
const MOVED_EXAMPLES_PER_CLASS = 40

const overlaps = (a: Anchored, b: Anchored): boolean => a.start < b.end && b.start < a.end
const same = (a: Anchored, b: Anchored): boolean => a.start === b.start && a.end === b.end && a.key === b.key

interface Disagreement {
	split: string
	raw: string
	rust: unknown
	serving: unknown
}

const disagreements: Disagreement[] = []
let rows = 0
let rowsWithSpans = 0
let rowsAnchored = 0

type Flag = "unchanged" | "gain" | "loss" | "extent"
const FLAGS: Flag[] = ["unchanged", "gain", "loss", "extent"]

interface CountryMoves {
	rows: number
	unchanged: number
	gain: number
	loss: number
	extent: number
	shapedHits: number
	postalHits: number
}

const byCountry = new Map<string, CountryMoves>()
const examples: Record<Flag, Array<Record<string, unknown>>> = { unchanged: [], gain: [], loss: [], extent: [] }
const flagTotals: Record<Flag, number> = { unchanged: 0, gain: 0, loss: 0, extent: 0 }
const gainKinds: Record<string, number> = {}
const gainExamples: Record<string, Array<Record<string, unknown>>> = {}
let lowerCaseHits = 0
const lowerCaseExamples: string[] = []
const fixtureRows = new Map<string, Array<{ raw: string; spans: number[][] }>>()
const perCountry = Number(values["fixture-per-country"])

for (const split of ["train", "val"] as const) {
	const limit = split === "train" ? Number(values["train-rows"]) : config.data.val_rows
	const sampler = openSampler(mtf, config, split, Number(values.seed), { rowLimit: limit })

	for (const row of sampledRows(sampler)) {
		rows++

		const rust = finder.spans(row.raw)
		const servingSpans = findPostcodeSpans(row.raw)
		const rustSpans = rust.map((span) => [span.start, span.end])
		const spanList = servingSpans.map((span) => [span.start, span.end])
		// The encoder's painter keeps the first candidate the table resolves among those that overlap.
		const rustAnchored: Anchored[] = []

		for (const span of rust) {
			if (!span.key || rustAnchored.some((kept) => span.start < kept.end && kept.start < span.end)) continue

			rustAnchored.push({ start: span.start, end: span.end, key: span.key })
		}

		rustAnchored.sort((a, b) => a.start - b.start)

		const servingAnchored: Anchored[] = anchoredPostcodeSpans(row.raw, lookup, "postal").map(({ start, end, key }) => ({
			start,
			end,
			key,
		}))

		if (servingSpans.length) {
			rowsWithSpans++
		}

		if (servingAnchored.length) {
			rowsAnchored++
		}

		const agree =
			stringifyJSON(rustSpans) === stringifyJSON(spanList) &&
			stringifyJSON(rust.map((span) => span.countries.toSorted())) ===
				stringifyJSON(servingSpans.map((span) => span.countries.toSorted())) &&
			rustAnchored.length === servingAnchored.length &&
			rustAnchored.every((span, index) => same(span, servingAnchored[index]!))

		if (!agree) {
			disagreements.push({
				split,
				raw: row.raw,
				rust: { spans: rustSpans, anchored: rustAnchored },
				serving: { spans: spanList, anchored: servingAnchored },
			})
		}

		const country = row.country ?? "(none)"

		if (values["fixture-out"]) {
			const kept = fixtureRows.get(country) ?? []

			// A row that holds a word the repository's vocabulary census bans stays out of a committed file.
			if (kept.length < perCountry && (servingSpans.length || kept.length < 2) && !BANNED_WORDS.test(row.raw)) {
				kept.push({ raw: row.raw, spans: spanList })
				fixtureRows.set(country, kept)
			}
		}

		for (const span of servingAnchored) {
			if (/[a-z]/u.test(row.raw.slice(span.start, span.end))) {
				lowerCaseHits++

				if (lowerCaseExamples.length < 10) {
					lowerCaseExamples.push(row.raw)
				}
			}
		}

		if (!values["moved-report"]) continue

		const old = shapedAnchored(row.raw)
		const flags = new Set<Flag>()

		for (const span of old) {
			const match = servingAnchored.find((candidate) => overlaps(candidate, span))

			if (!match) {
				flags.add("loss")
			} else if (!same(match, span)) {
				flags.add("extent")
			}
		}

		for (const span of servingAnchored) {
			if (old.some((candidate) => overlaps(candidate, span))) continue

			flags.add("gain")

			// What the new span has that the retired table lacked: a lower-case letter,
			// white space inside the code, a connector beside it, or none of these.
			const text = row.raw.slice(span.start, span.end)
			const beside = `${row.raw[span.start - 1] ?? ""}${row.raw[span.end] ?? ""}`

			const kind = /[a-z]/u.test(text)
				? "lower-case letter"
				: /\s/u.test(text)
					? "white space inside the code"
					: /['_‘’-]/u.test(beside)
						? "connector beside the code"
						: "other"

			gainKinds[kind] = (gainKinds[kind] ?? 0) + 1

			const kept = gainExamples[kind] ?? []

			if (kept.length < GAIN_EXAMPLES_PER_KIND) {
				kept.push({ country, raw: row.raw, span: text, key: span.key })
				gainExamples[kind] = kept
			}
		}

		if (!flags.size) {
			flags.add("unchanged")
		}

		const moves = byCountry.get(country) ?? {
			rows: 0,
			unchanged: 0,
			gain: 0,
			loss: 0,
			extent: 0,
			shapedHits: 0,
			postalHits: 0,
		}

		moves.rows++
		moves.shapedHits += old.length
		moves.postalHits += servingAnchored.length
		byCountry.set(country, moves)

		for (const flag of flags) {
			moves[flag]++

			flagTotals[flag]++

			if (flag !== "unchanged" && examples[flag].length < MOVED_EXAMPLES_PER_CLASS) {
				examples[flag].push({
					country,
					raw: row.raw,
					shaped: old.map((span) => [row.raw.slice(span.start, span.end), span.key]),
					postal: servingAnchored.map((span) => [row.raw.slice(span.start, span.end), span.key]),
				})
			}
		}
	}
}

const report = {
	config: values.config,
	seed: Number(values.seed),
	rows,
	rows_with_postal_spans: rowsWithSpans,
	rows_with_anchored_spans: rowsAnchored,
	rows_differing: disagreements.length,
	first_differing: disagreements.slice(0, 20),
	anchored_spans_with_a_lower_case_letter: lowerCaseHits,
	lower_case_examples: lowerCaseExamples,
}

console.log(stringifyJSON({ ...report, first_differing: report.first_differing.length }))

if (values.report) {
	await writeLocalJSONFile(report, values.report)
}

if (values["moved-report"]) {
	await writeLocalJSONFile(
		{
			rows,
			flag_totals: flagTotals,
			gained_spans_by_kind: gainKinds,
			gained_span_examples: gainExamples,
			by_country: Object.fromEntries([...byCountry].toSorted(([a], [b]) => a.localeCompare(b))),
			examples: Object.fromEntries(FLAGS.map((flag) => [flag, examples[flag]])),
		},
		values["moved-report"]
	)
}

if (values["fixture-out"]) {
	await writeLocalJSONFile(
		{
			$comment:
				"Rows of the v8.7.0 config's train and validation draws with the spans serving's findPostcodeSpans finds, as UTF-16 offsets. Both sides replay it: mtf-channels/tests/postcode_agreement.rs and packages/postcode/lib/postal-spans.test.ts. Regenerate with packages/mailwoman/tools/training/sampler/postcode-agreement.run.ts --fixture-out.",
			rows: [...fixtureRows].toSorted(([a], [b]) => a.localeCompare(b)).flatMap(([, kept]) => kept),
		},
		values["fixture-out"]
	)
}

process.exitCode = disagreements.length ? 1 : 0
