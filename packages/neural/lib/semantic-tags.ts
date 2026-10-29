/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shared semantic tag registry: one global identity per address concept, across every model family.
 *
 *   A label set is a model family's head vocabulary. Its head indices are positions in that set, and two sets may
 *   place the same tag at different indices: `locality_unit` is head tag 16 in `stage3-cn` and head tag 23 in
 *   `stage3-cjk`. The tag's semantic identity is its entry here, and it is the same in both.
 *
 *   Script and locale choose a family, a tokenizer and priors. They do not choose what a tag means. `Tokyo` and
 *   `東京都` are both `prefecture` (`docs/engineering/reference/SCHEMA.mdx` gives both as examples). A family whose
 *   head lacks `prefecture` emits the concept the schema records it refines, `region`. A family with no documented
 *   equivalent reports the concept as unrepresentable rather than writing `O`.
 *
 *   Rules:
 *
 *   - {@linkcode SEMANTIC_TAGS} is append-only. A tag's global id is its index and never changes.
 *   - {@linkcode REFINES} maps a fine tag to the shared tag that holds the same concept at coarser grain, only where
 *       SCHEMA.mdx states the relation.
 *   - {@linkcode SEMANTIC_TAG_REGISTRY_VERSION} increments whenever `SEMANTIC_TAGS` or `REFINES` changes, and every
 *       model card records it beside `label_set` and `head_mapping`.
 *
 *   `corpus-python/src/mailwoman_train/semantic_tags.py` reads the same registry until the trainer moves, and its test
 *   pins it to the `semantic_tags` section of `data/label-schema.v1.json`.
 */

import { CN_FINE_TAGS, JP_FINE_TAGS, LABEL_SETS, type LabelSetName, STAGE3_TAGS, STAGE4_FINE_TAGS } from "./labels.ts"

/**
 * The registry's version, recorded in every model card beside the label set.
 */
export const SEMANTIC_TAG_REGISTRY_VERSION = 1

/**
 * The tags `COMPONENT_TAGS` in `@mailwoman/codex/component` declares and no label set trains.
 *
 * They are registered so the registry covers the parser's whole vocabulary.
 */
export const JS_ONLY_TAGS = ["street_prefix_particle", "attention"] as const

/**
 * Every registered tag, in global id order.
 * Append only.
 */
export const SEMANTIC_TAGS: readonly string[] = Object.freeze([
	...STAGE3_TAGS,
	...JP_FINE_TAGS,
	...CN_FINE_TAGS,
	...STAGE4_FINE_TAGS,
	...JS_ONLY_TAGS,
])

/**
 * A tag's global semantic id.
 */
export const SEMANTIC_TAG_ID: ReadonlyMap<string, number> = new Map(SEMANTIC_TAGS.map((tag, id) => [tag, id]))

/**
 * Each fine tag's coarser shared tag, where SCHEMA.mdx states the relation.
 */
export const REFINES: Readonly<Record<string, string>> = Object.freeze({
	// "JP first-level admin (都道府県)": the first-level administrative unit is `region` elsewhere.
	prefecture: "region",
	// "JP city/ward (市区町村)": the city is `locality`.
	municipality: "locality",
	// "JP district (大字)": the area below the city is `dependent_locality`.
	district: "dependent_locality",
	// Encoder-design rule D4: the compact number `2-3-16` is one `house_number` span, and
	// `block`/`sub_block`/`building_number` label the parts of the same number in its long form.
	block: "house_number",
	sub_block: "house_number",
	building_number: "house_number",
})

/**
 * Tags with no documented coarser equivalent, so the omission from {@linkcode REFINES} is a statement.
 *
 * `locality_unit`: SCHEMA.mdx records that the universal tags cannot represent the CN organizational ladder.
 * `building_name`: SCHEMA.mdx defines a JP building name without stating its Latin-head equivalent.
 *
 * The stage-4 secondary-address tags and the two parser-only tags:
 * no schema statement maps them onto stage 3.
 */
export const UNREFINED: ReadonlySet<string> = new Set([
	"locality_unit",
	"building_name",
	...STAGE4_FINE_TAGS,
	...JS_ONLY_TAGS,
])

/**
 * The global semantic id of each head tag of `name`, in head order.
 *
 * @throws When the set holds a tag the registry does not know.
 * The refusal catches a tag that skipped registration.
 */
export function headMapping(name: LabelSetName): number[] {
	const tags: readonly string[] = LABEL_SETS[name]
	const unknown = tags.filter((tag) => !SEMANTIC_TAG_ID.has(tag))

	if (unknown.length) throw new Error(`label set ${name} carries unregistered tags ${unknown.join(", ")}`)

	return tags.map((tag) => SEMANTIC_TAG_ID.get(tag)!)
}

