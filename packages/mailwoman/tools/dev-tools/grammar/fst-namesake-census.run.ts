// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Report-only census of the FST gazetteer votes that change a decoded tag,
 * and of what three candidate vote rules would change on the same rows.
 *
 * Each row parses through the Gauntlet's own parse path with its country's weights and FST.
 * A span counts as FST-flipped when the decode explanation's FST ledger entry lists it:
 * the decoder labels it differently with the FST prior removed and every other term kept.
 *
 * The voter on a flipped span is the entry with the highest referential for the tag
 * the FST decode took, with its country read from the WOF `spr` table.
 *
 * The arms re-parse a row with a wrapped FST and change no decoder code:
 * - `A`: drop every entry whose country differs from the locale head's top country.
 *   A threshold `t` applies the drop only when the head's confidence is at least `t`.
 * - `B0` and `B1`: scale each entry's referential by the head's probability for its country.
 *   A country outside the head's set weighs 0 under `B0` and 1 under `B1`.
 * - `C`: tag `neighbourhood` and `macrohood` votes as `dependent_locality`,
 *   by overriding the placetype map for the arm's parse only.
 *
 * This command isn't a release eval.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { getRow } from "@mailwoman/core/utils"
import {
	findFSTAcceptedMatches,
	PLACETYPE_TO_BIO,
	type FSTMatcherLike,
	type FSTPlaceEntryLike,
} from "@mailwoman/neural/fst-prior"
import type { NeuralParseTrace } from "@mailwoman/neural/trace"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"
import { buildGauntletDeps } from "#tools/eval-harness/gauntlet/harness"
import {
	comparePaths,
	fstBiasOn,
	fstFlipSpans,
	fstVotes,
	gradeFlip,
	localeHeadReading,
	locateUniqueComponentTruth,
	maximumVote,
	pieceTruthTags,
	transformFSTEntries,
	truthTagForRange,
	type FlipGrade,
	type FSTVote,
	type LocaleHeadReading,
	type PathMove,
	type TruthSpan,
} from "#tools/eval-harness/grammar/census"
import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"

const RULE_A_THRESHOLDS = [0.5, 0.8, 0.9, 0.95, 0.99, 0.999] as const
const ARMS = ["A", "B0", "B1", "C"] as const

type Arm = (typeof ARMS)[number]

const { values } = parseArguments({
	options: {
		heldout: { type: "string", multiple: true },
		inputs: { type: "string" },
		// Parse every row through the base package, as the CLI's default locale does, rather than its country's overlay.
		"base-route": { type: "boolean" },
		country: { type: "string", multiple: true },
		"out-dir": { type: "string" },
		limit: { type: "string" },
		"wof-db": { type: "string" },
	},
})

const outDir = values["out-dir"] ?? "/mnt/mw/audits/fst-census"
const limit = values.limit ? Number(values.limit) : Number.POSITIVE_INFINITY

interface CensusRow {
	collection: string
	id: string
	input: string
	country: string | null
	/**
	 * Character truth against `input`, or the board's component values located in the parsed text.
	 */
	truth: { spans: TruthSpan[]; complete: true } | { components: Record<string, string>; complete: false }
}

async function* censusRows(): AsyncGenerator<CensusRow> {
	const manifests = values.heldout ?? []

	// One input per line, parsed through the base route, with no truth.
	if (values.inputs) {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- A hand-written probe list of a few dozen lines.
		for (const input of (await readLocalTextFile(values.inputs)).split("\n").filter((line) => line.trim())) {
			yield { collection: "inputs", id: input, input, country: null, truth: { components: {}, complete: false } }
		}

		return
	}

	if (!manifests.length) {
		for (const row of await loadRegressionCases()) {
			yield {
				collection: "board",
				id: row.id,
				input: row.input,
				country: row.locale?.split("-")[1] ?? row.country,
				truth: { components: row.expectComponents ?? {}, complete: false },
			}
		}

		return
	}

	for (const manifestPath of manifests) {
		const { manifest, rows } = await readHeldoutDatasetRows(manifestPath)
		const collection = `${manifest.datasetID}@${manifest.version.slice(0, 16)}`

		for (const [index, row] of rows.entries()) {
			yield {
				collection,
				id: row.source_id ?? `${row.group}#${index}`,
				input: row.raw,
				country: row.country,
				truth: {
					spans: row.span_tags.map((tag, span) => ({
						tag,
						start: row.span_starts[span]!,
						end: row.span_ends[span]!,
					})),
					complete: true,
				},
			}
		}
	}
}

