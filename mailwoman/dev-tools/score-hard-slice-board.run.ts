/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Score the HARD-SLICE BOARD (ROAD_TO_V9 §3) across the three FST arms and report whether they
 *   SEPARATE. This is the board's own acceptance test: "an unmeasurable change is an unshippable
 *   change" (§2 R3), so the first thing this runner has to establish is that the instrument moves at all.
 *
 *   THE ARMS. All three share one model, one resolver, one board — the ONLY variable is the gazetteer
 *   binary feeding `neural/fst-prior.ts`:
 *
 *   - `none` — `fst: false`, which suppresses BOTH an explicit matcher and the pipeline's auto-load.
 *   - `pop` — `$MAILWOMAN_DATA_ROOT/wof/fst-per-locale/` — the shipped set. Its source DB has no
 *       `place_importance` table, so `fst-builder.ts` took the documented population fallback
 *       (`min(1, log2(1+pop/1000)/14)`). Verified from the artifact's own stamp: `importanceMatches`
 *       743,268 against `admin-global-priority.db`.
 *   - `imp` — `wof/fst-staging-2026-08-05-importance-fanoutfix/` — built from
 *       `admin-global-priority-importance.db`, `importanceMatches` 1,543,753, which is EXACTLY that DB's
 *       `place_importance` row count. So this arm carries the real Wikipedia-joined score.
 *   - `ref` — `wof/fst-staging-2026-08-06-two-score-split/` — the SAME source database as `imp`, rebuilt
 *       at FST format v5 under the ratified §2 policy: the bias reads the REFERENTIAL score
 *       (population-anchored) and the encyclopedic score rides along in its own slot, unread by the
 *       decoder. `imp` vs `ref` is therefore the policy ablation with the source database held fixed —
 *       the single-variable comparison that says what ranking referentially costs or buys. `pop` vs `ref`
 *       is NOT single-variable: their source databases differ (2026-08-04 admin vs the 2026-08-05
 *       importance build), so a delta there mixes the policy with a gazetteer generation.
 *
 *   The two binaries are otherwise identical builds — same `stateCount` (160,246), `placeCount`
 *   (236,257), `nameInsertions` (274,245), same exclusion policy. The trie is the same trie; only the
 *   importance floats differ. That is what makes this a single-variable ablation rather than a build diff.
 *
 *   WHY THIS RUNNER EXISTS AT ALL — the FST's reach is narrower than it looks. `eval oa-resolver`
 *   without `--assembled`, and `eval gauntlet` in every mode, grade through `geocode-core.ts`'s
 *   `parseForGeocode`, which calls `classifier.parse` with NO `fst` key. The gazetteer prior is
 *   therefore not merely weak on those paths — it is never constructed. `createRuntimePipeline` is the
 *   only entry point that wires `opts.fst`, so this runner drives the pipeline directly. A board scored
 *   through `geocodeAddress` would tie across all three arms no matter what the board contained.
 *
 *   GRADING. Per row, both halves are reported because they fail differently:
 *
 *   1. `coord` — the resolved most-specific point within the row's DECLARED tolerance. A row with no
 *        coordinate is not graded here and is not counted as a miss; absence is absence.
 *   2. `place` — `expectPlaceID` / `expectPlaceName` when asserted. ROAD_TO_V9 §6 I2 records that the
 *        gauntlet stores these and never checks them; this board checks them, so a right-coordinate /
 *        wrong-place answer (a namesake landing inside a metro tolerance) is visible rather than credited.
 *
 *   Usage: node mailwoman/dev-tools/score-hard-slice-board.run.ts [--arms none,pop,imp] [--out-json <p>]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { dataRootPath, wofShardPaths } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import { haversineKm } from "@mailwoman/spatial"
import { createRuntimePipeline } from "mailwoman"

import { type HardSliceCase, loadHardSliceBoard } from "../eval-harness/hard-slice-board.ts"
import { createResolverBackend } from "../resolver-backend.ts"

const { values } = parseArgs({
	options: {
		arms: { type: "string", default: "none,pop,imp" },
		board: { type: "string" },
		"out-json": { type: "string" },
		/**
		 * Per-row outcome dump — the raw material for the flip inventory.
		 */
		"out-rows": { type: "string" },
	},
})

