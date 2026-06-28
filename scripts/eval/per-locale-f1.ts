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
 *   Scoring mirrors `harness-v0-neural.ts`: flatten the AddressTree via `decodeAsJson`, fold the
 *   Stage-3 street parts (`street_prefix`/`street`/`street_suffix` → `street`,
 *   `intersection_a`/`_b` → `street`) into the golden component vocab, then compare case-folded
 *   strings per tag.
 *
 *   The anchor + gazetteer feed channels are fed by DEFAULT (the standard paths, same as
 *   `score-country-homograph.ts` / `oa-resolver-eval`). The current 33-label STAGE3 models were
 *   trained with these channels live, so omitting them scores the model out-of-distribution and
 *   silently collapses the admin tags (country→0, region↔locality flips) while street/venue survive
 *   — the false "regression" this script used to report. Pass `--no-anchor` to measure the
 *   zero-feed (anchor-off) path on purpose, or `--model-anchor-lookup`/`--gazetteer-lexicon` to
 *   override paths.
 *
 *   Usage: node --experimental-strip-types scripts/eval/per-locale-f1.ts\
 *   --golden-dir data/eval/golden/v0.1.2/dev\
 *   --model /tmp/v072-eval/model.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card /tmp/v072-eval/model-card.json\
 *   --files us.jsonl,fr.jsonl,adversarial.jsonl\
 *   --out-json /tmp/per-locale-f1.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"

import { type ComponentTag, decodeAsJson } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"

// Default anchor + gazetteer feed paths — the SAME ones `score-country-homograph.ts` and the verdict
// `oa-resolver-eval` runs use. The current 33-label STAGE3 models (v1.5.x, v1.7.x; ONNX inputs
// `anchor_features`/`gazetteer_features`) were trained WITH these channels live, so honest inference
// must feed them. The lookup is keyed by the input's own postcode — always available at eval time.
//
// Why this is a DEFAULT, not opt-in (the bug this file used to have): when these are omitted, the
// OnnxRunner falls back to the `confidence = 0` zero-feed (its "anchor-off identity"). That's
// out-of-distribution for an anchor-trained model and it SELECTIVELY collapses the admin tags
// (country/region/locality/postcode) + the CRF transitions around them — `country` F1 drops to 0,
// region↔locality flip — while the morphology tags (street/house_number/venue) that don't lean on
// the anchor channel survive. The result LOOKS like a per-version model regression but is purely a
// harness OOD artifact: BOTH v1.5.0 and v1.7.0 crater identically without the feed and recover
// identically with it. Pass `--no-anchor` to deliberately measure the anchor-off (zero-feed) path.
const DEFAULT_ANCHOR_LOOKUP = dataRootPath("anchor", "pilot-anchor-lookup.json")
const DEFAULT_GAZETTEER_LEXICON = "data/gazetteer/anchor-lexicon-v1.json"

// -------------------------------------------------------------------------------------------------
// Args
// -------------------------------------------------------------------------------------------------

interface Args {
	goldenDir: string
	files: string[]
	modelPath?: string
	tokenizerPath?: string
	modelCardPath?: string
	modelAnchorLookupPath?: string
	gazetteerLexiconPath?: string
	noAnchor?: boolean
	suppressGazNearPostcode?: boolean
	conventions?: string
	bridgeGaps?: boolean
	outJson?: string
}

function parseArgs(): Args {
	const argv = process.argv.slice(2)
	const out: Partial<Args> = {
		goldenDir: "data/eval/golden/v0.1.2/dev",
		files: ["us.jsonl", "fr.jsonl", "adversarial.jsonl"],
	}

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]

		if (a === "--golden-dir" && argv[i + 1]) out.goldenDir = argv[++i]
		else if (a === "--files" && argv[i + 1])
			out.files = argv[++i]!.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		else if (a === "--model" && argv[i + 1]) out.modelPath = argv[++i]
		else if (a === "--tokenizer" && argv[i + 1]) out.tokenizerPath = argv[++i]
		else if (a === "--model-card" && argv[i + 1]) out.modelCardPath = argv[++i]
		// Feed the postcode anchor for a 4-input anchor-trained model (else inference errors on the
		// missing anchor inputs). Mirrors oa-resolver-eval's --model-anchor-lookup.
		else if (a === "--model-anchor-lookup" && argv[i + 1]) out.modelAnchorLookupPath = argv[++i]
		else if (a === "--gazetteer-lexicon" && argv[i + 1]) out.gazetteerLexiconPath = argv[++i]
		// Opt OUT of the default anchor/gazetteer feed to deliberately measure the zero-feed (anchor-off)
		// behavior of an anchor-trained model. Without this flag the standard lookup/lexicon are fed.
		else if (a === "--no-anchor") out.noAnchor = true
		else if (a === "--suppress-gaz-near-postcode") out.suppressGazNearPostcode = true
		else if (a === "--conventions" && argv[i + 1]) out.conventions = argv[++i]
		else if (a === "--bridge-gaps") out.bridgeGaps = true
		else if (a === "--out-json" && argv[i + 1]) out.outJson = argv[++i]
	}

	return out as Args
}