/**
 * Truth in the parsed text's coordinates.
 *
 * Held-out character truth is used as given only when the parsed text is the input up to case.
 */
function truthInText(row: CensusRow, text: string): { spans: TruthSpan[]; complete: boolean } {
	if (!row.truth.complete) {
		return { spans: locateUniqueComponentTruth(text, row.truth.components), complete: false }
	}

	if (text.length === row.input.length && text.toLowerCase() === row.input.toLowerCase()) {
		return { spans: row.truth.spans, complete: true }
	}

	const components: Record<string, string> = {}

	for (const span of row.truth.spans) {
		components[`${span.tag}\u0000${span.start}`] = row.input.slice(span.start, span.end)
	}

	return {
		spans: locateUniqueComponentTruth(text, components).map((span) => ({
			...span,
			tag: span.tag.split("\u0000")[0]!,
		})),
		complete: false,
	}
}

using wof = new DatabaseClient<WOFDatabase>(
	values["wof-db"] ?? wofDatabasePath("admin-global-priority.db").toString(),
	{
		readOnly: true,
	}
)

const countryStatement = wof.prepare("SELECT country FROM spr WHERE id = ?")
const countryCache = new Map<number, string | null>()

function countryOf(wofID: number): string | null {
	let country = countryCache.get(wofID)

	if (country === undefined) {
		const row = getRow<{ country: string }>(countryStatement, wofID)
		country = row?.country ? row.country.toUpperCase() : null
		countryCache.set(wofID, country)
	}

	return country
}

function armTransform(arm: Exclude<Arm, "C">, head: LocaleHeadReading) {
	return (entries: FSTPlaceEntryLike[]): FSTPlaceEntryLike[] => {
		if (arm === "A") {
			return entries.filter((entry) => {
				const country = countryOf(entry.wofID)

				return country === null || country === head.country
			})
		}

		return entries.map((entry) => {
			const country = countryOf(entry.wofID)

			if (country === null) return entry
			const weight = head.probabilities[country] ?? (arm === "B0" ? 0 : 1)

			return { ...entry, referential: entry.referential * weight }
		})
	}
}

const RULE_C_PLACETYPES = ["neighbourhood", "macrohood"] as const

/**
 * Parses with `neighbourhood` and `macrohood` mapped to `dependent_locality`, restoring the map after.
 */
async function withRuleCMap<T>(parse: () => Promise<T>): Promise<T> {
	// The census overrides the shared map for one parse rather than changing the decoder.
	const map = PLACETYPE_TO_BIO as Map<string, string>
	const saved = RULE_C_PLACETYPES.map((placetype) => [placetype, map.get(placetype)] as const)

	for (const placetype of RULE_C_PLACETYPES) {
		map.set(placetype, "dependent_locality")
	}

	try {
		return await parse()
	} finally {
		for (const [placetype, tag] of saved) {
			if (tag == null) {
				map.delete(placetype)
			} else {
				map.set(placetype, tag)
			}
		}
	}
}

interface VoterReceipt {
	wofID: number
	name: string | null
	placetype: string
	/**
	 * The tag the entry votes for.
	 *
	 * It differs from the flip's FST tag when no entry voted for that tag.
	 */
	tag: string
	referential: number
	country: string | null
	votesForTag: number
}

