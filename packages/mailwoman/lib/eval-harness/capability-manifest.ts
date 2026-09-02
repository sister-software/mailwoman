/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Capability-manifest generator (#718 / #719) — the measurement half of the load-time delta check.
 *
 *   The structural fix for the D2/#719 bug-class (a conventions mask destroying a capability the
 *   model demonstrably HAS): the model card declares, PER TIER × PER address-system × PER tag, the
 *   model's measured per-tag F1 with the conventions mask OFF, plus the mask-ON F1 for any tag a
 *   codex `forbiddenTags` row would suppress. The `createScorer` loader (neural/scorer.ts) reads
 *   this `capabilities` block and FAILS CLOSED when a conventions mask would forbid a tag the model
 *   is CERTIFIED to emit — gated by a DELTA (`maskOffF1 − maskOnF1 > 5pp`), not an absolute floor,
 *   so a tag the model emits at 0.80 is still protected if the mask drops it to 0.0 (the exact #719
 *   shape: FR `street_prefix` collapsed 80.0 → 0.0 under the old blanket prefix+suffix forbid).
 *
 *   Tiers (the two SHIP-CONFIGs the model is fed under):
 *
 *   - `server`: anchor + gazetteer channels ON (the production default — what `createScorer` builds).
 *   - `pocket`: anchor ON, gazetteer OFF (the lighter on-device feed; not yet a serving target).
 *
 *   For each tier × locale × {mask-off, mask-on} we run the model and compute UNFOLDED exact-match
 *   per-tag F1 (same implementation as `score-affix.ts` — split `street_prefix`/`street`/`street_suffix`
 *   so the affix capability is measurable, which the folded `per-locale-f1.ts` cannot see). The
 *   classifier is built via the canonical `createScorer` so the channel feed matches the ship
 *   config (the #566/#685 trap), with `overrides.conventions` toggling mask off/on and
 *   `overrides.gazetteer` selecting the tier.
 *
 *   Run (Node 26+, custom DB / anchor-on, the production default v1.5.0 int8):
 *
 *   Mailwoman eval capability-manifest\
 *   --model $MAILWOMAN_DATA_ROOT/models/quantized/model-v150-step-40000-int8.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json\
 *   --write
 *
 *   `--write` patches the `capabilities` block into the card (additive metadata, tabs preserved);
 *   omit it for a dry run that only prints the block.
 */

import { ADDRESS_SYSTEM_CONVENTIONS } from "@mailwoman/codex"
import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, prettyJSON } from "@mailwoman/core/objects"
import type { ScorerOverrides } from "@mailwoman/neural/scorer"

import {
	loadPerTagEvalRows,
	MASK_EVAL_LOCALES,
	rowsHaveTag,
	scoreConventionsMaskOffOn,
	UNFOLDED_ADDRESS_TAGS,
} from "#eval-harness/per-tag-f1"

/**
 * Options for {@linkcode generateCapabilityManifest}.
 */
export interface CapabilityManifestOptions {
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
	 * Surgically insert the `capabilities` block into the model card (else dry run).
	 */
	write?: boolean
}

//#region Tier + locale matrix

/**
 * Serving tiers and their channel feed (vs the model-card SHIP-CONFIG, expressed as overrides).
 */
const TIERS: Record<string, ScorerOverrides> = {
	// Production default — anchor + gazetteer both fed (no override needed; createScorer's defaults).
	server: {},
	// On-device lighter feed — anchor on, gazetteer ablated. `overrides.gazetteer:false` warns loudly
	// (a DECLARED ablation), which is correct: pocket is a deliberate below-ship-config tier.
	pocket: { gazetteer: false },
}

/**
 * The per-tag vocabulary scored, UNFOLDED (street parts split — mirrors score-affix.ts).
 */
const TAGS = UNFOLDED_ADDRESS_TAGS

/**
 * The union of every tag any codex conventions row forbids — the ONLY tags the loader's delta check reads, so the ONLY
 * tags that NEED a paired `maskOnF1`. Derived from the codex so a new forbid row automatically widens the manifest the
 * next time it's regenerated.
 */
const FORBIDDEN_TAGS: Set<string> = new Set(
	Object.values(ADDRESS_SYSTEM_CONVENTIONS).flatMap((c) => c?.forbiddenTags ?? [])
)

//#endregion

//#region Build the manifest

/**
 * `{ maskOffF1, maskOnF1? }` — maskOnF1 present only for forbidden-set tags the model emits.
 */
interface TagCapability {
	maskOffF1: number
	maskOnF1?: number
}

type Capabilities = Record<string, Record<string, Record<string, TagCapability>>>

interface ResolvedPaths {
	model: string
	tokenizer: string
	modelCard: string
	anchorLookup: string
	gazetteerLexicon: string
}