// -------------------------------------------------------------------------------------------------
// Golden row + fold (shared semantics with harness-v0-neural.ts)
// -------------------------------------------------------------------------------------------------

interface GoldenRow {
	raw: string
	components: Record<string, string>
	country?: string
	notes?: string
}

/** Fold neural Stage-3 tags into the golden component vocab (street parts + intersections → street). */
function foldToComponents(flat: Partial<Record<ComponentTag, string>>): Record<string, string> {
	const out: Record<string, string> = {}
	const streetParts: string[] = []

	for (const tag of ["street_prefix", "street_prefix_particle", "street", "street_suffix"] as const) {
		const v = flat[tag]

		if (v) streetParts.push(v)
	}

	if (streetParts.length > 0) out.street = streetParts.join(" ")
	const xs: string[] = []

	if (flat.intersection_a) xs.push(flat.intersection_a)

	if (flat.intersection_b) xs.push(flat.intersection_b)

	if (xs.length > 0) out.street = [out.street, ...xs].filter(Boolean).join(" ")

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

		if (value) out[tag] = value
	}

	return out
}

const norm = (v: string | undefined): string => (v ?? "").trim().toLowerCase()

function exactMatch(pred: Record<string, string>, gold: Record<string, string>): boolean {
	const keys = new Set([...Object.keys(pred), ...Object.keys(gold)])

	for (const k of keys) if (norm(pred[k]) !== norm(gold[k])) return false

	return true
}

// -------------------------------------------------------------------------------------------------
// Per-file metrics
// -------------------------------------------------------------------------------------------------

interface TagMetric {
	tp: number
	fp: number
	fn: number
	p: number
	r: number
	f1: number
}
interface FileReport {
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

	for (const r of rows) for (const k of Object.keys(r.components)) tags.add(k)

	for (const p of preds) for (const k of Object.keys(p)) tags.add(k)

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

			if (pred && gold && pred === gold) tp++
			else if (pred && (!gold || pred !== gold)) fp++

			if (gold && (!pred || pred !== gold)) fn++
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

	for (let i = 0; i < rows.length; i++) if (exactMatch(preds[i]!, rows[i]!.components)) exact++

	return {
		file,
		n: rows.length,
		exactMatch: exact,
		exactRate: exact / Math.max(rows.length, 1),
		macroF1: tags.size > 0 ? f1Sum / tags.size : 0,
		microF1,
		perTag,
	}
}

