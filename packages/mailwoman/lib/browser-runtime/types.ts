/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The structural interfaces the browser runtime composes over: each `…Like` mirrors a package type by shape so a
 *   host bundle can name the classifier, the FST matcher, and the parse trace while those packages stay dynamic
 *   imports on the load path.
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
		 * The population-anchored likelihood the decoder bias reads.
		 */
		referential: number
		/**
		 * Wikipedia importance, present only when the artifact is v5+ and the place has an article;
		 * displayed but never ranked on, and `undefined` is absence rather than 0.
		 */
		encyclopedic?: number
	}>
	readonly stateCount: number
	readonly placeCount: number
}

export interface MailwomanClassifierLike {
	parse: (text: string, opts?: { queryShape?: unknown; fst?: FSTMatcherLike }) => Promise<unknown>
	/**
	 * Optional decode-path introspection; bundles built before the `traceParse`
	 * hook lack it, so feature-detect before calling.
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
 * Structural mirror of `@mailwoman/neural`'s `NeuralParseTrace`.
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
	 * The locale-head axis, a country code per `localeLogits` index; never hardcode the order.
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
 * How a release loader reports progress to its host while assets arrive;
 * `@mailwoman/react`'s `AssetsLoadContext` satisfies it structurally.
 */
export interface AssetLoadProgress {
	/**
	 * Aborts when this load is superseded or the host goes away; the loader stops
	 * handing back a lookup once it fires.
	 */
	signal: AbortSignal
	/**
	 * Force the CPU/wasm backend instead of WebGPU for this load.
	 */
	forceWASM: boolean
	setProgress: (progress: string) => void
	setStepLabels: (labels: string[]) => void
	setStepIndex: (index: number) => void
	setBackend: (backend: string) => void
	/**
	 * Bytes received over bytes expected for the artifact downloading now, in [0, 1], `null`
	 * when none is in flight, and optional so a host that predates it still satisfies this interface;
	 * the step index cannot report the model, which is fetched before the first step is entered.
	 */
	setByteFraction?: (fraction: number | null) => void
}
