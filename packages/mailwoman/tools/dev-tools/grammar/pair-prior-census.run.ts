// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Report-only census of the placetype-pair prior against postal convention.
 *
 * The inventory reads every pair index a shipped weights package declares.
 * It counts the (child, parent) pairs by tag edge, with three marks of postal
 * evidence from the country's GeoNames postal-code export:
 * - loose: the child's folded name is a postcode place name in the country.
 * - scoped: a postcode row of the child shares a first-level admin code with a row listing the parent.
 * - at location: the postcode point nearest a WOF record of the pair has the child's name.
 *   The `dropPostal` and `retag` arms read this mark.
 *
 * The parse census decodes each row through the Gauntlet's own parse path.
 * It reads the decode explanation's `placetypePair` ledger entry, as the FST census reads the FST's.
 *
 * Each fired edge is recovered by re-running the prior with a recording index.
 * The recomposed matrix must equal the ledger's cells.
 *
 * The arms re-decode the row's own captured emissions and change no decoder code:
 * - `none`: the prior removed.
 * - `dropPostal`: the prior without the edges whose child is postal at its location.
 * - `retag`: `dropPostal`, and a dependent-locality parent that's postal at its
 *   own location reads as the locality.
 * - `words` and `retagWords`: the prior and `retag` with no bias on separator pieces.
 * - `joint@J`: the prior removed, and the path that maximizes the Viterbi score plus `J` for
 *   each fired edge whose child and parent windows both take the edge's tags, decoded exactly.
 * - `jointDropPostal@J` and `jointRetag@J`: `joint@J` over the edges `dropPostal` and `retag` keep.
 *
 * Each arm is graded against the base decode, over every piece and over pieces with word content.
 *
 * This command isn't a release eval.
 *
 * Usage:
 *
 *     node packages/mailwoman/tools/dev-tools/grammar/pair-prior-census.run.ts --inventory-only
 *     node packages/mailwoman/tools/dev-tools/grammar/pair-prior-census.run.ts --out-dir <dir>
 *     node packages/mailwoman/tools/dev-tools/grammar/pair-prior-census.run.ts --heldout <manifest.json> --country US
 *
 * With no `--heldout` or `--inputs`, it reads the Gauntlet board.
 * It writes `inventory.json`, `<label>-summary.json` and `<label>-rows.jsonl` to `--out-dir`.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { PairIndexResolver, type PairEdge } from "@mailwoman/neural/pair/index/resolver"
import type { NeuralParseTrace } from "@mailwoman/neural/trace"
import { viterbi, type ViterbiTransitionAdjustment } from "@mailwoman/neural/viterbi"
import { resolveWeights } from "@mailwoman/neural/weights"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { buildGauntletDeps } from "#tools/eval-harness/gauntlet/harness"
import { OVERLAY_LOCALE_BY_COUNTRY } from "#tools/eval-harness/gauntlet/routing"
import {
	comparePaths,
	emptyFlipGrades,
	gradeFlip,
	pieceTruthTags,
	priorFlipSpans,
	truthTagForRange,
	type FlipGrade,
	type PathMove,
	type TruthSpan,
} from "#tools/eval-harness/grammar/census"
import {
	decoderInput,
	hitWindows,
	jointDecode,
	keepEdge,
	runPairPrior,
	shiftEmissions,
	strandedDependentLocality,
	WORD_CONTENT,
	type FiredWindows,
	type Matrix,
} from "#tools/eval-harness/grammar/census/pair-arms"
import {
	EvidenceCounter,
	postalVerdict,
	readPostalPlaces,
	wofChildLocations,
	type EvidenceTally,
	type PostalVerdict,
} from "#tools/eval-harness/grammar/census/postal-evidence"
import { readDecodeCensusRows, truthInText } from "#tools/eval-harness/grammar/census/rows"

const JOINT_BONUSES = [5, 10, 15, 20] as const

/**
 * The inventory keeps up to 40 postal pairs per country as a sample to read.
 */
