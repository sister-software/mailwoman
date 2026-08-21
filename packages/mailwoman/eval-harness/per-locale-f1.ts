/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-locale held-out F1 TRIPWIRE.
 *
 *   The golden v0.1.2 dev set is already split by country (`dev/us.jsonl`, `dev/fr.jsonl`,
 *   `dev/adversarial.jsonl`). This script loads the neural classifier ONCE and scores each country
 *   file SEPARATELY, then reports per-locale component-F1, exact-match, and — the point of the
 *   exercise — the SPREAD of macro-F1 across locales.
 *
 *   Why it exists (DeepSeek consult 2026-06-02, measurement #1): the multi-locale-interference risk
 *   is theorized, never observed. Before building any locale-conditioning architecture we must
 *   first measure whether US and FR already diverge on the SAME model. Equal per-locale F1 ⇒ no
 *   current interference ⇒ conditioning is premature. A gap ⇒ interference is real and conditioning
 *   earns its keep. Run again after adding any new locale: if an existing locale's F1 drops, that's
 *   the interference tripwire firing.
 *
 *   Scoring mirrors `harness-neural.ts`: flatten the AddressTree via `decodeAsJSON`, fold the
 *   Stage-3 street parts (`street_prefix`/`street`/`street_suffix` → `street`,
 *   `intersection_a`/`_b` → `street`) into the golden component vocab, then compare case-folded
 *   strings per tag.
 *
 *   THE FOLD IS NOT UNCONDITIONAL. It exists because the golden answer key through v0.1.2 wrote a US
 *   street as one span while the corpus (and the model) split it, and gluing was the cheap way to
 *   compare them. Golden v0.1.3 moved the answer key onto the corpus convention and DECLARES that in
 *   its `MANIFEST.json` (`convention.street_convention`), so the fold is now read per row from the
 *   answer key itself: split-convention countries are scored UNFOLDED, everyone else keeps the glue.
 *   An answer key that carries its own convention cannot be graded under the wrong one by accident —
 *   which is what happened on the v9.0.0 gate, where the convention gap read as an 0.4pp `us.street`
 *   regression.
 *
 *   The anchor + gazetteer feed channels are fed by DEFAULT (the standard paths, same as
 *   `score-country-homograph.ts` / `oa-resolver-eval`). The current 33-label STAGE3 models were
 *   trained with these channels live, so omitting them scores the model out-of-distribution and
 *   silently collapses the admin tags (country→0, region↔locality flips) while street/venue survive
 *   — the false "regression" this script used to report. Pass `--no-anchor` to measure the
 *   zero-feed (anchor-off) path on purpose, or `--model-anchor-lookup`/`--gazetteer-lexicon` to
 *   override paths.
 *
 *   The promotion gate calls {@linkcode perLocaleF1} IN-PROCESS and captures the markdown report
 *   (the `report` sink) into `<out-dir>/<tag>-per-locale.md` — the file the verdict assembler
 *   regex-reads for `us.postcode`, `us.locality`, `us.region`, `us.street`, `fr.house_number` and
 *   `us.micro`. The progress narration goes to `reportError`, which is where the child process's
 *   stderr went: captured and dropped. `scripts/eval/per-locale-f1.ts` is the thin CLI that keeps
 *   standalone invocation working.
 *
 *   Usage: node scripts/eval/per-locale-f1.ts\
 *   --golden-dir data/eval/golden/v0.1.2/dev\
 *   --model /tmp/v072-eval/model.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card /tmp/v072-eval/model-card.json\
 *   --files us.jsonl,fr.jsonl,adversarial.jsonl\
 *   --out-json /tmp/per-locale-f1.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"

import { type ComponentTag, decodeAsJSON } from "@mailwoman/core/decoder"
import { $public } from "@mailwoman/core/env"
import { isPresent, parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"
import {
	NeuralAddressClassifier,
	parseAnchorLookup,
	parseGazetteerLexicon,
	parseWordConsistencyEnv,
} from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { computeQueryShape } from "@mailwoman/query-shape"
import { JSONSpliterator } from "spliterator"

/**
 * Default anchor + gazetteer feed paths — the SAME ones `score-country-homograph.ts` and the verdict `oa-resolver-eval`
 * runs use. The current 33-label STAGE3 models (v1.5.x, v1.7.x; ONNX inputs `anchor_features`/`gazetteer_features`)
 * were trained WITH these channels live, so honest inference must feed them. The lookup is keyed by the input's own
 * postcode — always available at eval time. Why this is a DEFAULT, not opt-in (the bug this file used to have): when
 * these are omitted, the ONNXRunner falls back to the `confidence = 0` zero-feed (its "anchor-off identity"). That's
 * out-of-distribution for an anchor-trained model and it SELECTIVELY collapses the admin tags
 * (country/region/locality/postcode) + the CRF transitions around them — `country` F1 drops to 0, region↔locality flip
 * — while the morphology tags (street/house_number/venue) that don't lean on the anchor channel survive. The result
 * LOOKS like a per-version model regression but is purely a harness OOD artifact: BOTH v1.5.0 and v1.7.0 crater
 * identically without the feed and recover identically with it. Pass `--no-anchor` to deliberately measure the
 * anchor-off (zero-feed) path.
 */
const DEFAULT_ANCHOR_LOOKUP = dataRootPath("anchor", "pilot-anchor-lookup.json")
const DEFAULT_GAZETTEER_LEXICON = "data/gazetteer/anchor-lexicon-v1.json"

//#region Options

/**
 * Options for {@linkcode perLocaleF1} — one field per flag the gate used to serialize into argv. The two fields the old
 * `parseArgs` seeded with defaults ({@linkcode PerLocaleF1Options.goldenDir}, {@linkcode PerLocaleF1Options.files}) are
 * optional here and defaulted inside the function, so a caller that omits them gets exactly what the CLI gave.
 */
export interface PerLocaleF1Options {
	/**
	 * The answer key to grade against. Default `data/eval/golden/v0.1.2/dev`. Gate specs declare this (`golden_dir`)
	 * because two specs naming different golden versions are not comparable.
	 */
	goldenDir?: string
	/**
	 * Per-locale files inside {@linkcode PerLocaleF1Options.goldenDir}. Default `["us.jsonl", "fr.jsonl",
	 * "adversarial.jsonl"]`.
	 */
	files?: string[]
	weightsCache?: string
	modelPath?: string
	tokenizerPath?: string
	modelCardPath?: string
	modelAnchorLookupPath?: string
	gazetteerLexiconPath?: string
	noAnchor?: boolean
	suppressGazNearPostcode?: boolean
	conventions?: string
	bridgeGaps?: boolean
	outJSON?: string
	/**
	 * P3 (#829/#690): disable the all-caps title-case shim (`normalizeCase: false`) — the ALL-CAPS read. Default false.
	 */
	rawCase?: boolean
}

/**
 * What {@linkcode perLocaleF1} returns — the same object written to `--out-json`.
 */
export interface PerLocaleF1Result {
	reports: FileReport[]
	/**
	 * Max − min macro-F1 across the LOCALE files (adversarial excluded) — the interference signal.
	 */
	spread: number
}

//#endregion

//#region Golden row + fold (shared semantics with harness-neural.ts)

interface GoldenRow {
	raw: string
	components: Record<string, string>
	country?: string
	notes?: string
}

/**
 * Fold neural Stage-3 tags into the golden component vocab (street parts + intersections → street).
 *
 * `foldStreetParts: false` is the v0.1.3 convention (#gate-relabel, 2026-08-06): that answer key labels US streets
 * SPLIT — `street_prefix` / `street` / `street_suffix` are three spans — so gluing the prediction back together before
 * comparing measures the harness, not the model. The v9.0.0 promotion gate read exactly that as an 0.4pp `us.street`
 * regression. Which mode applies is decided PER ROW from the golden dir's own MANIFEST (see
 * {@linkcode readStreetConvention}), never from a flag someone has to remember: an answer key that declares its
 * convention cannot be graded under the wrong one by accident.
 */
function foldToComponents(flat: Partial<Record<ComponentTag, string>>, foldStreetParts = true): Record<string, string> {
	const out: Record<string, string> = {}
	const streetParts: string[] = []

	for (const tag of ["street_prefix", "street_prefix_particle", "street", "street_suffix"] as const) {
		const v = flat[tag]

		if (!v) continue

		if (foldStreetParts) {
			streetParts.push(v)
		} else {
			out[tag] = v
		}
	}

	if (streetParts.length) {
		out.street = streetParts.join(" ")
	}

	const xs: string[] = []

	if (flat.intersection_a) {
		xs.push(flat.intersection_a)
	}

	if (flat.intersection_b) {
		xs.push(flat.intersection_b)
	}

	if (xs.length) {
		// Unfolded mode passes them through as their own tags — which is what the golden labels them as
		// (`intersection_a` / `intersection_b`), so the fold was mis-scoring those rows in both directions.
		if (foldStreetParts) {
			out.street = [out.street, ...xs].filter(isPresent).join(" ")
		} else {
			if (flat.intersection_a) {
				out.intersection_a = flat.intersection_a
			}

			if (flat.intersection_b) {
				out.intersection_b = flat.intersection_b
			}
		}
	}

	for (const [tag, value] of Object.entries(flat) as Array<[ComponentTag, string]>) {
		if (
			tag === "street_prefix" ||
			tag === "street_prefix_particle" ||
			tag === "street" ||
			tag === "street_suffix" ||
			tag === "intersection_a" ||
			tag === "intersection_b"
		)
			continue

		if (value) {
			out[tag] = value
		}
	}

	return out
}

/**
 * Country → `"split"` | `"folded"`, read from the golden version's own `MANIFEST.json` (`convention.street_convention`;
 * the `*` key is the default). Looked up in the golden dir and then its parent, because the battery points at a SPLIT
 * subdir (`…/v0.1.3/dev`) while the manifest sits at the version root.
 *
 * A version with no such block — every golden through v0.1.2 — reads as all-folded, so this is a no-op on the old
 * answer keys and nothing about replaying an old out-dir changes.
 */
function readStreetConvention(goldenDir: string): Record<string, string> {
	for (const candidate of [resolve(goldenDir, "MANIFEST.json"), resolve(goldenDir, "..", "MANIFEST.json")]) {
		if (!existsSync(candidate)) continue

		const manifest = parseJSONStrict<{ convention?: { street_convention?: Record<string, string> } }>(
			readFileSync(candidate, "utf8")
		)

		const convention = manifest.convention?.street_convention

		if (convention) return convention
	}

	return {}
}

const norm = (v: string | undefined): string => (v ?? "").trim().toLowerCase()

function exactMatch(pred: Record<string, string>, gold: Record<string, string>): boolean {
	const keys = new Set([...Object.keys(pred), ...Object.keys(gold)])

	for (const k of keys) if (norm(pred[k]) !== norm(gold[k])) return false

	return true
}

//#endregion

//#region Per-file metrics

/**
 * One tag's counts and rates within a single locale file.
 */
export interface TagMetric {
	tp: number
	fp: number
	fn: number
	p: number
	r: number
	f1: number
}

/**
 * One locale file's scores. Carried in {@linkcode PerLocaleF1Result.reports} and written to `--out-json`.
 */
export interface FileReport {
	file: string
	n: number
	exactMatch: number
	exactRate: number
	macroF1: number
	microF1: number
	perTag: Record<string, TagMetric>
}

function scoreFile(file: string, rows: GoldenRow[], preds: Array<Record<string, string>>): FileReport {
	const tags = new Set<string>()

	for (const r of rows) {
		for (const k of Object.keys(r.components)) {
			tags.add(k)
		}
	}

	for (const p of preds) {
		for (const k of Object.keys(p)) {
			tags.add(k)
		}
	}

	const perTag: Record<string, TagMetric> = {}
	let f1Sum = 0

	let microTp = 0,
		microFp = 0,
		microFn = 0

	for (const tag of tags) {
		let tp = 0,
			fp = 0,
			fn = 0

		for (let i = 0; i < rows.length; i++) {
			const pred = norm(preds[i]![tag]),
				gold = norm(rows[i]!.components[tag])

			if (pred && gold && pred === gold) {
				tp++
			} else if (pred && (!gold || pred !== gold)) {
				fp++
			}

			if (gold && (!pred || pred !== gold)) {
				fn++
			}
		}

		const p = tp / Math.max(tp + fp, 1)
		const r = tp / Math.max(tp + fn, 1)
		const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0
		perTag[tag] = { tp, fp, fn, p, r, f1 }
		f1Sum += f1
		microTp += tp
		microFp += fp
		microFn += fn
	}

	const microP = microTp / Math.max(microTp + microFp, 1)
	const microR = microTp / Math.max(microTp + microFn, 1)
	const microF1 = microP + microR > 0 ? (2 * microP * microR) / (microP + microR) : 0

	let exact = 0

	for (let i = 0; i < rows.length; i++)
		if (exactMatch(preds[i]!, rows[i]!.components)) {
			exact++
		}

	return {
		file,
		n: rows.length,
		exactMatch: exact,
		exactRate: exact / Math.max(rows.length, 1),
		macroF1: tags.size ? f1Sum / tags.size : 0,
		microF1,
		perTag,
	}
}

//#endregion

//#region Main

/**
 * Score each locale file separately and report per-locale component-F1, exact-match, and the cross-locale macro-F1
 * SPREAD. The markdown report goes to `report` (one call per line, matching the child stdout the gate captured); the
 * progress narration goes to `reportError`.
 */
export async function perLocaleF1(
	options: PerLocaleF1Options = {},
	report: (line: string) => void = console.log,
	reportError: (line: string) => void = console.error
): Promise<PerLocaleF1Result> {
	const args = {
		...options,
		goldenDir: options.goldenDir ?? "data/eval/golden/v0.1.2/dev",
		files: options.files ?? ["us.jsonl", "fr.jsonl", "adversarial.jsonl"],
		rawCase: options.rawCase ?? false,
	}

	reportError("--- per-locale-f1.ts ---")
	reportError(`Golden dir: ${args.goldenDir}`)
	reportError(`Files: ${args.files.join(", ")}`)
	reportError(`Model: ${args.modelPath ?? "(default weights)"}`)

	const streetConvention = readStreetConvention(args.goldenDir)

	const splitCountries = Object.entries(streetConvention)
		.filter(([, mode]) => mode === "split")
		.map(([country]) => country.toUpperCase())

	reportError(
		`Street convention: ${splitCountries.length ? `SPLIT for ${splitCountries.join(", ")} (unfolded scoring)` : "folded (no answer-key declaration)"}`
	)

	const foldStreetFor = (country: string | undefined): boolean => {
		const mode = streetConvention[(country ?? "").toUpperCase()] ?? streetConvention["*"] ?? "folded"

		return mode !== "split"
	}

	let neural: NeuralAddressClassifier

	// PACKAGE-SHAPED (#718-safe): `--weights-cache <root>` loads model + tokenizer + card + ALL soft
	// channels (anchor + gazetteer + country) from `<root>/node_modules/@mailwoman/neural-weights-en-us`
	// via loadFromWeights, exactly as production does — the only way to grade a country-channel model
	// (v6.2.0+) in-distribution. Mirrors the gauntlet + `eval parity --weights-cache`. Takes precedence
	// over the explicit --model path.
	if (args.weightsCache) {
		reportError(`Weights:    package-shaped from ${args.weightsCache} (loadFromWeights cacheRoot)`)

		neural = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: args.weightsCache })
	} else if (args.modelPath || args.tokenizerPath || args.modelCardPath) {
		// FOOTGUN GUARD: if ANY custom-model flag is set, ALL THREE are required. Previously a missing
		// --tokenizer silently fell back to the DEFAULT shipped weights, so --model was ignored and two
		// different checkpoints scored byte-identical. Refuse to guess; fail loud.
		if (!args.modelPath || !args.tokenizerPath || !args.modelCardPath) {
			throw new Error(
				"--model requires --tokenizer AND --model-card together (refusing to silently fall back to " +
					`default weights). got: model=${!!args.modelPath} tokenizer=${!!args.tokenizerPath} model-card=${!!args.modelCardPath}`
			)
		}

		const card = parseJSONStrict<{ labels: string[] }>(readFileSync(args.modelCardPath, "utf8"))

		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(args.tokenizerPath),
			ONNXRunner.create(args.modelPath),
		])

		// Anchor + gazetteer feed. DEFAULT-ON (the standard paths) so an anchor-trained model is scored
		// in-distribution — see the DEFAULT_* note above for why omitting these silently collapses the
		// admin tags. `--no-anchor` opts out; an explicit `--model-anchor-lookup`/`--gazetteer-lexicon`
		// overrides the default path. The runner harmlessly skips inputs a plainer ONNX doesn't declare.
		const anchorLookupPath = args.noAnchor ? undefined : (args.modelAnchorLookupPath ?? DEFAULT_ANCHOR_LOOKUP)
		const gazetteerLexiconPath = args.noAnchor ? undefined : (args.gazetteerLexiconPath ?? DEFAULT_GAZETTEER_LEXICON)

		const postcodeAnchorLookup =
			anchorLookupPath && existsSync(anchorLookupPath)
				? parseAnchorLookup(parseJSONStrict(readFileSync(anchorLookupPath, "utf8")))
				: undefined

		// Gazetteer-anchor lexicon (#464): fed so a gazetteer-trained model gets its clues. Harmless for
		// older models (the runner skips inputs the ONNX lacks).
		const gazetteerLexicon =
			gazetteerLexiconPath && existsSync(gazetteerLexiconPath)
				? parseGazetteerLexicon(parseJSONStrict(readFileSync(gazetteerLexiconPath, "utf8")))
				: undefined

		reportError(
			`Anchor:     ${postcodeAnchorLookup ? `${anchorLookupPath} (${postcodeAnchorLookup.size} codes)` : args.noAnchor ? "(off — --no-anchor)" : `(none found at ${anchorLookupPath})`}`
		)

		reportError(
			`Gazetteer:  ${gazetteerLexicon ? gazetteerLexiconPath : args.noAnchor ? "(off — --no-anchor)" : `(none found at ${gazetteerLexiconPath})`}`
		)

		neural = new NeuralAddressClassifier({
			tokenizer,
			runner,
			labels: card.labels,
			postcodeAnchorLookup,
			gazetteerLexicon,
			suppressGazetteerNearPostcode: !!args.suppressGazNearPostcode,
			// #511 Tier A: --conventions auto|<system> enables the address-system conventions mask.
			...(args.conventions ? { addressSystemConventions: args.conventions as "auto" } : {}),
			...(args.bridgeGaps ? { bridgePunctuationGaps: true } : {}),
		})
	} else {
		neural = await NeuralAddressClassifier.loadFromWeights()
	}

	const reports: FileReport[] = []

	for (const file of args.files) {
		const path = resolve(args.goldenDir, file)

		// Checked before the read: the spliterator reports a missing path as "invalid async data
		// resource", which is accurate about its argument and useless about the file.
		if (!existsSync(path)) {
			reportError(`  skip ${file}: not found at ${path}`)

			continue
		}

		let rows: GoldenRow[]

		try {
			rows = await Array.fromAsync(JSONSpliterator.fromAsync<GoldenRow>(path))
		} catch (error) {
			reportError(`  skip ${file}: ${(error as Error).message}`)

			continue
		}

		const preds: Array<Record<string, string>> = []
		const t0 = performance.now()
		// MAILWOMAN_DUMP_MISS_TAG=<tag>: print every row where gold has <tag> but the prediction
		// differs (false-neg or mislabel). A diagnostic lens for "which surfaces does the model drop"
		// — added for the #560 fr.house_number investigation; harmless when the env is unset.
		const dumpTag = $public.MAILWOMAN_DUMP_MISS_TAG

		for (const row of rows) {
			const wordConsistency = parseWordConsistencyEnv($public.MAILWOMAN_WORD_CONSISTENCY)

			// PRODUCTION-CONFIG parity (2026-07-17, the M1 gate-fidelity fix): production parses feed the
			// query-shape prior + postcodeRepair on every path (safeClassify, geocode-core since #981), but
			// this battery historically fed NEITHER — so the gate scored a config production doesn't run.
			// M1 measured that gap at +2.3 micro on golden-us (the battery flattered production; the entire
			// delta was the since-scoped locality bias, PR #1148). Score what ships.
			const tree = await neural.parse(row.raw, {
				postcodeRepair: true,
				queryShape: computeQueryShape(row.raw),
				...(wordConsistency ? { enforceWordConsistency: wordConsistency } : {}),
				// P3 (#829/#690): --raw-case disables the all-caps title-case shim so the read measures the
				// MODEL's own case handling (the shim would mask any augment_upper_case_prob effect).
				...(args.rawCase ? { normalizeCase: false } : {}),
			})

			const pred = foldToComponents(decodeAsJSON(tree), foldStreetFor(row.country))
			preds.push(pred)

			if (dumpTag) {
				const gold = (row as { components?: Record<string, string> }).components?.[dumpTag]

				if (gold && gold !== pred[dumpTag]) {
					reportError(
						`MISS[${dumpTag}] ${basename(file, ".jsonl")} raw=${JSON.stringify(row.raw)} gold=${JSON.stringify(gold)} pred=${JSON.stringify(pred[dumpTag] ?? null)} all=${JSON.stringify(pred)}`
					)
				}
			}
		}

		const rep = scoreFile(basename(file, ".jsonl"), rows, preds)
		reports.push(rep)

		reportError(
			`  ${file}: n=${rep.n} macroF1=${(100 * rep.macroF1).toFixed(1)}% in ${((performance.now() - t0) / 1000).toFixed(1)}s`
		)
	}

	// Report
	const localeReports = reports.filter((r) => r.file !== "adversarial")
	const macroF1s = localeReports.map((r) => r.macroF1)
	const spread = macroF1s.length > 1 ? Math.max(...macroF1s) - Math.min(...macroF1s) : 0

	report("# Per-locale F1 tripwire\n")
	report("| Locale | n | Macro-F1 | Micro-F1 | Exact-match |")
	report("|---|--:|--:|--:|--:|")

	for (const r of reports) {
		report(
			`| ${r.file} | ${r.n} | ${(100 * r.macroF1).toFixed(1)}% | ${(100 * r.microF1).toFixed(1)}% | ${(100 * r.exactRate).toFixed(1)}% |`
		)
	}

	report("")
	report(`**Cross-locale macro-F1 spread (interference signal):** ${(100 * spread).toFixed(1)}pp`)
	report("")

	// Per-tag F1 side by side across the locale files (where the interference, if any, concentrates)
	const allTags = new Set<string>()

	for (const r of localeReports) {
		for (const k of Object.keys(r.perTag)) {
			allTags.add(k)
		}
	}

	report("## Per-tag F1 by locale\n")
	report(`| Tag | ${localeReports.map((r) => r.file).join(" | ")} | Δ |`)
	report(`|---|${localeReports.map(() => "--:").join("|")}|--:|`)

	for (const tag of [...allTags].toSorted()) {
		const cells = localeReports.map((r) => r.perTag[tag])
		const f1s = cells.map((c) => (c ? c.f1 : 0))
		const delta = f1s.length > 1 ? Math.max(...f1s) - Math.min(...f1s) : 0

		report(
			`| ${tag} | ${cells.map((c) => (c ? (100 * c.f1).toFixed(1) + "%" : "—")).join(" | ")} | ${(100 * delta).toFixed(1)}pp |`
		)
	}

	report("")

	const result: PerLocaleF1Result = { reports, spread }

	if (args.outJSON) {
		writeFileSync(args.outJSON, JSON.stringify(result, null, 2))

		reportError(`Wrote ${args.outJSON}`)
	}

	return result
}

//#endregion