interface FlipReceipt {
	text: string
	withFST: string
	withoutFST: string
	truth: string | null
	grade: FlipGrade
	bias: number | null
	voter: VoterReceipt | null
	voterForeignToHead: boolean | null
	voterForeignToRow: boolean | null
}

interface ArmReceipt extends PathMove {
	changed: Array<{ text: string; from: string; to: string }>
}

interface RowReceipt {
	collection: string
	id: string
	input: string
	country: string | null
	head: { country: string; confidence: number; rowCountryProbability: number | null } | null
	flips: FlipReceipt[]
	arms: Partial<Record<Arm, ArmReceipt>>
}

function voterReceipt(vote: FSTVote | null, count: number): VoterReceipt | null {
	if (!vote) return null

	return {
		wofID: vote.entry.wofID,
		name: vote.entry.name ?? null,
		placetype: vote.entry.placetype,
		tag: vote.tag,
		referential: vote.entry.referential,
		country: countryOf(vote.entry.wofID),
		votesForTag: count,
	}
}

function pathLabels(trace: NeuralParseTrace): string[] {
	return trace.path.map((index) => trace.labels[index] ?? "O")
}

function spanText(trace: NeuralParseTrace, start: number, end: number): string {
	return trace.text.slice(trace.pieces[start]!.start, trace.pieces[end - 1]!.end)
}

function armReceipt(trace: NeuralParseTrace, base: string[], arm: string[], truth: Array<string | null>): ArmReceipt {
	const move = comparePaths(base, arm, truth)

	return {
		...move,
		changed: move.changedPieces.map((piece) => ({
			text: spanText(trace, piece, piece + 1),
			from: base[piece]!,
			to: arm[piece]!,
		})),
	}
}

/**
 * Per-country tallies.
 */
interface CountryTally {
	rows: number
	rowsWithFST: number
	rowsWithFlip: number
	flips: number
	flipGrades: Record<FlipGrade, number>
	foreignFlips: number
	foreignFlipGrades: Record<FlipGrade, number>
	/**
	 * Maximum votes per accepted match and tag, and those whose voter is foreign.
	 */
	maximumVotes: number
	maximumVotesUnknownCountry: number
	maximumVotesForeignToRow: number
	maximumVotesForeignToHead: number
	/**
	 * The maximum votes by voter country.
	 */
	maximumVoteCountries: Record<string, number>
	arms: Record<
		string,
		{ rowsChanged: number; rowsImproved: number; rowsRegressed: number; gained: number; lost: number }
	>
}

const emptyGrades = (): Record<FlipGrade, number> => ({ helped: 0, hurt: 0, neither: 0, unclassified: 0 })

const armKeys = [...RULE_A_THRESHOLDS.map((t) => `A@${t}`), "B0", "B1", "C"]

function emptyTally(): CountryTally {
	return {
		rows: 0,
		rowsWithFST: 0,
		rowsWithFlip: 0,
		flips: 0,
		flipGrades: emptyGrades(),
		foreignFlips: 0,
		foreignFlipGrades: emptyGrades(),
		maximumVotes: 0,
		maximumVotesUnknownCountry: 0,
		maximumVotesForeignToRow: 0,
		maximumVotesForeignToHead: 0,
		maximumVoteCountries: {},
		arms: Object.fromEntries(
			armKeys.map((key) => [key, { rowsChanged: 0, rowsImproved: 0, rowsRegressed: 0, gained: 0, lost: 0 }])
		),
	}
}

const tallies = new Map<string, CountryTally>()

function tallyFor(collection: string, country: string | null): CountryTally {
	const key = `${collection}\t${country ?? "??"}`
	let tally = tallies.get(key)

	if (!tally) {
		tally = emptyTally()
		tallies.set(key, tally)
	}

	return tally
}

