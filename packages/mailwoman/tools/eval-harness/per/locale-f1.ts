/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-locale held-out F1 regression check.
 *
 *   The golden v0.1.2 dev set has country files `dev/us.jsonl` and `dev/fr.jsonl`.
 *   It also has `dev/adversarial.jsonl`. This script loads the neural classifier once and scores each country file.
 *   It reports per-locale component-F1 and exact-match. It also reports macro-F1 spread across locales.
 *
 *   The score follows `harness-neural.ts`: flatten the AddressTree via `decodeAsJSON`, fold the Stage-3 street
 *   parts (`street_prefix`/`street`/`street_suffix` → `street`, `intersection_a`/`_b` → `street`) into the
 *   golden component vocab, then compare case-folded strings per tag.
 *
 *   The fold is read per row from the answer key's own `MANIFEST.json` (`convention.street_convention`):
 *   split-convention countries are scored unfolded, everyone else keeps the glue.
 *
 *   The anchor + gazetteer feed channels are fed by default (the standard paths, same as
 *   `score-country-homograph.ts` / `oa-resolver-eval`), because omitting them scores an anchor-trained model
 *   out-of-distribution and silently collapses the admin tags (country→0, region↔locality flips) while
 *   street/venue survive. Pass `--no-anchor` to measure the zero-feed path on purpose.
 *
 *   `promotion-eval.ts` calls {@linkcode perLocaleF1} in-process and captures the markdown report (the
 *   `report` sink) into `<out-dir>/<tag>-per-locale.md`, the file the verdict assembler regex-reads, while the
 *   progress narration goes to `reportError`.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { STREET_FAMILY_TAGS } from "@mailwoman/codex/component"
