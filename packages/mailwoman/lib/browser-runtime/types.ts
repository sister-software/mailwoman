/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The structural contracts the browser runtime composes over. Each `…Like` mirrors a package type by shape so a host
 *   bundle can name the classifier, the FST matcher and the parse trace without importing the packages that define
 *   them; the packages stay dynamic imports on the load path. `AssetLoadProgress` is what a loader reports through
 *   while it fetches one release's assets.
 */

export interface FSTProvenanceLike {
	builtAt: string
	stateCount: number
	placeCount: number
	importanceMatches: number
}

export interface FSTMatcherLike {
	walk(tokens: string[]): { stateID: number; accepted: boolean; depth: number } | null
	walkFrom(
		prev: { stateID: number; accepted: boolean; depth: number },
		token: string
	): { stateID: number; accepted: boolean; depth: number } | null
	accepting(stateID: number): Array<{
		wofID: number
		placetype: string
		/**
		 * The REFERENTIAL likelihood (population-anchored) the decoder bias reads — see ROAD_TO_V9 §2. Was `importance`
		 * through FST format v4, where the same float could be either score with nothing to say which.
		 */
		referential: number
		/**
		 * Encyclopedic (Wikipedia) importance, when the artifact is v5+ and this place has an article. Displayed, never
		 * ranked on; `undefined` is absence, not 0.
		 */
		encyclopedic?: number
	}>
	readonly stateCount: number
	readonly placeCount: number
}

export interface MailwomanClassifierLike {
	parse: (text: string, opts?: { queryShape?: unknown; fst?: FSTMatcherLike }) => Promise<unknown>
	/**
	 * Decode-path introspection (spec 2026-07-03). Optional: deployed bundles built before the `traceParse` hook lack it
	 * — feature-detect before calling.
	 */
	traceParse?: (text: string, opts?: { addressSystemConventions?: "auto" }) => Promise<ParseTraceLike>
}

export interface TraceChannelLike {
	features: number[][]
	confidence: number[]
}

export interface TracePieceLike {
	piece: string
	id: number
	start: number
	end: number
}

export interface TraceTokenLike {
	piece: string
	start: number
	end: number
	label: string
	confidence: number
}

export interface TraceRepairLike {
	pass: string
	before: string[]
	after: string[]
}

/**
 * Structural mirror of `@mailwoman/neural`'s `NeuralParseTrace` (spec 2026-07-03).
 */
export interface ParseTraceLike {
	text: string
	caseNormalized: boolean
	pieces: TracePieceLike[]
	anchor?: TraceChannelLike
	gazetteer?: TraceChannelLike
	logits: number[][]
	localeLogits?: number[]
	/**
	 * The locale-head axis (country code per `localeLogits` index) — self-describing, never hardcode the order.
	 */
	localeCountries?: string[]
	detectedSystem: string | null
	systemSource: "off" | "auto" | "pinned"
	priors: Array<{ kind: string; applied: boolean }>
	emissions: number[][]
	labels: string[]
	path: number[]
	decode: "viterbi" | "argmax"
	repairs: TraceRepairLike[]
	tokens: TraceTokenLike[]
}

/**
 * How a release loader reports progress to its host while assets arrive. `@mailwoman/react`'s `DemoAssetsLoadContext`
 * satisfies it structurally; a host without a UI passes no-op setters.
 */
export interface AssetLoadProgress {
	/**
	 * Aborts when this load is superseded or the host goes away; the loader stops handing back a lookup once it fires.
	 */
	signal: AbortSignal
	/**
	 * Force the CPU/WASM backend instead of WebGPU for this load.
	 */
	forceWASM: boolean
	setProgress: (progress: string) => void
	setStepLabels: (labels: string[]) => void
	setStepIndex: (index: number) => void
	setBackend: (backend: string) => void
}