const ARM_DIRS: Record<string, string | null> = {
	none: null,
	pop: String(dataRootPath("wof", "fst-per-locale")),
	imp: String(dataRootPath("wof", "fst-staging-2026-08-05-importance-fanoutfix")),
	ref: String(dataRootPath("wof", "fst-staging-2026-08-06-two-score-split")),
}

const arms = values.arms!.split(",").map((a) => a.trim())

for (const arm of arms) {
	if (!(arm in ARM_DIRS)) throw new Error(`unknown arm "${arm}" — known: ${Object.keys(ARM_DIRS).join(", ")}`)
}

const board = await loadHardSliceBoard(values.board)
const locales = [...new Set(board.map((c) => c.locale))].toSorted()

console.error(`[board] ${board.length} rows, locales=[${locales.join(", ")}]`)

//#region Resolver + pipelines

const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
const wofPaths = wofShardPaths().filter(existsSync)

if (!wofPaths.length)
	throw new Error("no WOF shards found — this board grades the RESOLVED place, so it needs the gazetteer")

const resolver = createWOFResolver(createResolverBackend(resolverMod, { wofPaths }) as never)

const classifiers = new Map<string, Awaited<ReturnType<typeof NeuralAddressClassifier.loadFromWeights>>>()

for (const locale of locales) {
	classifiers.set(locale, await NeuralAddressClassifier.loadFromWeights({ locale }))
}

/**
 * `arm → locale → pipeline`. The FST is chosen per (arm, locale) because `fst-<locale>.bin` is country-scoped; a locale
 * with no binary in an arm's dir gets `false`, which is the SAME state as the `none` arm for that locale — recorded
 * rather than papered over, since it is why an out-of-reach row cannot discriminate.
 */
const pipelines = new Map<string, Map<string, ReturnType<typeof createRuntimePipeline>>>()

for (const arm of arms) {
	const byLocale = new Map<string, ReturnType<typeof createRuntimePipeline>>()
	const dir = ARM_DIRS[arm]

	for (const locale of locales) {
		const binPath = dir ? `${dir}/fst-${locale}.bin` : undefined
		const fst = binPath && existsSync(binPath) ? deserializeFST(readFileSync(binPath)) : false

		if (dir && !fst) {
			console.error(`[arm ${arm}] ${locale}: NO fst-${locale}.bin in ${dir} — this locale runs FST-free in this arm`)
		}

		byLocale.set(
			locale,
			createRuntimePipeline({
				classifier: classifiers.get(locale)! as never,
				resolver: resolver as never,
				fst: fst as never,
			})
		)
	}

	pipelines.set(arm, byLocale)
}

//#endregion

//#region Scoring

const PLACETYPE_RANK: Record<string, number> = {
	postalcode: 6,
	locality: 5,
	localadmin: 4,
	borough: 4,
	county: 3,
	region: 2,
	country: 0,
}

interface Resolved {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
}

/**
 * Every resolved node in the tree, including the multi-role INTERPRETATIONS a dual-role place carries on the same node
 * (#415/#416) — mirrors `oa-resolver-eval.ts`'s `collectResolved` so the two evals agree about what "the resolver
 * answered" means.
 */
function collectResolved(tree: AddressTree): Resolved[] {
	const out: Resolved[] = []

	const visit = (n: AddressNode): void => {
		const meta = n.metadata as Record<string, unknown> | undefined

		if (n.placeID?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			out.push({
				id: Number(n.placeID.slice(4)),
				name: String(meta?.["resolver_name"] ?? n.value ?? ""),
				placetype: String(n.sourceID ?? "").split(":")[0] ?? "",
				lat: n.lat,
				lon: n.lon,
			})
		}

		for (const interp of (n.interpretations ?? []) as ReadonlyArray<{
			tag: string
			placeID?: string
			sourceID?: string
			lat?: number
			lon?: number
			metadata?: Record<string, unknown>
		}>) {
			if (interp.placeID?.startsWith("wof:") && interp.lat !== undefined && interp.lon !== undefined) {
				out.push({
					id: Number(interp.placeID.slice(4)),
					name: String(interp.metadata?.["resolver_name"] ?? n.value ?? ""),
					placetype: String(interp.sourceID ?? interp.tag).split(":")[0] ?? "",
					lat: interp.lat,
					lon: interp.lon,
				})
			}
		}

		for (const child of n.children ?? []) {
			visit(child)
		}
	}

	for (const root of tree.roots) {
		visit(root)
	}

	return out
}

