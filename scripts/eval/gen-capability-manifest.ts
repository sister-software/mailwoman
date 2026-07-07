/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Capability-manifest generator (#718 / #719) — the measurement half of the load-time delta-gate.
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
 *   per-tag F1 (same machinery as `score-affix.ts` — split `street_prefix`/`street`/`street_suffix`
 *   so the affix capability is measurable, which the folded `per-locale-f1.ts` cannot see). The
 *   classifier is built via the canonical `createScorer` so the channel feed matches the ship
 *   config (the #566/#685 trap), with `overrides.conventions` toggling mask off/on and
 *   `overrides.gazetteer` selecting the tier.
 *
 *   Run (Node 26+, custom DB / anchor-on, the production default v1.5.0 int8):
 *
 *   Node --experimental-strip-types scripts/eval/gen-capability-manifest.ts\
 *   --model $MAILWOMAN_DATA_ROOT/models/quantized/model-v150-step-40000-int8.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json\
 *   --write
 *
 *   `--write` patches the `capabilities` block into the card (additive metadata, tabs preserved);
 *   omit it for a dry run that only prints the block.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { ADDRESS_SYSTEM_CONVENTIONS, type SystemCode } from "@mailwoman/codex"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import type { NeuralAddressClassifier } from "@mailwoman/neural"
import { createScorer, type ScorerOverrides } from "@mailwoman/neural/scorer"

// Loose scan parity with the retired scripts/lib/cli-args helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: {
		"anchor-lookup": { type: "string" },
		"gazetteer-lexicon": { type: "string" },
		model: { type: "string" },
		"model-card": { type: "string" },
		tokenizer: { type: "string" },
		write: { type: "boolean" },
	},
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as {
	"anchor-lookup"?: string
	"gazetteer-lexicon"?: string
	model?: string
	"model-card"?: string
	tokenizer?: string
	write?: boolean
}
// -------------------------------------------------------------------------------------------------
// Args
// -------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2)

const MODEL = (values["model"] || dataRootPath("models", "quantized", "model-v150-step-40000-int8.onnx"))!
const TOKENIZER = (values["tokenizer"] || dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"))!
const MODEL_CARD = (values["model-card"] || "neural-weights-en-us/model-card.json")!
const ANCHOR_LOOKUP = (values["anchor-lookup"] || dataRootPath("anchor", "pilot-anchor-lookup.json"))!
const GAZETTEER_LEXICON = (values["gazetteer-lexicon"] || "data/gazetteer/anchor-lexicon-v1.json")!
const WRITE = values["write"] ?? false

// -------------------------------------------------------------------------------------------------
// Tier + locale matrix
// -------------------------------------------------------------------------------------------------

/** Serving tiers and their channel feed (vs the model-card SHIP-CONFIG, expressed as overrides). */
const TIERS: Record<string, ScorerOverrides> = {
	// Production default — anchor + gazetteer both fed (no override needed; createScorer's defaults).
	server: {},
	// On-device lighter feed — anchor on, gazetteer ablated. `overrides.gazetteer:false` warns loudly
	// (a DECLARED ablation), which is correct: pocket is a deliberate below-ship-config tier.
	pocket: { gazetteer: false },
}

interface LocaleEvalSpec {
	/** The codex address-system this locale maps to (`us`, `fr`, …). */
	system: SystemCode
	/** Eval JSONL files (raw + components). Multiple files are concatenated. */
	files: string[]
}

// One eval spec per locale that has an eval set. The eval rows carry split street parts so the
// affix capability (`street_prefix`/`street_suffix`) is measurable — the whole point of the
// manifest (the folded `per-locale-f1.ts` joins the three street parts and cannot see it).
//
// FR uses the dedicated street-prefix slice (`fr-street-prefix-real.jsonl`, the #719 reproduction),
// NOT the broad golden dev set, for the essential tags: golden FR carries only ~7 `street_prefix`
// rows against ~1535 without it, so the unfolded `street_prefix` F1 there is dominated by absent-gold
// rows (measured 5.3) — it would UNDER-certify the very capability the gate exists to protect. On the
// purpose-built slice the model emits FR `street_prefix` at F1 80.0 (the figure the #719 fix cites),
// which is the honest capability number the loader must guard.
const LOCALES: LocaleEvalSpec[] = [
	{ system: "us", files: ["data/eval/golden/v0.1.2/dev/us.jsonl"] },
	{ system: "fr", files: ["data/eval/external/fr-street-prefix-real.jsonl"] },
]

// The per-tag vocabulary scored, UNFOLDED (street parts split — mirrors score-affix.ts).
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

// The union of every tag any codex conventions row forbids — the ONLY tags the loader's delta-gate
// reads, so the ONLY tags that NEED a paired `maskOnF1`. Derived from the codex so a new forbid row
// automatically widens the manifest the next time it's regenerated.
const FORBIDDEN_TAGS: Set<string> = new Set(
	Object.values(ADDRESS_SYSTEM_CONVENTIONS).flatMap((c) => c?.forbiddenTags ?? [])
)

// -------------------------------------------------------------------------------------------------
// Scoring (unfolded exact-match per-tag F1 — score-affix.ts machinery)
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

/** Per-tag exact-match F1 (percent, 1-decimal) over the rows. Mirrors score-affix.ts. */
async function perTagF1(neural: NeuralAddressClassifier, rows: Row[]): Promise<Record<string, number>> {
	const stat: Record<string, { tp: number; fp: number; fn: number }> = {}

	for (const t of TAGS) {
		stat[t] = { tp: 0, fp: 0, fn: 0 }
	}

	for (const row of rows) {
		const got = decodeAsJSON(await neural.parse(row.raw)) as Record<string, string>
		const exp = row.components

		for (const t of TAGS) {
			const e = norm(exp[t])
			const g = norm(got[t])

			if (e && g && e === g) {
				stat[t]!.tp++
			} else {
				if (g) {
					stat[t]!.fp++
				}

				if (e) {
					stat[t]!.fn++
				}
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
// Build the manifest
// -------------------------------------------------------------------------------------------------

/** `{ maskOffF1, maskOnF1? }` — maskOnF1 present only for forbidden-set tags the model emits. */
interface TagCapability {
	maskOffF1: number
	maskOnF1?: number
}

type Capabilities = Record<string, Record<string, Record<string, TagCapability>>>

async function buildManifest(): Promise<Capabilities> {
	const capabilities: Capabilities = {}

	for (const [tier, tierOverrides] of Object.entries(TIERS)) {
		capabilities[tier] = {}

		for (const spec of LOCALES) {
			const rows = loadRows(spec.files)
			console.error(`\n[${tier}/${spec.system}] n=${rows.length} (${spec.files.join(", ")})`)

			// mask-OFF: conventions disabled. createScorer warns (declared-required override) — expected.
			const offScorer = await createScorer({
				modelPath: MODEL,
				tokenizerPath: TOKENIZER,
				modelCardPath: MODEL_CARD,
				anchorLookupPath: ANCHOR_LOOKUP,
				gazetteerLexiconPath: GAZETTEER_LEXICON,
				strict: true,
				// The generator must construct the scorer WHILE the card's `capabilities` block may not
				// yet exist; the loader's delta-gate is a no-op until the block is written. After a
				// `--write`, regenerating uses the already-written block, but mask-OFF construction never
				// trips the gate (it only fires for a forbidden CERTIFIED tag, and mask-off forbids none).
				overrides: { ...tierOverrides, conventions: false },
			})
			const off = await perTagF1(offScorer, rows)

			// mask-ON: conventions in `auto` mode (reads the model's locale head → applies the detected
			// system's forbiddenTags). This is the SHIP behavior whose damage we measure.
			const onScorer = await createScorer({
				modelPath: MODEL,
				tokenizerPath: TOKENIZER,
				modelCardPath: MODEL_CARD,
				anchorLookupPath: ANCHOR_LOOKUP,
				gazetteerLexiconPath: GAZETTEER_LEXICON,
				strict: true,
				overrides: { ...tierOverrides, conventions: "auto" },
			})
			const on = await perTagF1(onScorer, rows)

			const perTag: Record<string, TagCapability> = {}

			for (const t of TAGS) {
				// Skip tags the model never emits AND never sees in gold under either mask — a 0/0 F1 is
				// not a capability claim, just noise. (maskOffF1 0 with the tag genuinely present in gold
				// IS a real claim and is kept.)
				if (off[t] === 0 && on[t] === 0 && !rowsHaveTag(rows, t)) continue
				const cap: TagCapability = { maskOffF1: off[t]! }

				// maskOnF1 only for forbidden-set tags — the only tags the loader's delta-gate consults.
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

function rowsHaveTag(rows: Row[], tag: string): boolean {
	for (const r of rows) if (norm(r.components[tag])) return true

	return false
}

// -------------------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------------------

const capabilities = await buildManifest()

console.log("\n--- capabilities block ---")
console.log(JSON.stringify({ capabilities }, null, "\t"))

if (WRITE) {
	// Provenance key alongside the tier keys; ignored by readers (`lookupTagCapability` skips it).
	;(capabilities as Record<string, unknown>).$comment =
		"Per-tier (server=anchor+gazetteer; pocket=anchor-only) × address-system × tag capability " +
		"manifest (#718/#719). maskOffF1 = measured per-tag exact-match F1 with the conventions mask " +
		"OFF; maskOnF1 = the same with mask ON (recorded only for tags some codex forbiddenTags row " +
		"suppresses — the loader's delta-gate consults only those). createScorer FAILS CLOSED when a " +
		"conventions row forbids a tag with maskOffF1 − maskOnF1 > 0.05 (the mask provably destroys a " +
		"real capability). Generated by scripts/eval/gen-capability-manifest.ts against the v1.5.0 int8."

	// SURGICAL insert (not a JSON round-trip): the shipped card hand-formats compact inline objects
	// (`"anchor": { "required": true }`) that a `JSON.stringify` would expand, spuriously reordering a
	// shipped artifact. Instead, append ONE new top-level key, byte-preserving everything else. The
	// card is validated JSON, so its tail is `…\n}\n` (root close); we splice `,\n\t"capabilities":…`
	// before that final brace, one indent level deep (each block line tab-prefixed).
	const original = readFileSync(MODEL_CARD, "utf8")
	const lastBrace = original.lastIndexOf("}")

	if (lastBrace < 0) throw new Error(`model-card has no closing brace: ${MODEL_CARD}`)

	if (JSON.parse(original).capabilities !== undefined) {
		// Idempotency guard: a prior write left a block. A text-splice would duplicate the key, so refuse.
		throw new Error(
			`${MODEL_CARD} already has a \`capabilities\` block — \`git checkout\` it first, then re-run --write ` +
				`(the surgical insert appends; it does not replace).`
		)
	}
	const block = JSON.stringify(capabilities, null, "\t")
		.split("\n")
		.map((line) => "\t" + line)
		.join("\n")
	const before = original.slice(0, lastBrace).replace(/\s*$/, "")
	const after = original.slice(lastBrace) // the final "}\n"
	writeFileSync(MODEL_CARD, `${before},\n\t"capabilities": ${block.trimStart()}\n${after}`)
	console.error(`\nSurgically inserted the \`capabilities\` block into ${MODEL_CARD}`)
} else {
	console.error("\n(dry run — pass --write to patch the model card)")
}
