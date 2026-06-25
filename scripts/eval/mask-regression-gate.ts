/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-release mask-regression gate (#718) — the "second lock", paired with the load-time
 *   capability-manifest delta-gate shipped in `neural/scorer.ts`
 *   (`assertConventionsRespectCapabilities`).
 *
 *   What it adds over the load-time delta-gate (and why two locks):
 *
 *   - The LOAD-TIME delta-gate (createScorer) is REACTIVE + COARSE: it consults the model card's
 *       `capabilities` block and rejects only a conventions mask that forbids a tag the card
 *       CERTIFIES, at a 5pp `maskOffF1 − maskOnF1` threshold. It fires only on EXPLICITLY-forbidden
 *       tags, and only against pre-recorded numbers — it can't see a tag the mask harms INDIRECTLY
 *       (e.g. forbidding `street_suffix` shifts probability mass and depresses `street`), nor a
 *       regression on a tag no `forbiddenTags` row names.
 *   - THIS gate is PROACTIVE + FINE: it RE-RUNS the model (mask-off vs mask-auto/on) per locale under
 *       the full SHIP-CONFIG (anchor-on + gazetteer-on) and FAILS if ANY tag's F1 drops by more
 *       than a TIGHTER 2pp threshold (per the DeepSeek consult) under the conventions mask —
 *       catching the subtler interaction harms the per-tag 5pp delta-gate would miss.
 *
 *   It is WEIGHT-DEPENDENT (it runs the model), so it is a RELEASE GATE — run with weights on disk
 *   BEFORE publishing — NOT a weightless CI step (weight-dependent tests don't run in CI; #582).
 *   Hook it into the release path (scripts/eval/promotion-gate.sh / the publish flow), NOT into
 *   Test CI.
 *
 *   Mechanics: reuses the `gen-capability-manifest.ts` scoring machinery verbatim — `createScorer`
 *   (so the channel feed matches the ship config, the #566/#685 trap) with `overrides.conventions`
 *   toggling mask off vs auto, and the UNFOLDED exact-match per-tag F1 from `score-affix.ts`
 *   (street parts split, so an affix regression is visible — the folded `per-locale-f1.ts` can't
 *   see it). The DIFFERENCE from the manifest generator: that one records `maskOnF1` only for
 *   codex-forbidden tags (the only tags the LOAD-TIME gate reads); THIS gate computes the delta for
 *   EVERY tag, because a mask can harm a tag no `forbiddenTags` row names.
 *
 *   Run (Node 26+, custom DB / anchor-on, the production default v1.5.0 int8):
 *
 *   Node --experimental-strip-types scripts/eval/mask-regression-gate.ts\
 *   --model $MAILWOMAN_DATA_ROOT/models/quantized/model-v150-step-40000-int8.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json
 *
 *   Exit 0 = no tag regresses more than the threshold under the mask (PASS). Exit 1 = at least one
 *   tag regresses (the offending `(locale, tag, maskOff, maskOn, delta)` rows are printed).
 *
 *   `--threshold <pp>` overrides the default 0.02 (2pp). `--json <path>` writes the full per-tag
 *   delta table (every locale × tag, not just violations) for the release record.
 */

import type { SystemCode } from "@mailwoman/codex"
import { decodeAsJson } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import type { NeuralAddressClassifier } from "@mailwoman/neural"
import { createScorer } from "@mailwoman/neural/scorer"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { arg } from "../lib/cli-args.ts"

// -------------------------------------------------------------------------------------------------
// Args
// -------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2)

const MODEL = arg("model", dataRootPath("models", "quantized", "model-v150-step-40000-int8.onnx"))!
const TOKENIZER = arg("tokenizer", dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"))!
const MODEL_CARD = arg("model-card", "neural-weights-en-us/model-card.json")!
const ANCHOR_LOOKUP = arg("anchor-lookup", dataRootPath("anchor", "pilot-anchor-lookup.json"))!
const GAZETTEER_LEXICON = arg("gazetteer-lexicon", "data/gazetteer/anchor-lexicon-v1.json")!
const JSON_OUT = arg("json")

/**
 * The regression threshold (pp, as a fraction). Per the DeepSeek consult, 2pp — a FINER net than
 * the load-time delta-gate's 5pp, so subtler interaction harms surface at release. A tag whose
 * mask-on F1 is within this band of its mask-off F1 is considered unharmed by the mask.
 */
const THRESHOLD = Number(arg("threshold", "0.02"))

// -------------------------------------------------------------------------------------------------
// Locale matrix (mirrors gen-capability-manifest.ts)
// -------------------------------------------------------------------------------------------------

interface LocaleEvalSpec {
	/** The codex address-system this locale maps to (`us`, `fr`, …). */
	system: SystemCode
	/** Eval JSONL files (raw + components). Multiple files are concatenated. */
	files: string[]
}

// Same eval specs as the manifest generator. FR uses the dedicated street-prefix slice
// (`fr-street-prefix-real.jsonl`, the #719 reproduction) so the essential affix capability is
// measurable — on the broad golden FR set the unfolded `street_prefix` F1 is dominated by absent-gold
// rows and would under-measure the very capability this gate protects.
const LOCALES: LocaleEvalSpec[] = [
	{ system: "us", files: ["data/eval/golden/v0.1.2/dev/us.jsonl"] },
	{ system: "fr", files: ["data/eval/external/fr-street-prefix-real.jsonl"] },
]

// The per-tag vocabulary scored, UNFOLDED (street parts split — mirrors score-affix.ts /
// gen-capability-manifest.ts). Every tag here gets a mask-off↔mask-on delta computed.
const TAGS = [
	"street_prefix",
	"street",
	"street_suffix",
	"house_number",
	"locality",
	"region",
	"postcode",
	"country",
	"unit",
	"intersection_a",
	"intersection_b",
	"po_box",
	"cedex",
	"venue",
	"dependent_locality",
	"subregion",
] as const

// -------------------------------------------------------------------------------------------------
// Scoring (unfolded exact-match per-tag F1 — score-affix.ts / gen-capability-manifest.ts machinery)
// -------------------------------------------------------------------------------------------------

interface Row {
	raw: string
	components: Record<string, string>
}

function loadRows(files: string[]): Row[] {
	const rows: Row[] = []
	for (const f of files) {
		if (!existsSync(f)) throw new Error(`eval file not found: ${f}`)
		for (const line of readFileSync(f, "utf8").split("\n")) {
			if (!line.trim()) continue
			rows.push(JSON.parse(line) as Row)
		}
	}
	return rows
}

const norm = (s?: string): string => (s ?? "").trim().toLowerCase()

/** Whether any gold row carries this tag — distinguishes a real 0 F1 from a tag never in scope. */
function rowsHaveTag(rows: Row[], tag: string): boolean {
	for (const r of rows) if (norm(r.components[tag])) return true
	return false
}

/** Per-tag exact-match F1 (percent, 1-decimal) over the rows. Mirrors score-affix.ts. */
async function perTagF1(neural: NeuralAddressClassifier, rows: Row[]): Promise<Record<string, number>> {
	const stat: Record<string, { tp: number; fp: number; fn: number }> = {}
	for (const t of TAGS) stat[t] = { tp: 0, fp: 0, fn: 0 }
	for (const row of rows) {
		const got = decodeAsJson(await neural.parse(row.raw)) as Record<string, string>
		const exp = row.components
		for (const t of TAGS) {
			const e = norm(exp[t])
			const g = norm(got[t])
			if (e && g && e === g) stat[t]!.tp++
			else {
				if (g) stat[t]!.fp++
				if (e) stat[t]!.fn++
			}
		}
	}
	const out: Record<string, number> = {}
	for (const t of TAGS) {
		const { tp, fp, fn } = stat[t]!
		const p = tp + fp ? tp / (tp + fp) : 0
		const r = tp + fn ? tp / (tp + fn) : 0
		const f1 = p + r ? (2 * p * r) / (p + r) : 0
		out[t] = +(100 * f1).toFixed(1)
	}
	return out
}

// -------------------------------------------------------------------------------------------------
// The gate
// -------------------------------------------------------------------------------------------------

interface Delta {
	locale: SystemCode
	tag: string
	maskOff: number
	maskOn: number
	/** MaskOff − maskOn, in pp. Positive = the mask HURT the tag. */
	delta: number
	/** Whether this tag is even in scope (any gold row carries it under this locale). */
	inScope: boolean
}

async function run(): Promise<number> {
	for (const p of [MODEL, TOKENIZER, MODEL_CARD]) {
		if (!existsSync(p)) throw new Error(`required artifact not found: ${p}`)
	}

	console.error(`mask-regression-gate (#718): threshold ${(THRESHOLD * 100).toFixed(1)}pp`)
	console.error(`  model      ${MODEL}`)
	console.error(`  tokenizer  ${TOKENIZER}`)
	console.error(`  model-card ${MODEL_CARD}`)

	const deltas: Delta[] = []

	for (const spec of LOCALES) {
		const rows = loadRows(spec.files)
		console.error(`\n[${spec.system}] n=${rows.length} (${spec.files.join(", ")})`)

		// Full SHIP-CONFIG otherwise (anchor-on + gazetteer-on — createScorer's defaults). Only the
		// conventions channel toggles. `strict: true` fails closed if a declared channel can't be fed,
		// so a stale/incomplete feed surfaces loudly rather than silently grading a handicapped model.
		const base = {
			modelPath: MODEL,
			tokenizerPath: TOKENIZER,
			modelCardPath: MODEL_CARD,
			anchorLookupPath: ANCHOR_LOOKUP,
			gazetteerLexiconPath: GAZETTEER_LEXICON,
			strict: true as const,
		}

		// mask-OFF: conventions disabled (the model's raw capability). createScorer warns about the
		// declared-required override — expected.
		const offScorer = await createScorer({ ...base, overrides: { conventions: false } })
		const off = await perTagF1(offScorer, rows)

		// mask-ON: conventions in `auto` mode (locale-head detection → the detected system's
		// forbiddenTags applied as a hard emission mask). The SHIP behavior whose damage we measure.
		const onScorer = await createScorer({ ...base, overrides: { conventions: "auto" } })
		const on = await perTagF1(onScorer, rows)

		for (const tag of TAGS) {
			const inScope = rowsHaveTag(rows, tag) || off[tag]! > 0 || on[tag]! > 0
			deltas.push({
				locale: spec.system,
				tag,
				maskOff: off[tag]!,
				maskOn: on[tag]!,
				delta: +(off[tag]! - on[tag]!).toFixed(1),
				inScope,
			})
		}
	}

	// --- report the full per-tag delta table (every in-scope tag) ---------------------------------
	console.error(`\n--- per-tag mask-off vs mask-on F1 (in-scope tags) ---`)
	console.error(`  locale  tag                    maskOff   maskOn     Δpp`)
	for (const d of deltas) {
		if (!d.inScope) continue
		const flag = d.delta > THRESHOLD * 100 ? "  ✗ REGRESSION" : ""
		console.error(
			`  ${d.locale.padEnd(6)}  ${d.tag.padEnd(20)}  ${String(d.maskOff).padStart(7)}  ${String(d.maskOn).padStart(7)}  ${(d.delta >= 0 ? "+" : "") + d.delta.toFixed(1).padStart(5)}${flag}`
		)
	}

	// --- the assertion: no tag may regress more than the threshold under the mask -----------------
	const thresholdPp = THRESHOLD * 100
	const violations = deltas.filter((d) => d.inScope && d.delta > thresholdPp)

	if (JSON_OUT) {
		writeFileSync(
			JSON_OUT,
			JSON.stringify(
				{
					gate: "mask-regression-gate",
					issue: 718,
					thresholdPp,
					model: MODEL,
					tokenizer: TOKENIZER,
					modelCard: MODEL_CARD,
					pass: violations.length === 0,
					deltas: deltas.filter((d) => d.inScope),
					violations,
				},
				null,
				"\t"
			)
		)
		console.error(`\nWrote per-tag delta table → ${JSON_OUT}`)
	}

	if (violations.length > 0) {
		console.error(
			`\n✗ FAIL — ${violations.length} tag(s) regress more than ${thresholdPp.toFixed(1)}pp under the conventions mask:`
		)
		for (const v of violations) {
			console.error(
				`  (${v.locale}, ${v.tag}): maskOff ${v.maskOff} → maskOn ${v.maskOn}  Δ=${v.delta.toFixed(1)}pp > ${thresholdPp.toFixed(1)}pp`
			)
		}
		console.error(
			`\nThe conventions mask provably harms a tag the model emits. Either narrow the codex ` +
				`forbiddenTags for the offending locale, or re-certify and prove the mask is benign.`
		)
		return 1
	}

	console.error(
		`\n✓ PASS — no tag regresses more than ${thresholdPp.toFixed(1)}pp under the conventions mask ` +
			`(${LOCALES.length} locale(s), ${TAGS.length} tags each).`
	)
	return 0
}

process.exit(await run())