const POSTAL_SAMPLE_SIZE = 40

const { values } = parseArguments({
	options: {
		heldout: { type: "string", multiple: true },
		inputs: { type: "string" },
		country: { type: "string", multiple: true },
		"out-dir": { type: "string" },
		limit: { type: "string" },
		"postal-dir": { type: "string" },
		"wof-db": { type: "string" },
		"inventory-only": { type: "boolean" },
	},
})

const outDir = values["out-dir"] ?? "/mnt/mw/audits/pair-prior-census"
const limit = values.limit ? Number(values.limit) : Number.POSITIVE_INFINITY
const postalDir = values["postal-dir"] ?? dataRootPath("geonames-postal").toString()

// ─── Inventory ─────────────────────────────────────────────────────────────

interface IndexInventory extends EvidenceTally {
	country: string
	path: string
	header: { delta: number; transitionBeta: number | null; parentDelta: number | null; buildDate: string }
	parents: number
	postalSource: { artifact: string; rows: number }
	/**
	 * Keyed `<child tag> → <parent tag>`.
	 */
	edges: Record<string, EvidenceTally>
	probes: Record<string, Array<{ parent: string; edge: string; postal: PostalVerdict }>>
	postalSamples: string[]
}

/**
 * Each pair index country's verdicts, keyed `child\0parent` as the index stores them.
 */
const verdictsByCountry = new Map<string, Map<string, PostalVerdict>>()

const PROBE_CHILDREN = ["brooklyn", "queens", "astoria", "park slope", "kensington", "camden", "shibuya", "montmartre"]

async function pairIndexPaths(): Promise<string[]> {
	const paths = new Set<string>()

	for (const locale of new Set(["en-US", ...Object.values(OVERLAY_LOCALE_BY_COUNTRY)])) {
		const resolved = await resolveWeights({ locale })

		if (resolved.pairIndexPath) {
			paths.add(resolved.pairIndexPath.toString())
		}
	}

	return [...paths]
}

async function inventory(): Promise<IndexInventory[]> {
	const out: IndexInventory[] = []

	using wof = new DatabaseClient<WOFDatabase>(
		values["wof-db"] ?? wofDatabasePath("admin-global-priority.db").toString(),
		{ readOnly: true }
	)

	for (const path of await pairIndexPaths()) {
		const index = new PairIndexResolver(new Uint8Array(await readLocalBuffer(path)))
		const postal = await readPostalPlaces(postalDir, index.country)
		const locations = wofChildLocations(wof, index.country)
		const verdicts = new Map<string, PostalVerdict>()
		const total = new EvidenceCounter()
		const edges = new Map<string, EvidenceCounter>()
		const parents = new Set<string>()
		const probes: IndexInventory["probes"] = {}
		const postalSamples: string[] = []

		for (const entry of index.entries()) {
			parents.add(entry.parent)
			const key = `${entry.tag} → ${entry.parentTag}`
			const verdict = postalVerdict(postal, locations, entry.child, entry.parent)

			verdicts.set(`${entry.child}\0${entry.parent}`, verdict)
			total.add(entry.child, verdict)

			if (!edges.has(key)) {
				edges.set(key, new EvidenceCounter())
			}

			edges.get(key)!.add(entry.child, verdict)

			if (verdict.postal && postalSamples.length < POSTAL_SAMPLE_SIZE) {
				postalSamples.push(`${entry.child} / ${entry.parent}`)
			}

			if (PROBE_CHILDREN.includes(entry.child)) {
				;(probes[entry.child] ??= []).push({ parent: entry.parent, edge: key, postal: verdict })
			}
		}

		verdictsByCountry.set(index.country, verdicts)

		out.push({
			country: index.country,
			path,
			header: {
				delta: index.delta,
				transitionBeta: index.transitionBeta,
				parentDelta: index.parentDelta,
				buildDate: index.header.buildDate,
			},
			...total.tally(),
			parents: parents.size,
			postalSource: { artifact: postal.artifact, rows: postal.rows },
			edges: Object.fromEntries([...edges].map(([key, counter]) => [key, counter.tally()])),
			probes,
			postalSamples,
		})
	}

	return out.toSorted((a, b) => a.country.localeCompare(b.country))
}