function addArm(tally: CountryTally, key: string, receipt: ArmReceipt | undefined): void {
	if (!receipt?.changedPieces.length) return
	const arm = tally.arms[key]!

	arm.rowsChanged++
	arm.gained += receipt.gained
	arm.lost += receipt.lost

	if (receipt.gained > receipt.lost) {
		arm.rowsImproved++
	}

	if (receipt.lost > receipt.gained) {
		arm.rowsRegressed++
	}
}

const receipts: RowReceipt[] = []
const countryFilter = values.country?.length ? new Set(values.country.map((code) => code.toUpperCase())) : null

const label =
	(values.inputs ? "inputs" : values.heldout?.length ? "heldout" : "board") + (values["base-route"] ? "-base" : "")

const startedAt = Date.now()
let processed = 0

async function checkpoint(final: boolean): Promise<void> {
	const summary = {
		label,
		final,
		processed,
		seconds: Math.round((Date.now() - startedAt) / 1000),
		ruleAThresholds: RULE_A_THRESHOLDS,
		tallies: Object.fromEntries(tallies),
	}

	await writeLocalJSONFile(summary, `${outDir}/${label}-summary.json`)

	await writeLocalTextFile(
		receipts.map((receipt) => stringifyJSON(receipt)),
		`${outDir}/${label}-rows.jsonl`
	)
}

using deps = await buildGauntletDeps()

