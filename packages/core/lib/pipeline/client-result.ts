/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The parse result as a client renders it: what the browser runtime produces after classify + resolve, and what
 *   `@mailwoman/react` takes as input. One definition, because a producer and a renderer that each write the shape
 *   agree only by accident. Every field a stage may leave unset is optional here; a renderer that needs a value it
 *   cannot see shows absence, never a default.
 */

export interface ParsedComponent {
	tag: string
	value?: unknown
	confidence?: number
	start?: number
	end?: number
}

export interface ResolvedPlaceView {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
	score: number
	bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
	/**
	 * How the coordinate was reached when a street-tier lookup answered: a rooftop point, or an interpolation along the
	 * segment. Absent for a gazetteer place.
	 */
	tier?: "address_point" | "interpolated"
	uncertaintyM?: number
}

export interface DualRoleView {
	id: number
	name: string
	placetype: string
	relationshipType: string
	role: string
}

export interface StageTiming {
	shape: number
	classify: number
	resolve?: number
}

export interface FSTProvenance {
	builtAt: string
	stateCount: number
	placeCount: number
	importanceMatches: number
}

/**
 * The query kind as a client shows it. `kind` is any string here, where the pipeline's own `QueryKindResult` carries
 * the typed union, because a renderer must show a kind it does not know rather than refuse the result.
 */
export interface KindView {
	kind: string
	confidence: number
	alternatives: ReadonlyArray<{ kind: string; confidence: number }>
}

export interface ParseResult {
	input: string
	/**
	 * The decoder's `AddressTree`, opaque here so this module stays free of the decoder's types; a renderer that walks it
	 * imports `@mailwoman/core/decoder/types`.
	 */
	tree: unknown
	nodes: ParsedComponent[]
	kindResult?: KindView
	timing?: StageTiming
	resolved: ResolvedPlaceView | null
	candidates: ResolvedPlaceView[]
	fstActive: boolean
	fstProvenance?: FSTProvenance | null
	dualRoles?: DualRoleView[]
}
