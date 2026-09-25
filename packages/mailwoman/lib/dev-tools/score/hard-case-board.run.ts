/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Compares FST arms on the hard-case board through the runtime pipeline, holding the model and resolver fixed.
 */

import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { haversineKm } from "@mailwoman/spatial"
import type { PathBuilder } from "path-ts"

import { type HardCase, loadHardCaseBoard } from "#eval-harness/hard-case-board"
import { collectResolved, mostSpecific, type Resolved } from "#eval-harness/oa/resolver/tree-hits"
import { createRuntimePipeline } from "#index"
import { createResolverBackend, existingWOFDatabasePaths } from "#resolver-backend"

const { values } = parseArguments({
	options: {
		arms: { type: "string", default: "none,pop,imp" },
		board: { type: "string" },
		"out-json": { type: "string" },
		/**
		 * Writes each row's outcomes as JSON lines to this path.
		 */
		"out-rows": { type: "string" },
	},
})

const ARM_DIRS: Record<string, PathBuilder | null> = {
	none: null,
	pop: wofDatabasePath("fst-per-locale"),
	imp: wofDatabasePath("fst-staging-2026-08-05-importance-fanoutfix"),
	ref: wofDatabasePath("fst-staging-2026-08-06-two-score-split"),
}

const arms = values.arms!.split(",").map((a) => a.trim())

for (const arm of arms) {
	if (!(arm in ARM_DIRS)) throw new Error(`unknown arm "${arm}" — known: ${Object.keys(ARM_DIRS).join(", ")}`)
}

const board = await loadHardCaseBoard(values.board)
const locales = [...new Set(board.map((c) => c.locale))].toSorted()

console.error(`[board] ${board.length} rows, locales=[${locales.join(", ")}]`)

// #region Resolver + pipelines

const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
const wofPaths = await existingWOFDatabasePaths()

if (!wofPaths.length)
	throw new Error("no WOF databases found — this board grades the RESOLVED place, so it needs the gazetteer")

const resolver = createWOFResolver(await createResolverBackend(resolverMod, { wofPaths }))

const classifiers = new Map<string, Awaited<ReturnType<typeof NeuralAddressClassifier.loadFromWeights>>>()

for (const locale of locales) {
	classifiers.set(locale, await NeuralAddressClassifier.loadFromWeights({ locale }))
}

/**
 * Holds one pipeline per arm and locale.
 *
 * When an arm has no FST file for a locale, that pair runs without the FST prior.
 */
const pipelines = new Map<string, Map<string, ReturnType<typeof createRuntimePipeline>>>()

for (const arm of arms) {
	const byLocale = new Map<string, ReturnType<typeof createRuntimePipeline>>()
	const dir = ARM_DIRS[arm]

	for (const locale of locales) {
		const binPath = dir ? dir(`fst-${locale}.bin`) : undefined
		const fst = binPath && (await pathExists(binPath)) ? deserializeFST(await readLocalBuffer(binPath)) : false

		if (dir && !fst) {
			console.error(`[arm ${arm}] ${locale}: NO fst-${locale}.bin in ${dir} — this locale runs FST-free in this arm`)
		}

		byLocale.set(
			locale,
			createRuntimePipeline({
				classifier: classifiers.get(locale)!,
				resolver,
				fst,
			})
		)
	}

	pipelines.set(arm, byLocale)
}

// #endregion

// #region Scoring

/**
 * Holds one row's outcome under one arm.
 */
interface Outcome {
	/**
	 * Reports whether the coordinate is within tolerance, or `null` when the row asserts no coordinate.
	 */
	coordOK: boolean | null
	/**
	 * Reports whether `expectPlaceID` or `expectPlaceName` matched, or `null` when the row asserts neither.
	 */
	placeOK: boolean | null
	/**
	 * Holds the great-circle error in kilometers, or `null` when nothing resolved
	 * or no coordinate is asserted.
	 */
	errKm: number | null
	resolvedID: number | null
	resolvedName: string | null
	/**
	 * Holds the verdict, which is `coordOK` when asserted and `placeOK` otherwise.
	 */
	pass: boolean
}

// This matches the board's place-name grading, which folds case and compatibility forms and strips accents.
const norm = (s: string): string =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replaceAll(/[̀-ͯ]/gu, "")
		.trim()

function score(c: HardCase, resolved: Resolved[]): Outcome {
	const best = mostSpecific(resolved)

	const errKm =
		best && c.expectLat !== undefined && c.expectLon !== undefined
			? haversineKm(best.lat, best.lon, c.expectLat, c.expectLon)
			: null

	const coordOK =
		c.expectLat === undefined || c.expectToleranceM === undefined
			? null
			: errKm !== null && errKm <= c.expectToleranceM / 1000

	// The expected place can be an ancestor of the most specific result, so every resolved node is checked.
	let placeOK: boolean | null = null

	if (c.expectPlaceID !== undefined) {
		const want = Number(c.expectPlaceID.replace(/^wof:/u, ""))
		placeOK = resolved.some((r) => r.id === want)
	} else if (c.expectPlaceName !== undefined) {
		const want = norm(c.expectPlaceName)
		placeOK = resolved.some((r) => norm(r.name) === want)
	}

	return {
		coordOK,
		placeOK,
		errKm,
		resolvedID: best?.id ?? null,
		resolvedName: best?.name ?? null,
		pass: coordOK ?? placeOK ?? false,
	}
}

// #endregion

// #region Run

