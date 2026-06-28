/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Input-shape router (#478 increment 2) — the arbitration _prior_.
 *
 *   A pure, deterministic classification of the input's _shape_ into a default {@link PolicyMode} that
 *   seeds the whole per-component policy table before per-tag config overlays. The intuition (the
 *   parity capstone, #478): the old rules system owns clean structured Latin addresses (the arena's
 *   `v0-only` column), neural owns noisy / off-map / non-Latin input, and when both signals are
 *   weak the honest move is to _abstain_ rather than emit a confident-wrong parse.
 *
 *   This module is the decision logic only. It does NOT wire itself into a pipeline: the consumer
 *   (`policyRegistryFromRoute` → the proposal pipeline) decides whether to apply it, and the
 *   production `runPipeline` does not feed it live signals until the two arbitration sites are
 *   unified (#478 increment 3). Keeping the prior pure and exhaustively unit-tested here de-risks
 *   that wiring — the prior is proven correct in isolation before any behavior changes.
 *
 *   Inputs are deliberately _structural lite_ types (not the concrete `QueryKindResult` /
 *   `QueryShapeLite` / `CoarsePrediction`) so this file has zero imports beyond `PolicyMode` and is
 *   safe to import from anywhere. The real signals satisfy these shapes by construction.
 */

import type { PolicyMode } from "./policy.js"

/** Minimal kind-classifier signal. Compatible with `QueryKindResult` (`core/pipeline/types.ts`). */
export interface RouterKindSignal {
	/** The classified kind, e.g. `structured_address`, `landmark`, `vague`. */
	kind: string
	/** Top-class confidence, 0..1. */
	confidence: number
}

/** Minimal query-shape signal. Compatible with `QueryShapeLite` (`core/pipeline/types.ts`). */
export interface RouterShapeSignal {
	/**
	 * Broad character category:
	 *
	 * - `numeric`
	 * - `alpha`
	 * - `alphanumeric`
	 * - `cjk`
	 * - `cyrillic`
	 * - `arabic`
	 * - `mixed`.
	 */
	characterClass?: string
}

/**
 * Minimal coarse-placer signal (#244). Compatible with `CoarsePrediction` (`core/coarse-placer/coarse-placer.ts`).
 * `null` means no placer ran — treated as "no OOD signal", never as an abstention.
 */
export interface RouterPlacerSignal {
	/** The in-map country argmax, `null` when abstained, or `"OTHER"` when off-map. */
	country: string | null
	/** Explicit abstention flag (M2 open-set reject). */
	abstained: boolean
}

/** The routed prior: a default policy mode for the whole component table, plus an abstain signal. */
export interface InputShapeRoute {
	/**
	 * The default {@link PolicyMode} every component starts from (per-tag config still overrides).
	 *
	 * - `rule_preferred` — clean structured Latin address; v0's home turf.
	 * - `neural_preferred` — noisy / non-Latin / off-map; neural carries it.
	 * - `both` — weak/ambiguous; keep every source (paired with `abstain: true`).
	 */
	defaultMode: PolicyMode
	/**
	 * True when both sources are weak (low kind confidence and/or the placer abstained on a non-clean shape). A
	 * first-class outcome reserved for the resolver/admin honest-radius downgrade — but it has NO consumer until #478
	 * increment 3, so for now it is computed and reported only. `defaultMode` is `both` when this is set (drop nothing).
	 */
	abstain: boolean
	/** Human-readable trace of which branch fired — for telemetry and test assertions. */
	reason: string
}

/** Kinds the rules system handles well when the rest of the shape is clean. */
const RULE_CLEAN_KINDS: ReadonlySet<string> = new Set(["structured_address", "intersection", "po_box", "postcode_only"])

/**
 * Non-Latin scripts where the Latin-centric rules system is weak — hand to neural regardless of kind.
 */
const OOD_SCRIPTS: ReadonlySet<string> = new Set(["cjk", "cyrillic", "arabic"])

/** Character classes that count as "Latin / clean" for the `rule_preferred` guard. */
const LATIN_CLASSES: ReadonlySet<string> = new Set(["numeric", "alpha", "alphanumeric"])

/**
 * Minimum kind confidence to route a clean kind to `rule_preferred`. Strict by design: below this, v0's rules are
 * brittle on structured input and a confident wrong preference is worse than keeping both sources
 * (DeepSeek-coordinated, 2026-06-17 — 0.7 invited false-preference).
 */
export const CLEAN_KIND_CONFIDENCE = 0.8

/**
 * Classify the input's shape into a default policy mode.
 *
 * The decision tree (first match wins):
 *
 * 0. **OOD script** (`cjk` / `cyrillic` / `arabic`) → `neural_preferred`. Script dominates — rules are Latin-centric, so
 *    non-Latin input is neural's regardless of kind.
 * 1. **Clean structured** — a {@link RULE_CLEAN_KINDS} kind at confidence ≥ {@link CLEAN_KIND_CONFIDENCE}, a Latin/unknown
 *    character class, and the placer not abstained → `rule_preferred`. v0's home turf.
 * 2. **Both weak** — the placer abstained, or kind confidence is below the cutoff → `abstain` (mode `both`, drop nothing).
 * 3. **Otherwise** (confident, Latin, placer-OK, but not a clean kind — `landmark`, `vague`, `locality_only`) →
 *    `neural_preferred`.
 *
 * @param kind Kind-classifier signal.
 * @param shape Query-shape signal.
 * @param placer Coarse-placer signal, or `null` when none ran.
 */
export function routeInputShape(
	kind: RouterKindSignal,
	shape: RouterShapeSignal,
	placer: RouterPlacerSignal | null
): InputShapeRoute {
	const cc = shape.characterClass
	const placerAbstained = placer !== null && (placer.abstained || placer.country === null || placer.country === "OTHER")

	// 0. Non-Latin script → neural, before any kind-based routing.
	if (cc !== undefined && OOD_SCRIPTS.has(cc)) {
		return { defaultMode: "neural_preferred", abstain: false, reason: `ood-script:${cc}` }
	}

	// 1. Clean structured Latin address with a confident clean kind and no placer abstention → rules.
	const latinOrUnknown = cc === undefined || LATIN_CLASSES.has(cc)

	if (
		RULE_CLEAN_KINDS.has(kind.kind) &&
		kind.confidence >= CLEAN_KIND_CONFIDENCE &&
		latinOrUnknown &&
		!placerAbstained
	) {
		return {
			defaultMode: "rule_preferred",
			abstain: false,
			reason: `clean:${kind.kind}@${kind.confidence.toFixed(2)}`,
		}
	}

	// 2. Both signals weak → abstain (keep every source; drop nothing).
	if (placerAbstained || kind.confidence < CLEAN_KIND_CONFIDENCE) {
		return {
			defaultMode: "both",
			abstain: true,
			reason: `weak:kind=${kind.kind}@${kind.confidence.toFixed(2)},placerAbstained=${placerAbstained}`,
		}
	}

	// 3. Confident, Latin, placer-OK, but not a clean kind → neural.
	return { defaultMode: "neural_preferred", abstain: false, reason: `neural-default:${kind.kind}` }
}