async function buildManifest(paths: ResolvedPaths): Promise<Capabilities> {
	const capabilities: Capabilities = {}

	for (const [tier, tierOverrides] of Object.entries(TIERS)) {
		capabilities[tier] = {}

		for (const spec of MASK_EVAL_LOCALES) {
			const rows = await loadPerTagEvalRows(spec.files)

			console.error(`\n[${tier}/${spec.system}] n=${rows.length} (${spec.files.join(", ")})`)

			// The generator constructs its scorers WHILE the card's `capabilities` block may not yet
			// exist; the loader's delta check is a no-op until the block is written. After a `--write`,
			// regenerating uses the already-written block, but mask-OFF construction never trips the
			// gate (it only fires for a forbidden CERTIFIED tag, and mask-off forbids none).
			// `inputMode: "formatted"` is deliberate and score-relevant: certification probes are
			// formatted postal addresses, whose production path disables evidence-bundle channels.
			const { off, on } = await scoreConventionsMaskOffOn(
				rows,
				TAGS,
				{
					modelPath: paths.model,
					tokenizerPath: paths.tokenizer,
					modelCardPath: paths.modelCard,
					anchorLookupPath: paths.anchorLookup,
					gazetteerLexiconPath: paths.gazetteerLexicon,
				},
				{ tierOverrides, inputMode: "formatted" }
			)

			const perTag: Record<string, TagCapability> = {}

			for (const t of TAGS) {
				// Skip tags the model never emits AND never sees in gold under either mask — a 0/0 F1 is
				// not a capability claim, just noise. (maskOffF1 0 with the tag genuinely present in gold
				// IS a real claim and is kept.)
				if (off[t] === 0 && on[t] === 0 && !rowsHaveTag(rows, t)) continue
				const cap: TagCapability = { maskOffF1: off[t]! }

				// maskOnF1 only for forbidden-set tags — the only tags the loader's delta check consults.
				if (FORBIDDEN_TAGS.has(t)) {
					cap.maskOnF1 = on[t]!
				}

				perTag[t] = cap
			}

			capabilities[tier]![spec.system] = perTag

			// Diagnostic: surface the forbidden-tag deltas (the decisive rows).
			for (const t of FORBIDDEN_TAGS) {
				if (perTag[t]) {
					const delta = (perTag[t]!.maskOffF1 - (perTag[t]!.maskOnF1 ?? 0)).toFixed(1)

					console.error(`  forbid-tag ${t}: maskOff ${off[t]} maskOn ${on[t]}  Δ=${delta}pp`)
				}
			}
		}
	}

	return capabilities
}

//#endregion

//#region Entry

/**
 * Measure the per-tier × system × tag capability manifest; optionally patch it into the model card.
 */
export async function generateCapabilityManifest(options: CapabilityManifestOptions = {}): Promise<void> {
	const paths: ResolvedPaths = {
		model: options.model || String(dataRootPath("models", "quantized", "model-v150-step-40000-int8.onnx")),
		tokenizer: options.tokenizer || String(dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")),
		modelCard: options.modelCard || "packages/neural-weights-en-us/model-card.json",
		anchorLookup: options.anchorLookup || String(dataRootPath("anchor", "pilot-anchor-lookup.json")),
		gazetteerLexicon: options.gazetteerLexicon || "data/gazetteer/anchor-lexicon-v1.json",
	}

	const WRITE = options.write ?? false

	const capabilities = await buildManifest(paths)

	console.log("\n--- capabilities block ---")
	console.log(prettyJSON({ capabilities }))

	if (WRITE) {
		// Provenance key alongside the tier keys; ignored by readers (`lookupTagCapability` skips it).
		;(capabilities as Record<string, unknown>).$comment =
			"Per-tier (server=anchor+gazetteer; pocket=anchor-only) × address-system × tag capability " +
			"manifest (#718/#719). maskOffF1 = measured per-tag exact-match F1 with the conventions mask " +
			"OFF; maskOnF1 = the same with mask ON (recorded only for tags some codex forbiddenTags row " +
			"suppresses — the loader's delta check consults only those). createScorer FAILS CLOSED when a " +
			"conventions row forbids a tag with maskOffF1 − maskOnF1 > 0.05 (the mask provably destroys a " +
			"real capability). Generated by `mailwoman eval capability-manifest` against the v1.5.0 int8."

		// SURGICAL insert (not a JSON round-trip): the shipped card hand-formats compact inline objects
		// (`"anchor": { "required": true }`) that a `JSON.stringify` would expand, spuriously reordering a
		// shipped artifact. Instead, append ONE new top-level key, byte-preserving everything else. The
		// card is validated JSON, so its tail is `…\n}\n` (root close); we splice `,\n\t"capabilities":…`
		// before that final brace, one indent level deep (each block line tab-prefixed).
		const original = await readLocalTextFile(paths.modelCard)
		const lastBrace = original.lastIndexOf("}")

		if (lastBrace === -1) throw new Error(`model-card has no closing brace: ${paths.modelCard}`)

		// Strict, not tolerant: a corrupt model card must abort the splice rather than read as
		// "no capabilities block" and append a second one.
		if (parseJSONStrict<{ capabilities?: unknown }>(original).capabilities !== undefined) {
			// Idempotency guard: a prior write left a block. A text-splice would duplicate the key, so refuse.
			throw new Error(
				`${paths.modelCard} already has a \`capabilities\` block — \`git checkout\` it first, then re-run --write ` +
					`(the surgical insert appends; it does not replace).`
			)
		}

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- Re-indenting a string serialized on the line above, not reading anything.
		const block = prettyJSON(capabilities, false)
			.split("\n")
			.map((line) => "\t" + line)
			.join("\n")

		const before = original.slice(0, lastBrace).replace(/\s*$/, "")
		const after = original.slice(lastBrace) // the final "}\n"
		await writeLocalTextFile(`${before},\n\t"capabilities": ${block.trimStart()}\n${after}`, paths.modelCard)

		console.error(`\nSurgically inserted the \`capabilities\` block into ${paths.modelCard}`)
	} else {
		console.error("\n(dry run — pass --write to patch the model card)")
	}
}

//#endregion