/**
 * Holds one board row and its outcome under each arm.
 */
interface RowResult {
	id: string
	class: string
	fstReach: string
	locale: string
	input: string
	popBias: number
	impBias: number
	byArm: Record<string, Outcome>
}

const results: RowResult[] = []

for (const c of board) {
	const byArm: Record<string, Outcome> = {}

	for (const arm of arms) {
		const pipeline = pipelines.get(arm)!.get(c.locale)!

		try {
			const { tree } = await pipeline(c.input, { locale: c.locale })
			byArm[arm] = score(c, collectResolved(tree))
		} catch (error) {
			console.error(`[${arm}] ${c.id} threw: ${(error as Error).message}`)

			byArm[arm] = { coordOK: false, placeOK: null, errKm: null, resolvedID: null, resolvedName: null, pass: false }
		}
	}

	results.push({
		id: c.id,
		class: c.class,
		fstReach: c.fstReach,
		locale: c.locale,
		input: c.input,
		popBias: c.popBias,
		impBias: c.impBias,
		byArm,
	})
}

// #endregion

// #region Report

function tally(rows: RowResult[], arm: string): { pass: number; total: number } {
	return { pass: rows.filter((r) => r.byArm[arm]!.pass).length, total: rows.length }
}

console.log(`\n## Hard-case board — three-arm FST comparison\n`)
console.log(`Board: ${board.length} rows · arms: ${arms.join(" / ")}\n`)

const classes = [...new Set(results.map((r) => r.class))].toSorted()
const header = ["class", "n", ...arms, `Δ ${arms.at(-1)}−${arms[1] ?? arms[0]}`]

console.log(`| ${header.join(" | ")} |`)
console.log(`| ${header.map(() => "---").join(" | ")} |`)

const emitRow = (label: string, rows: RowResult[]): void => {
	const cells = arms.map((a) => {
		const t = tally(rows, a)

		return `${t.pass}/${t.total} (${formatPercent(t.pass, t.total)})`
	})

	const base = arms.length > 1 ? tally(rows, arms[1]!).pass : 0
	const last = tally(rows, arms.at(-1)!).pass
	const delta = last - base

	console.log(`| ${label} | ${rows.length} | ${cells.join(" | ")} | ${delta > 0 ? "+" : ""}${delta} |`)
}

emitRow("**ALL**", results)

for (const cls of classes) {
	emitRow(
		cls,
		results.filter((r) => r.class === cls)
	)
}

emitRow(
	"_reach=in_",
	results.filter((r) => r.fstReach === "in")
)

emitRow(
	"_reach=out_",
	results.filter((r) => r.fstReach === "out")
)

// Two arms tie when their pass/fail vectors over every row are identical.
console.log(`\n### Discrimination\n`)

const signatures = new Map<string, string>()

for (const arm of arms) {
	signatures.set(arm, results.map((r) => (r.byArm[arm]!.pass ? "1" : "0")).join(""))
}

let anyTie = false

for (let i = 0; i < arms.length; i++) {
	for (let j = i + 1; j < arms.length; j++) {
		const a = arms[i]!
		const b = arms[j]!
		const differing = results.filter((r) => r.byArm[a]!.pass !== r.byArm[b]!.pass)
		const identical = signatures.get(a) === signatures.get(b)

		if (identical) {
			anyTie = true
		}

		console.log(
			`- \`${a}\` vs \`${b}\`: ${identical ? "**TIE — byte-identical verdict vector**" : `**SEPARATE** — ${differing.length} row(s) differ`}`
		)

		for (const r of differing) {
			const from = r.byArm[a]!.pass ? "PASS" : "fail"
			const to = r.byArm[b]!.pass ? "PASS" : "fail"

			console.log(
				`  - \`${r.id}\` (${r.class}, bias ${r.popBias}→${r.impBias}) ${from}→${to} · "${r.input}" · ${a}=${r.byArm[a]!.resolvedName ?? "∅"} ${b}=${r.byArm[b]!.resolvedName ?? "∅"}`
			)
		}
	}
}

if (arms.includes("pop") && arms.includes("imp")) {
	const gained = results.filter((r) => !r.byArm["pop"]!.pass && r.byArm["imp"]!.pass)
	const lost = results.filter((r) => r.byArm["pop"]!.pass && !r.byArm["imp"]!.pass)

	console.log(`\n### Flip inventory — real-importance vs population\n`)
	console.log(`- wrong→correct: **${gained.length}**`)

	for (const r of gained) {
		console.log(`  - \`${r.id}\` (${r.class}) "${r.input}" — bias ${r.popBias}→${r.impBias}`)
	}

	console.log(`- correct→wrong: **${lost.length}**`)

	for (const r of lost) {
		console.log(`  - \`${r.id}\` (${r.class}) "${r.input}" — bias ${r.popBias}→${r.impBias}`)
	}
}

if (values["out-json"]) {
	await writeLocalJSONFile({ board: board.length, arms, results }, values["out-json"])

	console.error(`[out] ${values["out-json"]}`)
}

if (values["out-rows"]) {
	await writeLocalTextFile(`${results.map((r) => stringifyJSON(r)).join("\n")}\n`, values["out-rows"])

	console.error(`[out] ${values["out-rows"]}`)
}

if (anyTie) {
	console.log(
		`\n> At least one arm pair produced an IDENTICAL verdict vector. Per §3 that is a finding about the FST's reach, not a reason to grow the board — localize where the bias is being ignored before adding rows.`
	)
}

// #endregion
