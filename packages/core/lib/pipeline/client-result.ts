/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The parse result as a client renders it. The browser runtime produces it after classify + resolve.
 *   `@mailwoman/react` takes it as input. One definition prevents the producer and renderer from
 *   drifting apart. Every field a stage may leave unset is `null` here. A renderer that needs a value it
 *   cannot see shows absence rather than a default.
 */

export interface ParsedComponent {
	tag: string
	value: unknown
	confidence: number | null
	start: number | null
	end: number | null
}

export interface ResolvedPlaceView {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
	/**
	 * The resolver's ranking score, or null when the resolver recorded none,
	 * as for a hosted answer's runner-up whose backend omitted it.
	 */
	score: number | null
	bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null
	/**
	 * How the coordinate was reached when a street-tier lookup answered: a rooftop point,
	 * or an interpolation along the segment.
	 *
	 * `null` for a gazetteer place.
	 */
	tier: "address_point" | "interpolated" | null
	uncertaintyM: number | null
}

export interface StageTiming {
	shape: number
	classify: number
	resolve: number | null
}

export interface FSTProvenance {
	builtAt: string
	stateCount: number
	placeCount: number
	importanceMatches: number
}

/**
 * The query kind as a client shows it.
 *
 * `kind` is any string here, while the pipeline's own `QueryKindResult` contains the typed union,
 * because a renderer must show a kind it doesn't know rather than refuse the result.
 */
export interface KindView {
	kind: string
	confidence: number
	alternatives: ReadonlyArray<{ kind: string; confidence: number }>
}

/**
 * What the data held for one parsed component.
 *
 * A parse can label a span correctly while no database holds it, so this states
 * the lookup's result beside the label.
 */
export interface ComponentMatch {
	tag: string
	value: string
	matched: boolean
	/**
	 * The stored name that answered, or `null` when the lookup found no row.
	 */
	name: string | null
	placetype: string | null
	/**
	 * The stored identifier that answered, such as `wof:85786019`.
	 */
	placeID: string | null
	/**
	 * What the lookup searched, when that explains the result, such as a street
	 * tier with no data for the region.
	 */
	note: string | null
}

export interface ParseResult {
	input: string
	/**
	 * The lookup result per component, on a runtime that reports it.
	 */
	matches?: ComponentMatch[]
	/**
	 * The decoder's `AddressTree`, opaque here so this module stays free of the decoder's types.
	 *
	 * A renderer that walks it imports `@mailwoman/core/decoder/types`.
	 */
	tree: unknown
	nodes: ParsedComponent[]
	kindResult: KindView | null
	timing: StageTiming | null
	resolved: ResolvedPlaceView | null
	candidates: ResolvedPlaceView[]
	fstActive: boolean
	fstProvenance: FSTProvenance | null
}
