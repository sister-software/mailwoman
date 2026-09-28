/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The classify stage of the browser runtime: query shape, kind, the neural pipeline and the tree flatten, with the
 *   two front-half timings captured, plus the dual-role resolution and the projections a renderer takes. The caller
 *   owns resolution (`runCascade`, a street tier, an anchor fallback) and the staged progress ticks.
 */

// Keep these static.
// A dynamic-import destructure of this barrel gets tree-shaken by webpack's usedExports analysis.
// Static named imports are fully analyzable.
// Do not re-dynamize.
import { type FlatTreeNode, flattenTreeNodes } from "@mailwoman/core/decoder"
import type { AddressTree } from "@mailwoman/core/decoder/types"
import type { ParseResult, ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import type { DualRole, MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"

import type { FSTMatcherLike, MailwomanClassifierLike } from "#browser-runtime/types"

/**
 * Project the cascade's hits onto the package's {@link ResolvedPlaceView},
 * shared by both demo parse paths so the projection cannot drift.
 */
export function projectCascadeHits(
	hits: ReadonlyArray<{ id: number; name: string; placetype: string; lat: number; lon: number; score: number }>
): ResolvedPlaceView[] {
	return hits.map((c) => ({ id: c.id, name: c.name, placetype: c.placetype, lat: c.lat, lon: c.lon, score: c.score }))
}

/**
 * Per-parse progress labels, keyed on whether a gazetteer lookup is wired for the selected release.
 */
export function parseStageLabelsFor(hasResolver: boolean): string[] {
	return hasResolver
		? ["Analyzing input shape…", "Running neural classifier…", "Resolving in gazetteer…"]
		: ["Analyzing input shape…", "Running neural classifier…"]
}

/**
 * Locale the demo opens on.
 */
export const DEFAULT_LOCALE = "en-us"

/**
 * Address the demo opens on, which exercises house number, street, directional,
 * locality and region in one line.
 */
export const DEFAULT_ADDRESS = "1600 Pennsylvania Ave NW, Washington, DC 20500"

/**
 * Demo preset addresses, each carrying its ISO country code so a locale that structural
 * routing cannot detect from text shape still fires while the input equals the preset text.
 */
export const EXAMPLE_ADDRESSES: Array<{ label: string; address: string; country: string }> = [
	{ label: "White House", address: "1600 Pennsylvania Ave NW, Washington, DC 20500", country: "us" },
	{ label: "Apple Park", address: "1 Apple Park Way, Cupertino, CA 95014", country: "us" },
	{ label: "30 Rockefeller Plaza", address: "30 Rockefeller Plaza, New York, NY 10112", country: "us" },
	{ label: "Pier 39 SF", address: "Pier 39, San Francisco, CA 94133", country: "us" },
	{ label: "Wrigley Field", address: "1060 W Addison St, Chicago, IL 60613", country: "us" },
	{ label: "Space Needle", address: "400 Broad St, Seattle, WA 98109", country: "us" },
	{ label: "ZIP only", address: "90210", country: "us" },
	{ label: "Berlin (native order)", address: "Straußstraße 27, 12623 Berlin", country: "de" },
	{ label: "Berlin city-state (int'l order)", address: "5 Hauptstraße, Berlin, Berlin 10115", country: "de" },
	{ label: "Paris (street fall-through)", address: "181 Rue du Chevaleret, Paris", country: "fr" },
	// GB dependent_locality.
	// "Henbury" flips to dependent_locality via the en-gb pair-index prior, and the
	// `country: "gb"` pin selects it even if the user edits away the postcode.
	{
		label: "Macclesfield (GB dependent_locality)",
		address: "41 Hightree Drive, Henbury, Macclesfield, SK11 9PD",
		country: "gb",
	},
	// NZ dependent_locality.
	// Plimmerton is a suburb (dependent_locality) of Porirua.
	// The postcode is deliberately omitted, because a trailing "Porirua 5026" puts
	// the postcode in the parent's comma-field, so segment mode folds "porirua 5026"
	// and misses the index's bare "porirua" key.
	// The `country: "nz"` pin is required because locale-check cannot detect NZ from a
	// 4-digit postcode, so only the preset pin selects the nz index.
	{ label: "Plimmerton (NZ dependent_locality)", address: "35 Steyne Avenue, Plimmerton, Porirua", country: "nz" },
]

/**
 * The placetype-pair country pin for one input, returning a preset's `country`
 * when `input` still exactly equals that preset's text and `undefined` otherwise
 * so the caller lets structural detection decide.
 */
export function pairCountryForInput(input: string): string | undefined {
	const trimmed = input.trim()

	return EXAMPLE_ADDRESSES.find((ex) => ex.address.trim() === trimmed)?.country
}

/**
 * A source-order parsed node, as {@link flattenTreeNodes} yields it.
 */
export type FlatNode = FlatTreeNode

/**
 * What both demo parse paths need out of the neural classify stage before resolution.
 */
export interface ClassifyStageResult {
	/**
	 * The decoded solver tree (opaque to the caller beyond `runCascade` / `flattenTreeNodes`).
	 */
	tree: AddressTree
	/**
	 * Source-order flattened nodes.
	 */
	nodes: FlatNode[]
	/**
	 * The query-shape kind hypothesis (`postcode_only` / `structured_address` / …).
	 */
	kindResult: ParseResult["kindResult"]
	/**
	 * Wall-clock timing for the two front-half stages, in ms.
	 */
	timing: { shape: number; classify: number }
}

/**
 * Per-parse placetype-pair prior selector, the shape the web loader's
 * `LoadResult.selectPairIndexForText` exposes, which runs locale-check over the input
 * text shape (postcode format or script rather than place names) and returns the
 * matching loaded index or `undefined` when no loaded index matches, typed opaquely
 * because the docs bundle carries no neural type dependency.
 */
export type SelectPairIndex = (text: string, opts?: { country?: string }) => object | undefined

export interface ClassifyStageDeps {
	/**
	 * The loaded neural classifier, which must be ready because the caller guards `null`.
	 */
	classifier: MailwomanClassifierLike
	/**
	 * The optional FST gazetteer prior.
	 */
	fst?: FSTMatcherLike | null
	/**
	 * The optional street-morphology matcher, the signal source for the street-context check.
	 *
	 * The check only fires when both this and `fst` are wired (core's `streetContextRequirementFor`),
	 * matching the node runtime pipeline's default.
	 * `null` when the release ships no `fst-street-morphology.bin`, in
	 * which case the demo parses with the check off.
	 */
	streetMorphology?: FSTMatcherLike | null
	/**
	 * The per-parse placetype-pair prior selector.
	 *
	 * The loaded {@link SelectPairIndex}, or `null`/omitted when no pair index was staged for this release.
	 * When present, `runClassifyStage` calls it on the input and passes the result
	 * as the pipeline's `placetypePair` opt.
	 *
	 * The GB/NZ dependent_locality prior fires while US/FR inputs stay byte-stable.
	 */
	selectPairIndex?: SelectPairIndex | null
}

export interface ClassifyStageHooks {
	/**
	 * Fired after the (synchronous) query-shape + kind pass, immediately before the neural pipeline runs.
	 *
	 * Drives the staged progress UI's "Running neural classifier…" transition.
	 * Both callers wire it to their `onStage(1)`.
	 */
	onClassifierStart?: () => void
}

/**
 * Run the shared classify front-half.
 *
 * See {@link ClassifyStageResult} / {@link ClassifyStageDeps}.
 */
export async function runClassifyStage(
	input: string,
	deps: ClassifyStageDeps,
	hooks: ClassifyStageHooks = {}
): Promise<ClassifyStageResult> {
	const [{ computeQueryShape }, { classifyKindSync }, { runPipeline }, { groupPhrases }] = await Promise.all([
		import("@mailwoman/query-shape"),
		import("@mailwoman/kind-classifier"),
		import("@mailwoman/core/pipeline"),
		import("@mailwoman/phrase-grouper"),
	])

	const tStart = performance.now()
	const queryShape = computeQueryShape(input)
	const kindResult = classifyKindSync({ raw: input, normalized: input }, queryShape)
	const tShape = performance.now()

	hooks.onClassifierStart?.()

	// Placetype-pair prior: pick the per-parse index.
	// A preset pins its country (pairCountryForInput), so a locale structural routing
	// cannot detect from text still fires while the input equals the preset text.
	// The moment the user edits, the pin drops and the code falls back to structural locale-check detection.
	// No index or no match leaves the result byte-stable.
	const pinnedCountry = pairCountryForInput(input)
	const placetypePair = deps.selectPairIndex?.(input, pinnedCountry ? { country: pinnedCountry } : undefined)

	const { tree } = await runPipeline(
		input,
		{
			computeQueryShape,
			groupPhrases,
			classifier: deps.classifier as Parameters<typeof runPipeline>[1]["classifier"],
			fst: (deps.fst ?? undefined) as Parameters<typeof runPipeline>[1]["fst"],
			streetMorphology: (deps.streetMorphology ?? undefined) as Parameters<typeof runPipeline>[1]["streetMorphology"],
		},
		// The demo search box is a human typing fragments, so the input mode is the fragmented
		// register and the evidence-bundle channels feed once a bundle model ships.
		{ inputMode: "fragmented", ...(placetypePair !== undefined ? { placetypePair } : {}) }
	)

	const tClassify = performance.now()

	return {
		tree,
		nodes: flattenTreeNodes(tree),
		kindResult: kindResult as ParseResult["kindResult"],
		timing: { shape: tShape - tStart, classify: tClassify - tShape },
	}
}

/**
 * Dual-role resolution shared by both parse paths, which reports whether the resolved pin
 * doubles as another admin tier and returns `undefined` for a placeless pin (`id === 0`),
 * a lookup with no `coincidentRolesFor`, an empty relation or a failed query.
 */
export async function resolveDualRoles(
	lookup: MailwomanLookupLike,
	primaryHit: { id: number } | undefined
): Promise<DualRole[] | undefined> {
	if (!primaryHit || !primaryHit.id || !lookup.coincidentRolesFor) return undefined

	try {
		const roles = await lookup.coincidentRolesFor(primaryHit.id)

		return roles.length ? roles : undefined
	} catch {
		return undefined
	}
}
