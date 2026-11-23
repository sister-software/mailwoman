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
 * `--decoder-arm <setting>` re-parses a row with one decoder setting on against its default,
 * for the rows the setting can change: a placetype-pair setting on rows where the pair prior fired,
 * `fstCountryRouting` on rows whose locale head confidently reads a country other than the route's.
 * `--decoder-arm-every k` re-parses every k-th other row too, to check that bound.
 * `--decoder-only` skips the FST vote-rule arms.
 *
 * This command isn't a release eval.
 *
 * Usage:
 *
 *     node packages/mailwoman/tools/dev-tools/grammar/fst-namesake-census.run.ts --out-dir <dir>
 *     node packages/mailwoman/tools/dev-tools/grammar/fst-namesake-census.run.ts --heldout <manifest.json> --limit 200
 *     node packages/mailwoman/tools/dev-tools/grammar/fst-namesake-census.run.ts --heldout <manifest.json> --country FR --base-route
 *     node packages/mailwoman/tools/dev-tools/grammar/fst-namesake-census.run.ts --inputs <one-input-per-line.txt>
 *
 * With no `--heldout` or `--inputs`, it reads the Gauntlet board.
 * It writes `<label>-summary.json` and `<label>-rows.jsonl` to `--out-dir`.
 */

import { writeLocalJSONFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { getRow } from "@mailwoman/core/utils"
import type { NeuralParseTrace } from "@mailwoman/neural/decode/trace"
import { confidentLocaleCountry } from "@mailwoman/neural/labels/address-system"
import {
	findFSTAcceptedMatches,
	PLACETYPE_TO_BIO,
	type FSTMatcherLike,
	type FSTPlaceEntryLike,
} from "@mailwoman/neural/prior/fst"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { DECODER_SETTING_KEYS } from "#geocode/core"
import { buildGauntletDeps } from "#tools/eval-harness/gauntlet/harness"
import { overlayLocale } from "#tools/eval-harness/gauntlet/routing"
import {
	comparePaths,
	emptyFlipGrades,
	fstBiasOn,
	fstVotes,
	gradeFlip,
	localeHeadReading,
	maximumVote,
	pieceTruthTags,
	priorFlipSpans,
	transformFSTEntries,
	truthTagForRange,
	type FlipGrade,
	type FSTVote,
	type LocaleHeadReading,
	type PathMove,
} from "#tools/eval-harness/grammar/census"
import { readDecodeCensusRows, truthInText } from "#tools/eval-harness/grammar/census/rows"

const RULE_A_THRESHOLDS = [0.5, 0.8, 0.9, 0.95, 0.99, 0.999] as const
const ARMS = ["A", "B0", "B1", "C"] as const

type Arm = (typeof ARMS)[number]

type DecoderSettingKey = (typeof DECODER_SETTING_KEYS)[number]

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
		// A decoder setting to re-parse with, on against the default, repeatable.
		"decoder-arm": { type: "string", multiple: true },
		// Also re-parse every k-th row outside a decoder arm's population, to check the population bound.
		"decoder-arm-every": { type: "string" },
		// Skip the FST vote-rule arms, for a run that measures only decoder settings.
		"decoder-only": { type: "boolean" },
		// A weights cache the base parse loads from, in place of the installed packages.
		"weights-cache": { type: "string" },
		// A weights cache whose packages differ from the base parse's only in their pair indexes.
		// Each row the base pair prior fired on is re-parsed with it, as the arm `pairIndexCache`.
		"pair-index-cache": { type: "string" },
	},
})

const pairIndexCache = values["pair-index-cache"] ?? null

const decoderArms = (values["decoder-arm"] ?? []) as DecoderSettingKey[]

for (const name of decoderArms) {
	if (!(DECODER_SETTING_KEYS as readonly string[]).includes(name)) {
		throw new Error(`unknown --decoder-arm ${name}; the decoder settings are ${DECODER_SETTING_KEYS.join(", ")}`)
	}
}