const percent = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a")

function evidenceLine(name: string, tally: EvidenceTally): string {
	return [
		name.padEnd(40),
		`pairs ${tally.pairs}`,
		`children ${tally.children}`,
		`loose-children ${percent(tally.childrenLoose, tally.children)}`,
		`scoped-pairs ${percent(tally.pairsScoped, tally.pairs)}`,
		`located ${percent(tally.pairsLocated, tally.pairs)}`,
		`at-location ${tally.pairsAtLocation} (${percent(tally.pairsAtLocation, tally.pairsLocated)} of located)`,
		`parent-at-location ${percent(tally.pairsParentAtLocation, tally.pairsLocated)} of located`,
		`postal ${tally.pairsPostal} (${percent(tally.pairsPostal, tally.pairs)})`,
	].join("  ")
}

const inventoryReport = await inventory()

await writeLocalJSONFile(inventoryReport, `${outDir}/inventory.json`)

for (const index of inventoryReport) {
	console.log(evidenceLine(`${index.country} (all)`, index))

	for (const [key, edge] of Object.entries(index.edges)) {
		console.log(evidenceLine(`${index.country}   ${key}`, edge))
	}
}

if (values["inventory-only"]) {
	process.exit(0)
}

// ─── Parse census ──────────────────────────────────────────────────────────

interface FiredEdge extends FiredWindows {
	child: string
	parent: string
	postal: PostalVerdict
}

interface ArmTally extends MoveTally {
	/**
	 * The same tallies over pieces with word content.
	 */
	word: MoveTally
	stranded: number
}

interface MoveTally {
	rowsChanged: number
	rowsImproved: number
	rowsRegressed: number
	gained: number
	lost: number
}

const emptyMoves = (): MoveTally => ({ rowsChanged: 0, rowsImproved: 0, rowsRegressed: 0, gained: 0, lost: 0 })

function addMove(tally: MoveTally, move: PathMove): void {
	tally.rowsChanged++
	tally.gained += move.gained
	tally.lost += move.lost

	if (move.gained > move.lost) {
		tally.rowsImproved++
	}

	if (move.lost > move.gained) {
		tally.rowsRegressed++
	}
}

interface CountryTally {
	rows: number
	rowsWithIndex: number
	rowsFired: number
	selfCheckFailures: number
	edges: number
	edgesLoose: number
	edgesScoped: number
	edgesPostal: number
	rowsWithFlip: number
	flips: number
	flipGrades: Record<"postal" | "nonPostal", Record<FlipGrade, number>>
	/**
	 * Keyed `<postal|nonPostal> <edge>: truth <child truth> / <parent truth>`
	 * over every fired edge with located truth.
	 */
	answerKey: Record<string, number>
	baseStranded: number
	arms: Record<string, ArmTally>
}

const ARM_KEYS = [
	"none",
	"dropPostal",
	"retag",
	"words",
	"retagWords",
	...JOINT_BONUSES.flatMap((j) => [`joint@${j}`, `jointDropPostal@${j}`, `jointRetag@${j}`]),
]

/**
 * Drops an edge whose child is postal at its location.
 *
 * It reads a dependent-locality parent that's postal at its own location as the locality.
 */
function retagEdge(verdict: PostalVerdict, edge: PairEdge): PairEdge | null {
	if (verdict.postal) return null

	return verdict.parentAtLocation && edge.parentTag === "dependent_locality"
		? { tag: edge.tag, parentTag: "locality" }
		: edge
}