// -------------------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs()
	console.error("--- per-locale-f1.ts ---")
	console.error("Golden dir:", args.goldenDir)
	console.error("Files:     ", args.files.join(", "))
	console.error("Model:     ", args.modelPath ?? "(default weights)")

	let neural: NeuralAddressClassifier

	// FOOTGUN GUARD: if ANY custom-model flag is set, ALL THREE are required. Previously a missing
	// --tokenizer silently fell back to the DEFAULT shipped weights, so --model was ignored and two
	// different checkpoints scored byte-identical. Refuse to guess; fail loud.
	if (args.modelPath || args.tokenizerPath || args.modelCardPath) {
		if (!args.modelPath || !args.tokenizerPath || !args.modelCardPath) {
			throw new Error(
				"--model requires --tokenizer AND --model-card together (refusing to silently fall back to " +
					`default weights). got: model=${!!args.modelPath} tokenizer=${!!args.tokenizerPath} model-card=${!!args.modelCardPath}`
			)
		}
		const card = JSON.parse(readFileSync(args.modelCardPath, "utf8"))
		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(args.tokenizerPath),
			OnnxRunner.create(args.modelPath),
		])
		// Anchor + gazetteer feed. DEFAULT-ON (the standard paths) so an anchor-trained model is scored
		// in-distribution — see the DEFAULT_* note above for why omitting these silently collapses the
		// admin tags. `--no-anchor` opts out; an explicit `--model-anchor-lookup`/`--gazetteer-lexicon`
		// overrides the default path. The runner harmlessly skips inputs a plainer ONNX doesn't declare.
		const anchorLookupPath = args.noAnchor ? undefined : (args.modelAnchorLookupPath ?? DEFAULT_ANCHOR_LOOKUP)
		const gazetteerLexiconPath = args.noAnchor ? undefined : (args.gazetteerLexiconPath ?? DEFAULT_GAZETTEER_LEXICON)
		const postcodeAnchorLookup =
			anchorLookupPath && existsSync(anchorLookupPath)
				? parseAnchorLookup(JSON.parse(readFileSync(anchorLookupPath, "utf8")))
				: undefined
		// Gazetteer-anchor lexicon (#464): fed so a gazetteer-trained model gets its clues. Harmless for
		// older models (the runner skips inputs the ONNX lacks).
		const gazetteerLexicon =
			gazetteerLexiconPath && existsSync(gazetteerLexiconPath)
				? parseGazetteerLexicon(JSON.parse(readFileSync(gazetteerLexiconPath, "utf8")))
				: undefined
		console.error(
			`Anchor:     ${postcodeAnchorLookup ? `${anchorLookupPath} (${postcodeAnchorLookup.size} codes)` : args.noAnchor ? "(off — --no-anchor)" : `(none found at ${anchorLookupPath})`}`
		)
		console.error(
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
		let rows: GoldenRow[]

		try {
			rows = readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		} catch (err) {
			console.error(`  skip ${file}: ${(err as Error).message}`)
			continue
		}
		const preds: Array<Record<string, string>> = []
		const t0 = performance.now()
		// MAILWOMAN_DUMP_MISS_TAG=<tag>: print every row where gold has <tag> but the prediction
		// differs (false-neg or mislabel). A diagnostic lens for "which surfaces does the model drop"
		// — added for the #560 fr.house_number investigation; harmless when the env is unset.
		const dumpTag = process.env.MAILWOMAN_DUMP_MISS_TAG

		for (const row of rows) {
			const tree = await neural.parse(
				row.raw,
				process.env.MAILWOMAN_WORD_CONSISTENCY === "1" ? { enforceWordConsistency: true } : {}
			)
			const pred = foldToComponents(decodeAsJson(tree))
			preds.push(pred)

			if (dumpTag) {
				const gold = (row as { components?: Record<string, string> }).components?.[dumpTag]

				if (gold && gold !== pred[dumpTag]) {
					console.error(
						`MISS[${dumpTag}] ${basename(file, ".jsonl")} raw=${JSON.stringify(row.raw)} gold=${JSON.stringify(gold)} pred=${JSON.stringify(pred[dumpTag] ?? null)} all=${JSON.stringify(pred)}`
					)
				}
			}
		}
		const rep = scoreFile(basename(file, ".jsonl"), rows, preds)
		reports.push(rep)
		console.error(
			`  ${file}: n=${rep.n} macroF1=${(100 * rep.macroF1).toFixed(1)}% in ${((performance.now() - t0) / 1000).toFixed(1)}s`
		)
	}

	// Report
	const localeReports = reports.filter((r) => r.file !== "adversarial")
	const macroF1s = localeReports.map((r) => r.macroF1)
	const spread = macroF1s.length > 1 ? Math.max(...macroF1s) - Math.min(...macroF1s) : 0

	console.log("# Per-locale F1 tripwire\n")
	console.log("| Locale | n | Macro-F1 | Micro-F1 | Exact-match |")
	console.log("|---|--:|--:|--:|--:|")

	for (const r of reports) {
		console.log(
			`| ${r.file} | ${r.n} | ${(100 * r.macroF1).toFixed(1)}% | ${(100 * r.microF1).toFixed(1)}% | ${(100 * r.exactRate).toFixed(1)}% |`
		)
	}
	console.log("")
	console.log(`**Cross-locale macro-F1 spread (interference signal):** ${(100 * spread).toFixed(1)}pp`)
	console.log("")

	// Per-tag F1 side by side across the locale files (where the interference, if any, concentrates)
	const allTags = new Set<string>()

	for (const r of localeReports) for (const k of Object.keys(r.perTag)) allTags.add(k)
	console.log("## Per-tag F1 by locale\n")
	console.log(`| Tag | ${localeReports.map((r) => r.file).join(" | ")} | Δ |`)
	console.log(`|---|${localeReports.map(() => "--:").join("|")}|--:|`)

	for (const tag of [...allTags].sort()) {
		const cells = localeReports.map((r) => r.perTag[tag])
		const f1s = cells.map((c) => (c ? c.f1 : 0))
		const delta = f1s.length > 1 ? Math.max(...f1s) - Math.min(...f1s) : 0
		console.log(
			`| ${tag} | ${cells.map((c) => (c ? (100 * c.f1).toFixed(1) + "%" : "—")).join(" | ")} | ${(100 * delta).toFixed(1)}pp |`
		)
	}
	console.log("")

	if (args.outJson) {
		writeFileSync(args.outJson, JSON.stringify({ reports, spread }, null, 2))
		console.error(`Wrote ${args.outJson}`)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