for await (const row of censusRows()) {
	if (processed >= limit) break

	if (countryFilter && !countryFilter.has(row.country?.toUpperCase() ?? "")) continue

	processed++
	const tally = tallyFor(row.collection, row.country)

	tally.rows++
	const caseOpts = row.country && !values["base-route"] ? { caseCountry: row.country } : {}
	const base = await deps.diagnoseParse(row.input, caseOpts)

	if (!base.fst) continue

	tally.rowsWithFST++
	const { trace } = base
	const matches = findFSTAcceptedMatches(base.fst, trace.pieces)
	const votes = fstVotes(matches, trace.pieces)
	const head = localeHeadReading(trace.localeLogits, trace.localeCountries)
	const truth = truthInText(row, trace.text)
	const flips = fstFlipSpans(trace.explanation) ?? []

	// The distribution: per accepted match and tag, the highest-referential vote.
	const maxima = new Map<string, FSTVote>()

	for (const vote of votes) {
		const key = `${vote.startPiece}:${vote.endPiece}:${vote.tag}`
		const best = maxima.get(key)

		if (!best || vote.entry.referential > best.entry.referential) {
			maxima.set(key, vote)
		}
	}

	for (const vote of maxima.values()) {
		tally.maximumVotes++
		const country = countryOf(vote.entry.wofID)
		const countryKey = country ?? "??"
		tally.maximumVoteCountries[countryKey] = (tally.maximumVoteCountries[countryKey] ?? 0) + 1

		if (country === null) {
			tally.maximumVotesUnknownCountry++

			continue
		}

		if (row.country && country !== row.country.toUpperCase()) {
			tally.maximumVotesForeignToRow++
		}

		if (head && country !== head.country) {
			tally.maximumVotesForeignToHead++
		}
	}

	const flipReceipts: FlipReceipt[] = flips.map((flip) => {
		const start = trace.pieces[flip.startPiece]!.start
		const end = trace.pieces[flip.endPiece - 1]!.end
		const truthTag = truthTagForRange(truth.spans, start, end, truth.complete)
		// A flip with no vote for the FST decode's tag came from another tag's vote or the
		// street suppression, so the receipt records the highest vote of any tag on the span.
		let best = maximumVote(votes, flip.withFST, flip.startPiece, flip.endPiece)

		if (!best.vote) {
			for (const tag of new Set(votes.map((candidate) => candidate.tag))) {
				const next = maximumVote(votes, tag, flip.startPiece, flip.endPiece)

				if (next.vote && (!best.vote || next.vote.entry.referential > best.vote.entry.referential)) {
					best = next
				}
			}
		}

		const { vote, count } = best

		const voter = voterReceipt(vote, count)

		return {
			text: trace.text.slice(start, end),
			withFST: flip.withFST,
			withoutFST: flip.withoutFST,
			truth: truthTag,
			grade: gradeFlip(flip.withFST, flip.withoutFST, truthTag),
			bias: fstBiasOn(trace.explanation, flip.withFST, flip.startPiece, flip.endPiece),
			voter,
			voterForeignToHead: voter?.country && head ? voter.country !== head.country : null,
			voterForeignToRow: voter?.country && row.country ? voter.country !== row.country.toUpperCase() : null,
		}
	})

	if (flipReceipts.length) {
		tally.rowsWithFlip++
	}

	for (const flip of flipReceipts) {
		tally.flips++

		tally.flipGrades[flip.grade]++

		if (flip.voterForeignToHead) {
			tally.foreignFlips++

			tally.foreignFlipGrades[flip.grade]++
		}
	}

	// The arms: a row whose FST entries an arm leaves unchanged decodes as the base did, so it isn't re-parsed.
	const arms: Partial<Record<Arm, ArmReceipt>> = {}
	const baseLabels = pathLabels(trace)
	const pieceTruth = pieceTruthTags(trace.pieces, trace.text, truth.spans, truth.complete)
	const entries = matches.flatMap((match) => match.entries)
	const mapped = entries.filter((entry) => PLACETYPE_TO_BIO.has(entry.placetype))

	const armParse = async (wrap: (fst: FSTMatcherLike) => FSTMatcherLike) =>
		armReceipt(trace, baseLabels, pathLabels((await deps.diagnoseParse(row.input, caseOpts, wrap)).trace), pieceTruth)

	if (head) {
		if (
			mapped.some((entry) => {
				const country = countryOf(entry.wofID)

				return country !== null && country !== head.country
			})
		) {
			arms.A = await armParse((fst) => transformFSTEntries(fst, armTransform("A", head)))
		}

		if (mapped.length) {
			arms.B0 = await armParse((fst) => transformFSTEntries(fst, armTransform("B0", head)))

			// B1 differs from B0 only on an entry whose country the head doesn't cover.
			const outsideHead = mapped.some((entry) => {
				const country = countryOf(entry.wofID)

				return country !== null && head.probabilities[country] == null
			})

			arms.B1 = outsideHead ? await armParse((fst) => transformFSTEntries(fst, armTransform("B1", head))) : arms.B0
		}
	}

	if (entries.some((entry) => (RULE_C_PLACETYPES as readonly string[]).includes(entry.placetype))) {
		arms.C = await withRuleCMap(() => armParse((fst) => fst))
	}

	for (const t of RULE_A_THRESHOLDS) {
		if (head && head.confidence >= t) {
			addArm(tally, `A@${t}`, arms.A)
		}
	}

	addArm(tally, "B0", arms.B0)
	addArm(tally, "B1", arms.B1)
	addArm(tally, "C", arms.C)

	const armChanged = Object.values(arms).some((receipt) => receipt.changedPieces.length)

	if (flipReceipts.length || armChanged) {
		receipts.push({
			collection: row.collection,
			id: row.id,
			input: row.input,
			country: row.country,
			head: head
				? {
						country: head.country,
						confidence: head.confidence,
						rowCountryProbability: row.country ? (head.probabilities[row.country.toUpperCase()] ?? null) : null,
					}
				: null,
			flips: flipReceipts,
			arms: Object.fromEntries(Object.entries(arms).filter(([, receipt]) => receipt.changedPieces.length)) as Partial<
				Record<Arm, ArmReceipt>
			>,
		})
	}

	if (processed % 2000 === 0) {
		console.error(`[fst-census] ${processed} rows, ${Math.round((Date.now() - startedAt) / 1000)}s`)

		await checkpoint(false)
	}
}

await checkpoint(true)

console.error(`[fst-census] done: ${processed} rows in ${Math.round((Date.now() - startedAt) / 1000)}s`)