const decoderArmEvery = values["decoder-arm-every"] ? Number(values["decoder-arm-every"]) : 0

const outDir = values["out-dir"] ?? "/mnt/mw/audits/fst-census"
const limit = values.limit ? Number(values.limit) : Number.POSITIVE_INFINITY

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
	/**
	 * Each decoder setting that changed the row's path, with the setting on against the default,
	 * and `pairIndexCache` when the `--pair-index-cache` parse changed it.
	 */
	decoderArms: Partial<Record<DecoderSettingKey | "pairIndexCache", ArmReceipt>>
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
	/**
	 * Per arm, the rows it re-parsed (`rows`) and what moved.
	 */
	arms: Record<
		string,
		{ rows: number; rowsChanged: number; rowsImproved: number; rowsRegressed: number; gained: number; lost: number }
	>
}

const armKeys = [
	...RULE_A_THRESHOLDS.map((t) => `A@${t}`),
	"B0",
	"B1",
	"C",
	...decoderArms.map((name) => `decoder:${name}`),
	...decoderArms.map((name) => `decoder:${name}:outside`),
	...(pairIndexCache ? ["decoder:pairIndexCache", "decoder:pairIndexCache:outside"] : []),
]

function emptyTally(): CountryTally {
	return {
		rows: 0,
		rowsWithFST: 0,
		rowsWithFlip: 0,
		flips: 0,
		flipGrades: emptyFlipGrades(),
		foreignFlips: 0,
		foreignFlipGrades: emptyFlipGrades(),
		maximumVotes: 0,
		maximumVotesUnknownCountry: 0,
		maximumVotesForeignToRow: 0,
		maximumVotesForeignToHead: 0,
		maximumVoteCountries: {},
		arms: Object.fromEntries(
			armKeys.map((key) => [key, { rows: 0, rowsChanged: 0, rowsImproved: 0, rowsRegressed: 0, gained: 0, lost: 0 }])
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
	if (!receipt) return
	const arm = tally.arms[key]!

	arm.rows++

	if (!receipt.changedPieces.length) return

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

	await writeLocalJSONLFile(receipts, `${outDir}/${label}-rows.jsonl`)
}

await using deps = await buildGauntletDeps(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {})
await using indexDeps = pairIndexCache ? await buildGauntletDeps({ weightsCacheRoot: pairIndexCache }) : null

for await (const row of readDecodeCensusRows({
	...(values.heldout ? { heldout: values.heldout } : {}),
	...(values.inputs ? { inputs: values.inputs } : {}),
})) {
	if (processed >= limit) break

	if (countryFilter && !countryFilter.has(row.country?.toUpperCase() ?? "")) continue

	processed++
	const tally = tallyFor(row.collection, row.country)

	tally.rows++
	const caseOpts = row.country && !values["base-route"] ? { caseCountry: row.country } : {}
	const base = await deps.diagnoseParse(row.input, caseOpts)
	const { trace } = base
	const head = localeHeadReading(trace.localeLogits, trace.localeCountries)
	const truth = truthInText(row, trace.text)
	const baseLabels = pathLabels(trace)
	const pieceTruth = pieceTruthTags(trace.pieces, trace.text, truth.spans, truth.complete)

	// The decoder arms: each re-parses the rows its setting can change, and every k-th other row as a check.
	const decoderReceipts: RowReceipt["decoderArms"] = {}
	const pairApplied = trace.priors.some((prior) => prior.kind === "placetypePair" && prior.applied)

	const routeCountry = overlayLocale(caseOpts.caseCountry ?? null)
		.split("-")[1]!
		.toUpperCase()

	const headCountry = confidentLocaleCountry(trace.localeLogits)?.country ?? null

	for (const name of decoderArms) {
		const inPopulation =
			name === "fstCountryRouting" ? Boolean(base.fst && headCountry && headCountry !== routeCountry) : pairApplied

		const sampled = !inPopulation && decoderArmEvery > 0 && processed % decoderArmEvery === 0

		if (!inPopulation && !sampled) continue

		const arm = await deps.diagnoseParse(row.input, caseOpts, undefined, { [name]: true })
		const receipt = armReceipt(trace, baseLabels, pathLabels(arm.trace), pieceTruth)

		addArm(tally, inPopulation ? `decoder:${name}` : `decoder:${name}:outside`, receipt)

		if (receipt.changedPieces.length) {
			decoderReceipts[name] = receipt
		}
	}

	// A pair index with entries left out can only fire on fewer rows, so the rows the base index fired on bound it.
	if (indexDeps && (pairApplied || (decoderArmEvery > 0 && processed % decoderArmEvery === 0))) {
		const arm = await indexDeps.diagnoseParse(row.input, caseOpts)
		const receipt = armReceipt(trace, baseLabels, pathLabels(arm.trace), pieceTruth)

		addArm(tally, pairApplied ? "decoder:pairIndexCache" : "decoder:pairIndexCache:outside", receipt)

		if (receipt.changedPieces.length) {
			decoderReceipts.pairIndexCache = receipt
		}
	}

	const decoderChanged = Object.keys(decoderReceipts).length > 0

	const headReceipt = head
		? {
				country: head.country,
				confidence: head.confidence,
				rowCountryProbability: row.country ? (head.probabilities[row.country.toUpperCase()] ?? null) : null,
			}
		: null

	if (!base.fst) {
		if (decoderChanged) {
			receipts.push({
				collection: row.collection,
				id: row.id,
				input: row.input,
				country: row.country,
				head: headReceipt,
				flips: [],
				arms: {},
				decoderArms: decoderReceipts,
			})
		}

		continue
	}

	tally.rowsWithFST++
	const matches = findFSTAcceptedMatches(base.fst, trace.pieces)
	const votes = fstVotes(matches, trace.pieces)
	const flips = priorFlipSpans(trace.explanation, "fst") ?? []

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
		let best = maximumVote(votes, flip.withPrior, flip.startPiece, flip.endPiece)

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
			withFST: flip.withPrior,
			withoutFST: flip.withoutPrior,
			truth: truthTag,
			grade: gradeFlip(flip.withPrior, flip.withoutPrior, truthTag),
			bias: fstBiasOn(trace.explanation, flip.withPrior, flip.startPiece, flip.endPiece),
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
	const entries = matches.flatMap((match) => match.entries)
	const mapped = entries.filter((entry) => PLACETYPE_TO_BIO.has(entry.placetype))

	const armParse = async (wrap: (fst: FSTMatcherLike) => FSTMatcherLike) =>
		armReceipt(trace, baseLabels, pathLabels((await deps.diagnoseParse(row.input, caseOpts, wrap)).trace), pieceTruth)

	const voteRules = !values["decoder-only"]

	if (voteRules && head) {
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

	if (voteRules && entries.some((entry) => (RULE_C_PLACETYPES as readonly string[]).includes(entry.placetype))) {
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

	if (flipReceipts.length || armChanged || decoderChanged) {
		receipts.push({
			collection: row.collection,
			id: row.id,
			input: row.input,
			country: row.country,
			head: headReceipt,
			flips: flipReceipts,
			arms: Object.fromEntries(Object.entries(arms).filter(([, receipt]) => receipt.changedPieces.length)) as Partial<
				Record<Arm, ArmReceipt>
			>,
			decoderArms: decoderReceipts,
		})
	}

	if (processed % 2000 === 0) {
		console.error(`[fst-census] ${processed} rows, ${Math.round((Date.now() - startedAt) / 1000)}s`)

		await checkpoint(false)
	}
}

await checkpoint(true)

console.error(`[fst-census] done: ${processed} rows in ${Math.round((Date.now() - startedAt) / 1000)}s`)
