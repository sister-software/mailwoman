/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-release mask-regression check (#718) — the "second lock", paired with the load-time
 *   capability-manifest delta check shipped in `neural/scorer.ts`
 *   (`assertConventionsRespectCapabilities`).
 *
 *   What it adds over the load-time delta check (and why two locks):
 *
 *   - The LOAD-TIME delta check (createScorer) is REACTIVE + COARSE: it consults the model card's
 *       `capabilities` block and rejects only a conventions mask that forbids a tag the card
 *       CERTIFIES, at a 5pp `maskOffF1 − maskOnF1` threshold. It fires only on EXPLICITLY-forbidden
 *       tags, and only against pre-recorded numbers — it can't see a tag the mask harms INDIRECTLY
 *       (e.g. forbidding `street_suffix` shifts probability mass and depresses `street`), nor a
 *       regression on a tag no `forbiddenTags` row names.
 *   - THIS gate is PROACTIVE + FINE: it RE-RUNS the model (mask-off vs mask-auto/on) per locale under
 *       the full SHIP-CONFIG (anchor-on + gazetteer-on) and FAILS if ANY tag's F1 drops by more
 *       than a TIGHTER 2pp threshold (per the DeepSeek consult) under the conventions mask —
 *       catching the subtler interaction harms the per-tag 5pp delta check would miss.
 *
 *   It is WEIGHT-DEPENDENT (it runs the model), so it is a RELEASE GATE — run with weights on disk
 *   BEFORE publishing — NOT a weightless CI step (weight-dependent tests don't run in CI; #582).
 *   Hook it into the release path (`mailwoman eval gate` / the publish flow), NOT into Test CI.
 *
 *   Mechanics: reuses the `capability-manifest.ts` scoring implementation verbatim — `createScorer` (so
 *   the channel feed matches the ship config, the #566/#685 trap) with `overrides.conventions`
 *   toggling mask off vs auto, and the UNFOLDED exact-match per-tag F1 from `score-affix.ts`
 *   (street parts split, so an affix regression is visible — the folded `per-locale-f1.ts` can't
 *   see it). The DIFFERENCE from the manifest generator: that one records `maskOnF1` only for
 *   codex-forbidden tags (the only tags the LOAD-TIME gate reads); THIS gate computes the delta for
 *   EVERY tag, because a mask can harm a tag no `forbiddenTags` row names.
 *
 *   Run (Node 26+, custom DB / anchor-on, the production default v1.5.0 int8):
 *
 *   `mailwoman eval mask-regression --model <int8.onnx> --tokenizer <spm> --model-card <json>`
 *
 *   PASS = no tag regresses more than the threshold under the mask; FAIL = at least one tag
 *   regresses (the offending `(locale, tag, maskOff, maskOn, delta)` rows are printed).
 *
 *   `threshold` overrides the default 0.02 (2pp). `json` writes the full per-tag delta table (every
 *   locale × tag, not just violations) for the release record. All narration goes through the
 *   `report` sink (stderr by default) — `promotion-gate.ts` captures it into
 *   `<out-dir>/mask-regression.md`.
 */

import type { SystemCode } from "@mailwoman/codex"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"

import {
	loadPerTagEvalRows,
	MASK_EVAL_LOCALES,
	rowsHaveTag,
	scoreConventionsMaskOffOn,
	UNFOLDED_ADDRESS_TAGS,
} from "#eval-harness/per-tag-f1"

/**
 * Options for {@linkcode maskRegressionGate}.
 */
export interface MaskRegressionOptions {
	/**
	 * ONNX artifact. Default: the production v1.5.0 int8 under `$MAILWOMAN_DATA_ROOT`.
	 */
	model?: string
	/**
	 * SentencePiece tokenizer. Default: the v0.6.0-a0 tokenizer under `$MAILWOMAN_DATA_ROOT`.
	 */
	tokenizer?: string
	/**
	 * Model card JSON. Default `neural-weights-en-us/model-card.json`.
	 */
	modelCard?: string
	/**
	 * Anchor lookup JSON. Default: the pilot lookup under `$MAILWOMAN_DATA_ROOT`.
	 */
	anchorLookup?: string
	/**
	 * Gazetteer lexicon JSON. Default `data/gazetteer/anchor-lexicon-v1.json`.
	 */
	gazetteerLexicon?: string
	/**
	 * The regression threshold (pp, as a fraction). Per the DeepSeek consult, 2pp — a FINER net than the load-time delta
	 * check's 5pp, so subtler interaction harms surface at release. A tag whose mask-on F1 is within this band of its
	 * mask-off F1 is considered unharmed by the mask. Default 0.02.
	 */
	threshold?: number
	/**
	 * Write the full per-tag delta table JSON here.
	 */
	json?: string
}

//#region Locale matrix (mirrors capability-manifest.ts)

/**
 * The per-tag vocabulary scored, UNFOLDED (street parts split — mirrors score-affix.ts / capability-manifest.ts). Every
 * tag here gets a mask-off↔mask-on delta computed.
 */
const TAGS = UNFOLDED_ADDRESS_TAGS

//#endregion

//#region The check

interface Delta {
	locale: SystemCode
	tag: string
	maskOff: number
	maskOn: number
	/**
	 * MaskOff − maskOn, in pp. Positive = the mask HURT the tag.
	 */
	delta: number
	/**
	 * Whether this tag is even in scope (any gold row carries it under this locale).
	 */
	inScope: boolean
}

/**
 * Run the mask-off vs mask-on per-tag battery. Returns `pass` (no tag regresses beyond the threshold).
 */
export async function maskRegressionGate(
	options: MaskRegressionOptions = {},
	report: (line: string) => void = console.error
): Promise<{ pass: boolean; violations: Delta[] }> {
	const MODEL = options.model || String(dataRootPath("models", "quantized", "model-v150-step-40000-int8.onnx"))
	const TOKENIZER = options.tokenizer || String(dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"))
	const MODEL_CARD = options.modelCard || "packages/neural-weights-en-us/model-card.json"
	const ANCHOR_LOOKUP = options.anchorLookup || String(dataRootPath("anchor", "pilot-anchor-lookup.json"))
	const GAZETTEER_LEXICON = options.gazetteerLexicon || "data/gazetteer/anchor-lexicon-v1.json"
	const JSON_OUT = options.json || ""
	const THRESHOLD = options.threshold ?? 0.02

	for (const p of [MODEL, TOKENIZER, MODEL_CARD]) {
		if (!(await pathExists(p))) throw new Error(`required artifact not found: ${p}`)
	}

	report(`mask-regression-gate (#718): threshold ${(THRESHOLD * 100).toFixed(1)}pp`)
	report(`  model      ${MODEL}`)
	report(`  tokenizer  ${TOKENIZER}`)
	report(`  model-card ${MODEL_CARD}`)

	const deltas: Delta[] = []

	for (const spec of MASK_EVAL_LOCALES) {
		const rows = await loadPerTagEvalRows(spec.files)
		report(`\n[${spec.system}] n=${rows.length} (${spec.files.join(", ")})`)

		// Default input mode ON PURPOSE — the capability-manifest generator's `inputMode: "formatted"`
		// is a deliberate, score-relevant divergence (see `MaskOffOnOptions.inputMode`); this release
		// check grades the default parse path.
		const { off, on } = await scoreConventionsMaskOffOn(rows, TAGS, {
			modelPath: MODEL,
			tokenizerPath: TOKENIZER,
			modelCardPath: MODEL_CARD,
			anchorLookupPath: ANCHOR_LOOKUP,
			gazetteerLexiconPath: GAZETTEER_LEXICON,
		})

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
	report(`\n--- per-tag mask-off vs mask-on F1 (in-scope tags) ---`)
	report(`  locale  tag                    maskOff   maskOn     Δpp`)

	for (const d of deltas) {
		if (!d.inScope) continue
		const flag = d.delta > THRESHOLD * 100 ? "  ✗ REGRESSION" : ""

		report(
			`  ${d.locale.padEnd(6)}  ${d.tag.padEnd(20)}  ${String(d.maskOff).padStart(7)}  ${String(d.maskOn).padStart(7)}  ${(d.delta >= 0 ? "+" : "") + d.delta.toFixed(1).padStart(5)}${flag}`
		)
	}

	// --- the assertion: no tag may regress more than the threshold under the mask -----------------
	const thresholdPp = THRESHOLD * 100
	const violations = deltas.filter((d) => d.inScope && d.delta > thresholdPp)

	if (JSON_OUT) {
		await writeLocalJSONFile(
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
			JSON_OUT
		)

		report(`\nWrote per-tag delta table → ${JSON_OUT}`)
	}

	if (violations.length) {
		report(
			`\n✗ FAIL — ${violations.length} tag(s) regress more than ${thresholdPp.toFixed(1)}pp under the conventions mask:`
		)

		for (const v of violations) {
			report(
				`  (${v.locale}, ${v.tag}): maskOff ${v.maskOff} → maskOn ${v.maskOn}  Δ=${v.delta.toFixed(1)}pp > ${thresholdPp.toFixed(1)}pp`
			)
		}

		report(
			`\nThe conventions mask provably harms a tag the model emits. Either narrow the codex ` +
				`forbiddenTags for the offending locale, or re-certify and prove the mask is benign.`
		)

		return { pass: false, violations }
	}

	report(
		`\n✓ PASS — no tag regresses more than ${thresholdPp.toFixed(1)}pp under the conventions mask ` +
			`(${MASK_EVAL_LOCALES.length} locale(s), ${TAGS.length} tags each).`
	)

	return { pass: true, violations }
}

//#endregion