function emptyTally(): CountryTally {
	return {
		rows: 0,
		rowsWithIndex: 0,
		rowsFired: 0,
		selfCheckFailures: 0,
		edges: 0,
		edgesLoose: 0,
		edgesScoped: 0,
		edgesPostal: 0,
		rowsWithFlip: 0,
		flips: 0,
		flipGrades: { postal: emptyFlipGrades(), nonPostal: emptyFlipGrades() },
		answerKey: {},
		baseStranded: 0,
		arms: Object.fromEntries(ARM_KEYS.map((key) => [key, { ...emptyMoves(), word: emptyMoves(), stranded: 0 }])),
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

function windowTruth(
	trace: NeuralParseTrace,
	truth: { spans: TruthSpan[]; complete: boolean },
	pieces: readonly number[]
): string | null {
	if (!pieces.length) return null

	const start = trace.pieces[pieces[0]!]!.start
	const end = trace.pieces[pieces.at(-1)!]!.end

	return truthTagForRange(truth.spans, start, end, truth.complete)
}

interface RowReceipt {
	collection: string
	id: string
	input: string
	country: string | null
	indexCountry: string
	edges: Array<
		Omit<FiredEdge, "childPieces" | "parentPieces"> & {
			/**
			 * The pieces of each window, as the tokenizer wrote them.
			 */
			childPieces: string[]
			parentPieces: string[]
			childTruth: string | null
			parentTruth: string | null
		}
	>
	flips: Array<{
		text: string
		withPrior: string
		withoutPrior: string
		truth: string | null
		grade: FlipGrade
		postal: boolean
	}>
	baseStranded: boolean
	arms: Record<
		string,
		{
			changed: Array<{ text: string; from: string; to: string; truth: string | null }>
			gained: number
			lost: number
			wordGained: number
			wordLost: number
			stranded: boolean
		}
	>
}

const receipts: RowReceipt[] = []
const countryFilter = values.country?.length ? new Set(values.country.map((code) => code.toUpperCase())) : null
const runLabel = values.inputs ? "inputs" : values.heldout?.length ? "heldout" : "board"
const startedAt = Date.now()
let processed = 0

async function checkpoint(final: boolean): Promise<void> {
	await writeLocalJSONFile(
		{
			label: runLabel,
			final,
			processed,
			jointBonuses: JOINT_BONUSES,
			seconds: Math.round((Date.now() - startedAt) / 1000),
			tallies: Object.fromEntries(tallies),
		},
		`${outDir}/${runLabel}-summary.json`
	)

	await writeLocalJSONLFile(receipts, `${outDir}/${runLabel}-rows.jsonl`)
}

const tagsOf = (path: readonly number[], labels: readonly string[]): string[] => path.map((i) => labels[i] ?? "O")

using deps = await buildGauntletDeps()

for await (const row of readDecodeCensusRows({
	...(values.heldout ? { heldout: values.heldout } : {}),
	...(values.inputs ? { inputs: values.inputs } : {}),
})) {
	if (processed >= limit) break

	if (countryFilter && !countryFilter.has(row.country?.toUpperCase() ?? "")) continue

	processed++
	const tally = tallyFor(row.collection, row.country)

	tally.rows++
	const { trace, classifier } = await deps.diagnoseParse(row.input, row.country ? { caseCountry: row.country } : {})
	const pairOpts = classifier.config.placetypePair

	if (processed % 2000 === 0) {
		console.error(`[pair-census] ${processed} rows, ${Math.round((Date.now() - startedAt) / 1000)}s`)

		await checkpoint(false)
	}

	if (!pairOpts || !trace.explanation || trace.decode !== "viterbi") continue

	tally.rowsWithIndex++
	const ledger = trace.explanation.ledger.find((entry) => entry.prior === "placetypePair")

	if (!ledger) continue

	tally.rowsFired++

	const indexCountry = pairOpts.index.country ?? ""
	const verdicts = verdictsByCountry.get(indexCountry)

	if (!verdicts) throw new Error(`pair-census: the inventory read no pair index for country "${indexCountry}"`)

	const verdictOf = (child: string, parent: string): PostalVerdict => {
		const verdict = verdicts.get(`${child}\0${parent}`)

		if (!verdict) {
			throw new Error(`pair-census: ${indexCountry} pair "${child}" / "${parent}" fired but the inventory lacks it`)
		}

		return verdict
	}

	const full = runPairPrior(classifier, trace, keepEdge)!
	const decoder = decoderInput(classifier, trace.labels)

	const decode = (emissions: Matrix, adjustments: ViterbiTransitionAdjustment[] | null): number[] =>
		viterbi({ emissions, ...decoder, ...(adjustments?.length ? { transitionAdjustments: adjustments } : {}) }).path

	// Self-check: the recomposed prior must be the ledger's, and re-decoding must give the decoder's path.
	const ledgerCells = new Map(ledger.cells.map((cell) => [`${cell.piece}:${cell.label}`, cell.delta]))
	let cellsMatch = true

	full.matrix.forEach((cells, t) =>
		cells.forEach((delta, k) => {
			if (delta !== 0 && ledgerCells.get(`${t}:${trace.labels[k]}`) !== delta) {
				cellsMatch = false
			}
		})
	)

	const fullCells = full.matrix.flat().filter((delta) => delta !== 0).length
	const basePath = decode(trace.emissions, full.adjustments)

	if (!cellsMatch || fullCells !== ledger.cells.length || basePath.some((index, t) => index !== trace.path[t])) {
		tally.selfCheckFailures++

		continue
	}

	const edges: FiredEdge[] = full.hits.map((hit) => ({
		child: hit.child,
		parent: hit.parent,
		tag: hit.edge.tag,
		parentTag: hit.edge.parentTag,
		...hitWindows(classifier, trace, hit),
		postal: verdictOf(hit.child, hit.parent),
	}))

	const truth = truthInText(row, trace.text)
	const pieceTruth = pieceTruthTags(trace.pieces, trace.text, truth.spans, truth.complete)
	// The word grade leaves out separator pieces.
	// The prior's segment windows also bias them.
	const wordPieces = trace.pieces.map((piece) => WORD_CONTENT.test(piece.piece))
	const wordTruth = pieceTruth.map((tag, piece) => (wordPieces[piece] ? tag : null))

	const wordsOnly = (matrix: Matrix): Matrix =>
		matrix.map((cells, piece) => (wordPieces[piece] ? cells : cells.map(() => 0)))

	const baseTags = tagsOf(basePath, trace.labels)

	tally.edges += edges.length
	tally.edgesLoose += edges.filter((edge) => edge.postal.loose).length
	tally.edgesScoped += edges.filter((edge) => edge.postal.scoped).length
	tally.edgesPostal += edges.filter((edge) => edge.postal.postal).length

	const pieceText = (pieces: readonly number[]) => pieces.map((piece) => trace.pieces[piece]!.piece)

	const edgeReceipts = edges.map(({ childPieces, parentPieces, ...edge }) => {
		const childTruth = windowTruth(trace, truth, childPieces)
		const parentTruth = windowTruth(trace, truth, parentPieces)

		if (childTruth !== null || parentTruth !== null) {
			const kind = edge.postal.postal ? "postal" : "nonPostal"
			const key = `${kind} ${edge.tag}→${edge.parentTag}: truth ${childTruth ?? "?"} / ${parentTruth ?? "?"}`

			tally.answerKey[key] = (tally.answerKey[key] ?? 0) + 1
		}

		return {
			...edge,
			childPieces: pieceText(childPieces),
			parentPieces: pieceText(parentPieces),
			childTruth,
			parentTruth,
		}
	})

	const postalPieces = new Set(
		edges.filter((edge) => edge.postal.postal).flatMap((edge) => [...edge.childPieces, ...edge.parentPieces])
	)

	const flips = (priorFlipSpans(trace.explanation, "placetypePair") ?? []).map((flip) => {
		const start = trace.pieces[flip.startPiece]!.start
		const end = trace.pieces[flip.endPiece - 1]!.end
		const truthTag = truthTagForRange(truth.spans, start, end, truth.complete)
		const pieces = Array.from({ length: flip.endPiece - flip.startPiece }, (_, i) => flip.startPiece + i)

		return {
			text: trace.text.slice(start, end),
			withPrior: flip.withPrior,
			withoutPrior: flip.withoutPrior,
			truth: truthTag,
			grade: gradeFlip(flip.withPrior, flip.withoutPrior, truthTag),
			postal: pieces.some((piece) => postalPieces.has(piece)),
		}
	})

	if (flips.length) {
		tally.rowsWithFlip++
	}

	for (const flip of flips) {
		tally.flips++

		tally.flipGrades[flip.postal ? "postal" : "nonPostal"][flip.grade]++
	}

	const baseStranded = strandedDependentLocality(baseTags)

	if (baseStranded) {
		tally.baseStranded++
	}

	// The arms.
	const without = shiftEmissions(trace.emissions, full.matrix, null)

	const dropped = runPairPrior(classifier, trace, (child, parent, edge) =>
		verdictOf(child, parent).postal ? null : edge
	)!

	const kept = edges.filter((edge) => !edge.postal.postal)
	const retagged = runPairPrior(classifier, trace, (child, parent, edge) => retagEdge(verdictOf(child, parent), edge))!

	const retaggedEdges = kept.map((edge) => ({
		...edge,
		parentTag: retagEdge(edge.postal, { tag: edge.tag, parentTag: edge.parentTag })!.parentTag,
	}))

	const armPaths: Record<string, number[]> = {
		none: decode(without, null),
		dropPostal: decode(shiftEmissions(without, null, dropped.matrix), dropped.adjustments),
		retag: decode(shiftEmissions(without, null, retagged.matrix), retagged.adjustments),
		words: decode(shiftEmissions(without, null, wordsOnly(full.matrix)), full.adjustments),
		retagWords: decode(shiftEmissions(without, null, wordsOnly(retagged.matrix)), retagged.adjustments),
	}

	for (const bonus of JOINT_BONUSES) {
		armPaths[`joint@${bonus}`] = jointDecode(without, decoder, trace.labels, edges, bonus)
		armPaths[`jointDropPostal@${bonus}`] = jointDecode(without, decoder, trace.labels, kept, bonus)
		armPaths[`jointRetag@${bonus}`] = jointDecode(without, decoder, trace.labels, retaggedEdges, bonus)
	}

	const armReceipts: RowReceipt["arms"] = {}

	for (const [key, path] of Object.entries(armPaths)) {
		const tags = tagsOf(path, trace.labels)
		const move = comparePaths(baseTags, tags, pieceTruth)
		const words = comparePaths(baseTags, tags, wordTruth)
		const arm = tally.arms[key]!
		const stranded = strandedDependentLocality(tags)

		if (stranded) {
			arm.stranded++
		}

		if (!move.changedPieces.length) continue

		addMove(arm, move)

		if (words.changedPieces.some((piece) => wordPieces[piece])) {
			addMove(arm.word, words)
		}

		armReceipts[key] = {
			changed: move.changedPieces.map((piece) => ({
				text: trace.text.slice(trace.pieces[piece]!.start, trace.pieces[piece]!.end),
				from: baseTags[piece]!,
				to: tags[piece]!,
				truth: pieceTruth[piece] ?? null,
			})),
			gained: move.gained,
			lost: move.lost,
			wordGained: words.gained,
			wordLost: words.lost,
			stranded,
		}
	}

	receipts.push({
		collection: row.collection,
		id: row.id,
		input: row.input,
		country: row.country,
		indexCountry,
		edges: edgeReceipts,
		flips,
		baseStranded,
		arms: armReceipts,
	})
}

await checkpoint(true)

console.error(`[pair-census] done: ${processed} rows in ${Math.round((Date.now() - startedAt) / 1000)}s`)