function mostSpecific(rs: Resolved[]): Resolved | null {
	let best: Resolved | null = null

	for (const r of rs) {
		if (!best || (PLACETYPE_RANK[r.placetype] ?? -1) > (PLACETYPE_RANK[best.placetype] ?? -1)) {
			best = r
		}
	}

	return best
}

interface Outcome {
	/**
	 * Coordinate within the declared tolerance. `null` = the row asserts no coordinate.
	 */
	coordOK: boolean | null
	/**
	 * `expectPlaceID`/`expectPlaceName` matched. `null` = not asserted.
	 */
	placeOK: boolean | null
	/**
	 * Great-circle error (km), or `null` when nothing resolved / nothing asserted.
	 */
	errKm: number | null
	resolvedID: number | null
	resolvedName: string | null
	/**
	 * The row's verdict — `coordOK` when asserted, else `placeOK`. Used for the flip inventory.
	 */
	pass: boolean
}

const norm = (s: string): string =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replaceAll(/[̀-ͯ]/gu, "")
		.trim()

function score(c: HardSliceCase, resolved: Resolved[]): Outcome {
	const best = mostSpecific(resolved)

	const errKm =
		best && c.expectLat !== undefined && c.expectLon !== undefined
			? haversineKm(best.lat, best.lon, c.expectLat, c.expectLon)
			: null

	const coordOK =
		c.expectLat === undefined || c.expectToleranceM === undefined
			? null
			: errKm !== null && errKm <= c.expectToleranceM / 1000

	// §6 I2: the gauntlet stores these and never checks them. Checked here, against ANY resolved node —
	// the expected place may be an ancestor of the most-specific answer (a locality row whose tree also
	// resolved a region), so requiring it at `best` would fail rows that are in fact correct.
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

//#endregion

//#region Run

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
			const { tree } = await pipeline(c.input, { locale: c.locale } as never)
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

//#endregion

//#region Report

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`)

function tally(rows: RowResult[], arm: string): { pass: number; total: number } {
	return { pass: rows.filter((r) => r.byArm[arm]!.pass).length, total: rows.length }
}

console.log(`\n## Hard-slice board — three-arm FST comparison\n`)
console.log(`Board: ${board.length} rows · arms: ${arms.join(" / ")}\n`)

// Overall + per-class.
const classes = [...new Set(results.map((r) => r.class))].toSorted()
const header = ["class", "n", ...arms, `Δ ${arms.at(-1)}−${arms[1] ?? arms[0]}`]

console.log(`| ${header.join(" | ")} |`)
console.log(`| ${header.map(() => "---").join(" | ")} |`)

const emitRow = (label: string, rows: RowResult[]): void => {
	const cells = arms.map((a) => {
		const t = tally(rows, a)

		return `${t.pass}/${t.total} (${pct(t.pass, t.total)})`
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

// Discrimination verdict — the board's own acceptance test.
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

// Flip inventory for the §2 decision — the measured Saint-Denis-class census.
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
	writeFileSync(values["out-json"], `${JSON.stringify({ board: board.length, arms, results }, null, 2)}\n`)

	console.error(`[out] ${values["out-json"]}`)
}

if (values["out-rows"]) {
	writeFileSync(values["out-rows"], `${results.map((r) => JSON.stringify(r)).join("\n")}\n`)

	console.error(`[out] ${values["out-rows"]}`)
}

if (anyTie) {
	console.log(
		`\n> At least one arm pair produced an IDENTICAL verdict vector. Per §3 that is a finding about the FST's reach, not a reason to grow the board — localize where the bias is being ignored before adding rows.`
	)
}

//#endregion