/**
 * The block a model card or a build manifest pins: label set, registry version and head mapping.
 */
export interface LabelSetContract {
	label_set_id: LabelSetName
	semantic_tag_registry_version: number
	head_mapping: number[]
	head_tags: string[]
}

/**
 * The contract of the label set `name`.
 */
export function labelSetContract(name: LabelSetName): LabelSetContract {
	return {
		label_set_id: name,
		semantic_tag_registry_version: SEMANTIC_TAG_REGISTRY_VERSION,
		head_mapping: headMapping(name),
		head_tags: [...LABEL_SETS[name]],
	}
}

/**
 * The tag the set `name` emits for the concept `tag`, or `null` when the family cannot represent it.
 *
 * A tag the head holds is returned unchanged.
 * A refined tag the head lacks walks {@linkcode REFINES} to the first ancestor the head holds.
 */
export function projectTag(tag: string, name: LabelSetName): string | null {
	const head: readonly string[] = LABEL_SETS[name]

	for (let current: string | undefined = tag; current != null; current = REFINES[current]) {
		if (head.includes(current)) return current
	}

	return null
}

/**
 * The `[prefix, tag]` of a `B-` or `I-` label, or `null` for `O` and any other shape.
 */
export function splitBIOLabel(label: string): [prefix: "B" | "I", tag: string] | null {
	const separator = label.indexOf("-")

	if (label === "O" || separator === -1) return null

	const prefix = label.slice(0, separator)

	return prefix === "B" || prefix === "I" ? [prefix, label.slice(separator + 1)] : null
}

/**
 * What projecting a family's labels changed and what it could not represent, as the ledger reports it.
 */
export interface ProjectionReport extends LabelSetContract {
	projected: Record<string, number>
	unrepresentable: Record<string, number>
}

/**
 * Counts what projecting labels into one family changed and what it could not represent.
 *
 * A loader that projects through it reports, per run, the spans of each concept that
 * became a coarser tag and the spans the family could not emit.
 */
export class ProjectionLedger {
	readonly labelSet: LabelSetName
	readonly projected = new Map<string, number>()
	readonly unrepresentable = new Map<string, number>()

	constructor(labelSet: LabelSetName) {
		this.labelSet = labelSet
	}

	/**
	 * A BIO label rewritten into the family's head, counting every rewrite and every refusal.
	 */
	projectLabel(label: string): string {
		const parts = splitBIOLabel(label)

		if (!parts) return "O"

		const [prefix, tag] = parts
		const target = SEMANTIC_TAG_ID.has(tag) ? projectTag(tag, this.labelSet) : null

		if (target == null) {
			this.unrepresentable.set(tag, (this.unrepresentable.get(tag) ?? 0) + 1)

			return "O"
		}

		if (target !== tag) {
			const key = `${tag}->${target}`

			this.projected.set(key, (this.projected.get(key) ?? 0) + 1)
		}

		return `${prefix}-${target}`
	}

	/**
	 * Projects a row's labels, merging adjacent spans that refine the same target into one span.
	 *
	 * `2丁目3番16号` is three spans (`block`, `sub_block`, `building_number`) on a head that
	 * has them and one `house_number` span on a head that does not.
	 * Rule D4 labels the compact form `2-3-16` the same way.
	 *
	 * A span that projects to the target it already holds is never merged with its neighbor,
	 * so two adjacent `street` spans stay two.
	 */
	projectSequence(labels: readonly string[]): string[] {
		const out: string[] = []
		let previousSource: string | null = null

		for (const label of labels) {
			let projected = this.projectLabel(label)
			const source = splitBIOLabel(label)?.[1] ?? null
			const target = projected.slice(2)
			const last = out.at(-1)

			if (
				projected.startsWith("B-") &&
				last != null &&
				last !== "O" &&
				last.slice(2) === target &&
				source !== target &&
				previousSource != null &&
				previousSource !== source &&
				previousSource !== target
			) {
				projected = `I-${target}`
			}

			out.push(projected)
			previousSource = projected === "O" ? null : source
		}

		return out
	}

	/**
	 * The ledger's counts beside the family's contract, each map in sorted key order.
	 */
	report(): ProjectionReport {
		const sorted = (counts: ReadonlyMap<string, number>) =>
			Object.fromEntries([...counts].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

		return {
			...labelSetContract(this.labelSet),
			projected: sorted(this.projected),
			unrepresentable: sorted(this.unrepresentable),
		}
	}
}