import { dataRootPath } from "@mailwoman/core/data-root"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { type CaseNormalization, DEFAULT_CASE_NORMALIZATION } from "@mailwoman/core/pipeline"
import {
	NeuralAddressClassifier,
	parseAnchorLookup,
	parseGazetteerLexicon,
	parseWordConsistencyEnv,
} from "@mailwoman/neural"
import { type AddressSystemConventions, DEFAULT_TOGGLE, type Toggle } from "@mailwoman/neural/classifier/options"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { computeQueryShape } from "@mailwoman/query-shape"
import { basename, type PathBuilderLike, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { $public } from "#env"
import { deriveGeocodeRegister } from "#geocode/core"
import { normalizeComponent } from "#tools/eval-harness/per/tag-f1"

/**
 * Default anchor + gazetteer feed paths — the same ones `score-country-homograph.ts`
 * and the verdict `oa-resolver-eval` runs use.
 *
 * These paths are defaults for anchor-trained models.
 * Without them, the ONNXRunner uses its `confidence = 0` zero-feed.
 *
 * That setting collapses admin tags (`country` F1 to 0 and region↔locality flips)
 * while morphology tags survive.
 * The harness then reports a per-version regression from this out-of-distribution setup.
 */
const DEFAULT_ANCHOR_LOOKUP = dataRootPath("anchor", "pilot-anchor-lookup.json")
const DEFAULT_GAZETTEER_LEXICON = "data/gazetteer/anchor-lexicon-v1.json"

// #region Options

/**
 * Options for {@linkcode perLocaleF1} — one field per flag the check used to serialize into
 * argv; {@linkcode PerLocaleF1Options.goldenDir} and {@linkcode PerLocaleF1Options.files}
 * default inside the function, so a caller that omits them gets exactly what the CLI gave.
 */
export interface PerLocaleF1Options {
	/**
	 * The answer key to grade against, defaulting to `data/eval/golden/v0.1.2/dev`; check specs declare
	 * this (`golden_dir`) because two specs naming different golden versions are not comparable.
	 */
	goldenDir?: string
	/**
	 * Per-locale files inside {@linkcode PerLocaleF1Options.goldenDir}.
	 * Default `["us.jsonl", "fr.jsonl", "adversarial.jsonl"]`.
	 */
	files?: string[]
	weightsCache?: string
	modelPath?: string
	tokenizerPath?: PathBuilderLike
	modelCardPath?: string
	modelAnchorLookupPath?: PathBuilderLike
	gazetteerLexiconPath?: string
	noAnchor?: boolean
	/**
	 * Defaults to {@linkcode DEFAULT_TOGGLE}.
	 */
	suppressGazetteerNearPostcode?: Toggle
	/**
	 * `auto` | `<system>` enables the address-system conventions mask.
	 * Defaults to `"off"`.
	 */
	conventions?: AddressSystemConventions
	/**
	 * Defaults to {@linkcode DEFAULT_TOGGLE}.
	 */
	bridgePunctuationGaps?: Toggle
	outJSON?: string
	/**
	 * The all-caps case handling; `"preserve"` disables the title-case shim for the all-caps read.
	 * Defaults to the library default, `"title-case"`.
	 */
	caseNormalization?: CaseNormalization
	/**
	 * Parse each row with the register returned by `deriveGeocodeRegister`.
	 * The geocode path uses the same register.
	 *
	 * Default false parses every row with no `inputMode`, which the classifier reads
	 * as `fragmented` and so feeds both evidence lexicons to every row, including the
	 * 1,896 of 2,660 `us.jsonl` rows production withholds them from.
	 */
	productionRegister?: boolean
}

/**
 * What {@linkcode perLocaleF1} returns — the same object written to `--out-json`.
 */
export interface PerLocaleF1Result {
	reports: FileReport[]
	/**
	 * Max − min macro-F1 across the locale files (adversarial excluded) — the interference signal.
	 */
	spread: number
}

// #endregion

// #region Golden row + fold (shared semantics with harness-neural.ts)

interface GoldenRow {
	raw: string
	components: Record<string, string>
	country?: string
	notes?: string
}

/**
 * Fold neural Stage-3 tags into the golden component vocab (street parts + intersections → street).
 *
 * `foldStreetParts: false` is the split-street convention, where the answer key labels
 * `street_prefix` / `street` / `street_suffix` as three spans, so gluing the prediction
 * back together before comparing measures the harness rather than the model.
 *
 * Which mode applies is decided per row from the golden dir's own manifest
 * (see {@linkcode readStreetConvention}), never from a flag someone has to remember.
 */
function foldToComponents(flat: Partial<Record<ComponentTag, string>>, foldStreetParts = true): Record<string, string> {
	const out: Record<string, string> = {}
	const streetParts: string[] = []

	for (const tag of STREET_FAMILY_TAGS) {
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
		// Unfolded mode preserves the tags of intersection parts.
		// The golden labels use those tags.
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
 * Country → `"split"` | `"folded"`, read from the golden version's own `MANIFEST.json`
 * (`convention.street_convention`; the `*` key is the default), looked up in the golden dir and then
 * its parent because the battery points at a split subdir while the manifest sits at the version root.
 * A version with no such block reads as all-folded.
 */
async function readStreetConvention(goldenDir: string): Promise<Record<string, string>> {
	for (const candidate of [resolvePath(goldenDir, "MANIFEST.json"), resolvePath(goldenDir, "..", "MANIFEST.json")]) {
		if (!(await pathExists(candidate))) continue

		const manifest = await readLocalJSONFile<{ convention?: { street_convention?: Record<string, string> } }>(candidate)

		const convention = manifest.convention?.street_convention

		if (convention) return convention
	}

	return {}
}

function exactMatch(pred: Record<string, string>, gold: Record<string, string>): boolean {
	const keys = new Set([...Object.keys(pred), ...Object.keys(gold)])

	for (const k of keys) if (normalizeComponent(pred[k]) !== normalizeComponent(gold[k])) return false

	return true
}

// #endregion

// #region Per-file metrics

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
 * One locale file's scores, stored in {@linkcode PerLocaleF1Result.reports} and written to `--out-json`.
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
			const pred = normalizeComponent(preds[i]![tag]),
				gold = normalizeComponent(rows[i]!.components[tag])

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

// #endregion

// #region Main

/**
 * Score each locale file separately.
 *
 * Report per-locale component-F1 and exact-match.
 * Also report the cross-locale macro-F1 spread.
 *
 * The markdown report goes to `report` (one call per line, matching the child stdout the runner captured)
 * and the progress narration to `reportError`.
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
		caseNormalization: options.caseNormalization ?? DEFAULT_CASE_NORMALIZATION,
		productionRegister: options.productionRegister ?? false,
	}

	reportError("--- per-locale-f1.ts ---")
	reportError(`Golden dir: ${args.goldenDir}`)
	reportError(`Files: ${args.files.join(", ")}`)
	reportError(`Model: ${args.modelPath ?? "(default weights)"}`)

	const streetConvention = await readStreetConvention(args.goldenDir)

	const splitCountries = Object.entries(streetConvention)
		.filter(([, mode]) => mode === "split")
		.map(([country]) => country.toUpperCase())

	reportError(
		`Street convention: ${splitCountries.length ? `SPLIT for ${splitCountries.join(", ")} (unfolded scoring)` : "folded (no answer-key declaration)"}`
	)

	const foldStreetFor = (country: string | null): boolean => {
		const mode = streetConvention[(country ?? "").toUpperCase()] ?? streetConvention["*"] ?? "folded"

		return mode !== "split"
	}

	let neural: NeuralAddressClassifier

	// Package-shaped: `--weights-cache <root>` loads model + tokenizer + card + all
	// soft channels from `<root>/node_modules/@mailwoman/neural-weights-en-us` via
	// loadFromWeights, exactly as production does.
	// It takes precedence over the explicit `--model` path.
	if (args.weightsCache) {
		reportError(`Weights:    package-shaped from ${args.weightsCache} (loadFromWeights cacheRoot)`)

		neural = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: args.weightsCache })
	} else if (args.modelPath || args.tokenizerPath || args.modelCardPath) {
		// All three custom-model flags are required together, because a missing `--tokenizer` silently
		// fell back to the default shipped weights and two different checkpoints scored byte-identical.
		// Refuse to guess.
		if (!args.modelPath || !args.tokenizerPath || !args.modelCardPath) {
			throw new Error(
				"--model requires --tokenizer AND --model-card together (refusing to silently fall back to " +
					`default weights). got: model=${!!args.modelPath} tokenizer=${!!args.tokenizerPath} model-card=${!!args.modelCardPath}`
			)
		}

		const card = await readLocalJSONFile<{ labels: string[] }>(args.modelCardPath)

		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(args.tokenizerPath),
			ONNXRunner.create(args.modelPath),
		])

		// Anchor + gazetteer feed, default-on so an anchor-trained model is scored
		// in-distribution; `--no-anchor` opts out and explicit paths override,
		// while the runner harmlessly skips inputs a plainer ONNX does not declare.
		const anchorLookupPath = args.noAnchor ? undefined : (args.modelAnchorLookupPath ?? DEFAULT_ANCHOR_LOOKUP)
		const gazetteerLexiconPath = args.noAnchor ? undefined : (args.gazetteerLexiconPath ?? DEFAULT_GAZETTEER_LEXICON)

		const postcodeAnchorLookup =
			anchorLookupPath && (await pathExists(anchorLookupPath))
				? parseAnchorLookup(await readLocalJSONFile(anchorLookupPath))
				: undefined

		// Fed so a gazetteer-trained model gets its clues.
		// Harmless for older models, since the runner skips inputs the ONNX lacks.
		const gazetteerLexicon =
			gazetteerLexiconPath && (await pathExists(gazetteerLexiconPath))
				? parseGazetteerLexicon(await readLocalJSONFile(gazetteerLexiconPath))
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
			suppressGazetteerNearPostcode: args.suppressGazetteerNearPostcode ?? DEFAULT_TOGGLE,
			addressSystemConventions: args.conventions ?? "off",
			bridgePunctuationGaps: args.bridgePunctuationGaps ?? DEFAULT_TOGGLE,
		})
	} else {
		neural = await NeuralAddressClassifier.loadFromWeights()
	}

	const reports: FileReport[] = []

	for (const file of args.files) {
		const path = resolvePath(args.goldenDir, file)

		// Checked before the read: the spliterator reports a missing path as "invalid async
		// data resource", which is accurate about its argument and useless about the file.
		if (!(await pathExists(path))) {
			reportError(`  skip ${file}: not found at ${path}`)

			continue
		}

		let rows: GoldenRow[]

		try {
			rows = await JSONSpliterator.fromAsync<GoldenRow>(path).toArray()
		} catch (error) {
			reportError(`  skip ${file}: ${(error as Error).message}`)

			continue
		}

		const preds: Array<Record<string, string>> = []
		const t0 = performance.now()
		// MAILWOMAN_DUMP_MISS_TAG=<tag>: print every row where gold has <tag> but the prediction differs, a diagnostic lens for which surfaces the model drops. Harmless when the env is unset.
		const dumpTag = $public.MAILWOMAN_DUMP_MISS_TAG

		for (const row of rows) {
			const wordConsistency = parseWordConsistencyEnv($public.MAILWOMAN_WORD_CONSISTENCY ?? null)

			// Production parses feed the query-shape prior + `postcodeRepair` on every path,
			// so this battery must too or it scores a config production does not run.
			const rowShape = computeQueryShape(row.raw)

			const tree = await neural.parse(row.raw, {
				postcodeRepair: true,
				queryShape: rowShape,
				// Absent, the classifier reads the register as `fragmented` and feeds
				// both evidence lexicons to every row.
				// Production feeds them only where the kind verdict requires them.
				...(args.productionRegister ? { inputMode: deriveGeocodeRegister(row.raw, rowShape) } : {}),
				...(wordConsistency ? { enforceWordConsistency: wordConsistency } : {}),
				// `--case-normalization preserve` disables the all-caps title-case shim.
				// The shim would hide the model's own case handling from this measurement.
				caseNormalization: args.caseNormalization,
			})

			const pred = foldToComponents(decodeAsJSON(tree), foldStreetFor(row.country ?? null))
			preds.push(pred)

			if (dumpTag) {
				const gold = (row as { components?: Record<string, string> }).components?.[dumpTag]

				if (gold && gold !== pred[dumpTag]) {
					reportError(
						`MISS[${dumpTag}] ${basename(file, ".jsonl")} raw=${stringifyJSON(row.raw)} gold=${stringifyJSON(gold)} pred=${stringifyJSON(pred[dumpTag] ?? null)} all=${stringifyJSON(pred)}`
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

	const localeReports = reports.filter((r) => r.file !== "adversarial")
	const macroF1s = localeReports.map((r) => r.macroF1)
	const spread = macroF1s.length > 1 ? Math.max(...macroF1s) - Math.min(...macroF1s) : 0

	report("# Per-locale F1 regression check\n")
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

	// Per-tag F1 side by side across the locale files, where any interference concentrates.
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
		await writeLocalJSONFile(result, args.outJSON)

		reportError(`Wrote ${args.outJSON}`)
	}

	return result
}

// #endregion
