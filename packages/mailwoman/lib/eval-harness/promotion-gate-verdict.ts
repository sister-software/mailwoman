/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Verdict assembler for promotion-gate.ts (#479). Parses the battery outputs the runner teed into
 *   the out-dir, checks every number against the gate spec's floors, enforces the fp32↔int8 delta
 *   cap, and writes verdict.json. `failed: false` = all floors met.
 *
 *   Parsing contract: the scorers emit pipe-tables (`| tag | P | R | F1 |` from the affix scorers, `|
 *   tag | golden | … |` from per-locale-f1, the de-order summary line). If a harness output format
 *   changes, THIS file is the single place the check's parsing breaks — loudly (a floor whose number
 *   can't be found is a FAIL, never a skip).
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

/**
 * Options for {@linkcode assemblePromotionVerdict}.
 */
export interface PromotionVerdictOptions {
	/**
	 * Path to the gate spec JSON (already resolved to a real file).
	 */
	gate: string
	/**
	 * The promotion-gate out-dir carrying the battery outputs.
	 */
	outDir: PathBuilderLike
	/**
	 * Also collect the int8 battery and enforce the fp32↔int8 delta cap.
	 */
	withInt8?: boolean
	/**
	 * Overrides the derived label — pass `weights-cache` when the floors were read from a package-shaped cache.
	 */
	gradedArtifact?: "int8" | "fp32" | "weights-cache"
}

/**
 * Pull `| <tag> | … | <F1> |`-style F1 from an affix/country scorer table (P, R, F1 columns).
 */
function scorerF1(md: string, tag: string): number | undefined {
	const m = md.match(new RegExp(`\\|\\s*${tag}\\s*\\|\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*([\\d.]+)`))

	return m ? Number(m[1]) : undefined
}

/**
 * The cells of one pipe-table line, outer pipes dropped and each cell trimmed.
 */
function tableCells(line: string): string[] {
	return line
		.split("|")
		.slice(1, -1)
		.map((c) => c.trim())
}

/**
 * Read a named column for a named arena row from the arena summary pipe-table, by HEADER — never a fixed offset.
 *
 * The table shape is not stable across the arena's own history: before the #1151 rules-parser deletion the summary
 * carried the v0 comparison columns (`| arena | n | v0 | neural | both | … |`); after it, `summarize-arenas.ts` emits
 * the neural-only shape (`| arena | n | neural | fail | tree-valid |`). A fixed column offset silently reads the wrong
 * cell across that boundary — the pre-#1151 offset for `neural` lands on `fail` in the new table, turning an 80% neural
 * pass into a phantom 20% FAIL. Locating the column from the header row is robust to both shapes (and any future column
 * addition).
 */
export function arenaColumn(md: string, arena: string, column: string): number | undefined {
	const m = tableCell(md, /^\|\s*arena\s*\|/, column, arena)?.match(/([\d.]+)%/)

	return m ? Number(m[1]) : undefined
}

/**
 * Pull the per-locale table's per-tag percentage for one locale, by HEADER — the same discipline as
 * {@linkcode arenaColumn}. `per-locale-f1` emits `| Tag | <locale> … | Δ |` with one column per answer-key file, so a
 * locale is found by its column name; a reordered or added locale column then cannot swap one locale's number for
 * another's. A missing table, tag or column reads `undefined`, and so does an empty (`—`) cell.
 */
function perLocale(md: string, tag: string, locale: string): number | undefined {
	return Number(tableCell(md, /^\|\s*Tag\s*\|/, locale, tag)?.replace("%", "")) || undefined
}

/**
 * One cell of a markdown pipe-table, located by header COLUMN name and first-column ROW name in a single pull over the
 * lines: the header must come first, and the row is searched only after it, so a row can only belong to the table its
 * header opened. A missing table, column or row reads `undefined`; the caller parses the cell text.
 */
function tableCell(md: string, headerPattern: RegExp, column: string, row: string): string | undefined {
	const rowPattern = new RegExp(`^\\|\\s*${row}\\s*\\|`)
	let columnIndex = -1

	for (const line of TextSpliterator.from(md)) {
		if (columnIndex === -1) {
			if (!headerPattern.test(line)) continue

			columnIndex = tableCells(line).indexOf(column)

			if (columnIndex === -1) return undefined

			continue
		}

		if (rowPattern.test(line)) return tableCells(line)[columnIndex]
	}

	return undefined
}

/**
 * Sidecar-first reads (the scorers emit JSON beside the markdown since night-11; the regex fallback keeps old out-dirs
 * replayable). A sidecar that exists but can't parse is a loud throw — never a silent fallback to presentation
 * parsing.
 */
/**
 * Parsed scorer sidecar JSON — only the fields this check reads are modeled.
 */
interface ScorerSidecar {
	tags?: Record<string, { f1?: number } | undefined>
	summary?: { pass_rate_pct?: number }
}

/**
 * The assembled verdict, as written to `verdict.json`.
 */
export interface PromotionVerdict {
	label: string
	/**
	 * WHICH ARTIFACT THE FLOORS WERE READ FROM — not which flag was passed. `weights-cache` is its own value because a
	 * package-shaped cache's `model.onnx` is whatever the package ships (int8, in every shipped weights package), and
	 * calling that "fp32" invites exactly the confound `baselines.json`'s $precision_comparability documents: someone
	 * diffs two verdicts, sees fp32-vs-int8, and attributes a quantization delta to the model. It said "fp32" for a
	 * verifiably int8 cache on 2026-07-16.
	 */
	graded_artifact: "int8" | "fp32" | "weights-cache"
	verdict: "PASS" | "FAIL"
	results: Record<string, { floor: number; actual: number | undefined; pass: boolean }>
	int8_vs_fp32_deltas: Record<string, number>
	generated_at_dir: PathBuilderLike
}

/**
 * Assemble the verdict from the out-dir's battery outputs, write `verdict.json`, and report the per-floor lines.
 * Returns `failed` (any floor missed) — the caller owns the exit code.
 */
export async function assemblePromotionVerdict(
	options: PromotionVerdictOptions,
	report: (line: string) => void = console.log
): Promise<{ failed: boolean; verdict: PromotionVerdict }> {
	const gate = await readLocalJSONFile<{
		label: string
		floors: Record<string, number>
		int8_vs_fp32_max_delta_pp?: number
	}>(options.gate)

	const dir = options.outDir
	const read = (f: string): Promise<string> => readLocalTextFile(dir, f)

	async function maybeRead(f: string): Promise<string | undefined> {
		try {
			return await read(f)
		} catch {
			return undefined
		}
	}

	async function sidecar(f: string): Promise<ScorerSidecar | undefined> {
		const raw = await maybeRead(f)

		return raw === undefined ? undefined : parseJSONStrict<ScorerSidecar>(raw)
	}

	function tagF1(side: ScorerSidecar | undefined, md: string, tag: string): number | undefined {
		const f1 = side?.tags?.[tag]?.f1

		if (f1 !== undefined) return f1

		return scorerF1(md, tag)
	}

	async function collect(tag: "fp32" | "int8"): Promise<Record<string, number | undefined>> {
		// Every battery output is an independent file, so the reads are issued together.
		const [
			pl,
			affix,
			unit,
			country,
			affixJ,
			unitJ,
			countryJ,
			poboxJ,
			intersectionJ,
			pobox,
			intersection,
			deorder,
			arenas,
			cascadeJ,
		] = await Promise.all([
			read(`${tag}-per-locale.md`),
			read(`${tag}-affix.md`),
			read(`${tag}-unit.md`),
			read(`${tag}-country.md`),
			sidecar(`${tag}-affix.json`),
			sidecar(`${tag}-unit.json`),
			sidecar(`${tag}-country.json`),
			sidecar(`${tag}-pobox.json`),
			sidecar(`${tag}-intersection.json`),
			maybeRead(`${tag}-pobox.md`),
			maybeRead(`${tag}-intersection.md`),
			read(`${tag}-deorder.md`),
			maybeRead("arenas.md"),
			sidecar("cascade-smoke.json"),
		])

		// Capture the anchor-ON native-DE locality (the conditional value) regardless of the anchor-OFF cell —
		// the OFF cell is a diagnostic and is empty when the zeroed-anchor run can't satisfy the card's
		// `anchor.required` strict scorer (`[^|]*` tolerates that empty cell instead of false-failing).
		const deNative = deorder.match(/native DE\s*\|[^|]*\|\s*([\d.]+)%/)
		// Locale summary row: `| us | <n> | <macro>% | <micro>% | <exact>% |`
		const micro = pl.match(/\|\s*us\s*\|\s*\d+\s*\|\s*[\d.]+%\s*\|\s*([\d.]+)%/)

		return {
			"us.postcode": perLocale(pl, "postcode", "us"),
			"us.locality": perLocale(pl, "locality", "us"),
			"us.region": perLocale(pl, "region", "us"),
			"us.street": perLocale(pl, "street", "us"),
			"us.micro": micro ? Number(micro[1]) : undefined,
			"us.street_prefix": tagF1(affixJ, affix, "street_prefix"),
			"us.street_suffix": tagF1(affixJ, affix, "street_suffix"),
			"us.unit_real": tagF1(unitJ, unit, "unit"),
			"us.country_homograph_f1": tagF1(countryJ, country, "country"),
			"fr.postcode": perLocale(pl, "postcode", "fr"),
			"fr.house_number": perLocale(pl, "house_number", "fr"),
			"de.native_locality": deNative ? Number(deNative[1]) : undefined,
			"fr.region": perLocale(pl, "region", "fr"),
			"us.po_box_real": poboxJ?.tags?.po_box?.f1 ?? (pobox ? scorerF1(pobox, "po_box") : undefined),
			"fr.cedex_real": poboxJ?.tags?.cedex?.f1 ?? (pobox ? scorerF1(pobox, "cedex") : undefined),
			// Graded as the WEAKER of the two spans — an intersection parse needs both.
			"us.intersection_real": intersectionJ
				? Math.min(intersectionJ.tags?.intersection_a?.f1 ?? 0, intersectionJ.tags?.intersection_b?.f1 ?? 0)
				: intersection
					? Math.min(scorerF1(intersection, "intersection_a") ?? 0, scorerF1(intersection, "intersection_b") ?? 0)
					: undefined,
			// Arena leg runs once on the ship artifact (int8); the fp32 pass reads undefined and the
			// delta loop skips it. The `neural` column of the `perturb` row, located by header — the
			// column order changed when #1151 dropped the v0 comparison (see arenaColumn).
			"arena.perturb": arenas ? arenaColumn(arenas, "perturb", "neural") : undefined,
			// Demo-cascade smoke pass rate (#524) — whole-stack parse→reconcile→resolve against the slim
			// hot DB. Like the arena leg it runs ONCE on the ship artifact (no fp32/int8 split); sidecar
			// only (the leg is new — there are no pre-sidecar out-dirs to replay). Absent sidecar (DB not
			// staged / runner errored) reads undefined → a floored spec FAILS loudly, an unfloored spec
			// ignores it.
			"cascade.demo_smoke": cascadeJ?.summary?.pass_rate_pct,
		}
	}

	const fp32 = await collect("fp32")
	const int8 = options.withInt8 ? await collect("int8") : undefined
	const graded = int8 ?? fp32 // floors are graded on the ship artifact when present

	// Floors owned by a DEDICATED leg in promotion-gate.ts (not a per-tag F1 in `graded`) — that leg
	// runs the check and exits non-zero on failure, so the per-tag aggregator here must SKIP them or it
	// spuriously reports "NOT FOUND" for a floor that already passed (#949's fr.bare_street_intact).
	const LEG_HANDLED_FLOORS = new Set(["fr.bare_street_intact"])

	const results: Record<string, { floor: number; actual: number | undefined; pass: boolean }> = {}
	let failed = false

	// A leg-handled floor is ENFORCED by its leg but was absent from `results` entirely, so a reader
	// counting floors here saw 17 where the spec declares 18 — and a floor that is missing from a report
	// reads as a floor that did not run. Enforcement stays with the leg; this only completes the record,
	// from the sidecar the leg already writes. Reaching this function at all means the leg passed, since
	// it returns non-zero otherwise.
	const legSidecars: Record<string, { file: string; rate: string }> = {
		"fr.bare_street_intact": { file: "fr-bare-street.json", rate: "bare_rate" },
	}

	for (const [key, floor] of Object.entries(gate.floors)) {
		if (LEG_HANDLED_FLOORS.has(key)) {
			const legSidecar = legSidecars[key]
			const raw = legSidecar ? await maybeRead(legSidecar.file) : undefined

			if (raw) {
				const actual = parseJSONStrict<Record<string, number>>(raw)[legSidecar!.rate]

				results[key] = { floor, actual, pass: true }
			}

			continue
		}

		const actual = graded[key]
		const pass = actual !== undefined && actual >= floor

		if (!pass) {
			failed = true
		}

		results[key] = { floor, actual, pass }
	}

	const deltas: Record<string, number> = {}

	if (int8 && gate.int8_vs_fp32_max_delta_pp !== undefined) {
		for (const key of Object.keys(gate.floors)) {
			const a = fp32[key]
			const b = int8[key]

			if (a === undefined || b === undefined) continue
			const d = Math.abs(a - b)
			deltas[key] = Number(d.toFixed(2))

			if (d > gate.int8_vs_fp32_max_delta_pp) {
				failed = true
				results[`int8_delta.${key}`] = { floor: gate.int8_vs_fp32_max_delta_pp, actual: d, pass: false }
			}
		}
	}

	const verdict: PromotionVerdict = {
		label: gate.label,
		graded_artifact: options.gradedArtifact ?? (int8 ? "int8" : "fp32"),
		verdict: failed ? "FAIL" : "PASS",
		results,
		int8_vs_fp32_deltas: deltas,
		generated_at_dir: dir,
	}

	await writeLocalJSONFile(verdict, dir, "verdict.json")

	report(`\n== promotion gate [${gate.label}] — ${verdict.verdict} ==`)

	for (const [k, r] of Object.entries(results)) {
		report(`  ${r.pass ? "✓" : "✗"} ${k}: ${r.actual ?? "NOT FOUND"} (floor ${r.floor})`)
	}

	return { failed, verdict }
}
