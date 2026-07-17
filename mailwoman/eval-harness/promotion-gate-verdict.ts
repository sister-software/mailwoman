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
 *   changes, THIS file is the single place the gate's parsing breaks — loudly (a floor whose number
 *   can't be found is a FAIL, never a skip).
 */

import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

/** Options for {@linkcode assemblePromotionVerdict}. */
export interface PromotionVerdictOptions {
	/** Path to the gate-spec JSON (already resolved to a real file). */
	gate: string
	/** The promotion-gate out-dir carrying the battery outputs. */
	outDir: string
	/** Also collect the int8 battery and enforce the fp32↔int8 delta cap. */
	withInt8?: boolean
	/** Overrides the derived label — pass `weights-cache` when the floors were read from a package-shaped cache. */
	gradedArtifact?: "int8" | "fp32" | "weights-cache"
}

/** Pull `| <tag> | … | <F1> |`-style F1 from an affix/country scorer table (P, R, F1 columns). */
function scorerF1(md: string, tag: string): number | undefined {
	const m = md.match(new RegExp(`\\|\\s*${tag}\\s*\\|\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*([\\d.]+)`))

	return m ? Number(m[1]) : undefined
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
	const lines = md.split("\n")
	const cells = (line: string): string[] =>
		line
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim())
	const header = lines.find((l) => /^\|\s*arena\s*\|/.test(l))
	const row = lines.find((l) => new RegExp(`^\\|\\s*${arena}\\s*\\|`).test(l))

	if (!header || !row) return undefined

	const idx = cells(header).indexOf(column)

	if (idx < 0) return undefined

	const m = cells(row)[idx]?.match(/([\d.]+)%/)

	return m ? Number(m[1]) : undefined
}

/** Pull the per-locale table's per-tag percentage for a locale column (US first, FR second). */
function perLocale(md: string, tag: string, locale: "us" | "fr"): number | undefined {
	const m = md.match(new RegExp(`\\|\\s*${tag}\\s*\\|\\s*([\\d.]+)%\\s*\\|\\s*([\\d.—-]+)%?`))

	if (!m) return undefined

	return Number(locale === "us" ? m[1] : m[2]) || undefined
}

/**
 * Sidecar-first reads (the scorers emit JSON beside the markdown since night-11; the regex fallback keeps old out-dirs
 * replayable). A sidecar that exists but can't parse is a loud throw — never a silent fallback to presentation
 * parsing.
 */
/** Parsed scorer sidecar JSON — only the fields this gate reads are modeled. */
interface ScorerSidecar {
	tags?: Record<string, { f1?: number } | undefined>
	summary?: { pass_rate_pct?: number }
}

/** The assembled verdict, as written to `verdict.json`. */
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
	generated_at_dir: string
}

/**
 * Assemble the verdict from the out-dir's battery outputs, write `verdict.json`, and report the per-floor lines.
 * Returns `failed` (any floor missed) — the caller owns the exit code.
 */
export function assemblePromotionVerdict(
	options: PromotionVerdictOptions,
	report: (line: string) => void = console.log
): { failed: boolean; verdict: PromotionVerdict } {
	const gate = JSON.parse(readFileSync(options.gate, "utf8")) as {
		label: string
		floors: Record<string, number>
		int8_vs_fp32_max_delta_pp?: number
	}
	const dir = options.outDir
	const read = (f: string) => readFileSync(path.join(dir, f), "utf8")

	function maybeRead(f: string): string | undefined {
		try {
			return read(f)
		} catch {
			return undefined
		}
	}

	function sidecar(f: string): ScorerSidecar | undefined {
		const raw = maybeRead(f)

		return raw === undefined ? undefined : JSON.parse(raw)
	}
	function tagF1(side: ScorerSidecar | undefined, md: string, tag: string): number | undefined {
		const f1 = side?.tags?.[tag]?.f1

		if (f1 !== undefined) return f1

		return scorerF1(md, tag)
	}

	function collect(tag: "fp32" | "int8"): Record<string, number | undefined> {
		const pl = read(`${tag}-per-locale.md`)
		const affix = read(`${tag}-affix.md`)
		const unit = read(`${tag}-unit.md`)
		const country = read(`${tag}-country.md`)
		const affixJ = sidecar(`${tag}-affix.json`)
		const unitJ = sidecar(`${tag}-unit.json`)
		const countryJ = sidecar(`${tag}-country.json`)
		const poboxJ = sidecar(`${tag}-pobox.json`)
		const intersectionJ = sidecar(`${tag}-intersection.json`)
		const plJ = sidecar(`${tag}-per-locale.json`)
		const pobox = maybeRead(`${tag}-pobox.md`)
		const intersection = maybeRead(`${tag}-intersection.md`)
		const deorder = read(`${tag}-deorder.md`)
		// Capture the anchor-ON native-DE locality (the gated value) regardless of the anchor-OFF cell —
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
			"arena.perturb": (() => {
				const md = maybeRead("arenas.md")

				return md ? arenaColumn(md, "perturb", "neural") : undefined
			})(),
			// Demo-cascade smoke pass rate (#524) — whole-stack parse→reconcile→resolve against the slim
			// hot DB. Like the arena leg it runs ONCE on the ship artifact (no fp32/int8 split); sidecar
			// only (the leg is new — there are no pre-sidecar out-dirs to replay). Absent sidecar (DB not
			// staged / runner errored) reads undefined → a floored spec FAILS loudly, an unfloored spec
			// ignores it.
			"cascade.demo_smoke": sidecar("cascade-smoke.json")?.summary?.pass_rate_pct,
		}
	}

	const fp32 = collect("fp32")
	const int8 = options.withInt8 ? collect("int8") : undefined
	const graded = int8 ?? fp32 // floors are graded on the ship artifact when present

	// Floors owned by a DEDICATED leg in promotion-gate.ts (not a per-tag F1 in `graded`) — that leg
	// runs the check and exits non-zero on failure, so the per-tag aggregator here must SKIP them or it
	// spuriously reports "NOT FOUND" for a floor that already passed (#949's fr.bare_street_intact).
	const LEG_HANDLED_FLOORS = new Set(["fr.bare_street_intact"])

	const results: Record<string, { floor: number; actual: number | undefined; pass: boolean }> = {}
	let failed = false

	for (const [key, floor] of Object.entries(gate.floors)) {
		if (LEG_HANDLED_FLOORS.has(key)) continue
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
	writeFileSync(path.join(dir, "verdict.json"), JSON.stringify(verdict, null, "\t"))

	report(`\n== promotion gate [${gate.label}] — ${verdict.verdict} ==`)

	for (const [k, r] of Object.entries(results)) {
		report(`  ${r.pass ? "✓" : "✗"} ${k}: ${r.actual ?? "NOT FOUND"} (floor ${r.floor})`)
	}

	return { failed, verdict }
}
