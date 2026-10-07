/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lists optional {@link ResolverBackend} methods that the loaded backend lacks and the cost of each omission.
 *
 *   Optional backend methods can make default-on resolver features no-op. This module exposes and
 *   reports those gaps without changing resolution behavior.
 */

import { type BackendCapabilityGap, RESOLVE_SWITCH_DEFAULTS, type ResolverBackend } from "@mailwoman/core/resolver"

/**
 * The optional backend methods whose absence degrades a passing default, paired with what stops working.
 *
 * A method whose absence is inert (or whose option is opt-in and therefore a
 * deliberate caller choice) does not belong here.
 * The list exists to name silent degradation rather than to inventory the interface.
 */
const CONSEQUENTIAL_CAPABILITIES: ReadonlyArray<Omit<BackendCapabilityGap, "backend">> = [
	{
		capability: "ancestors",
		option: "hierarchyCompletion",
		defaultOn: RESOLVE_SWITCH_DEFAULTS.hierarchyCompletion,
		degrades:
			"the containment lineage is never read: a parse that drops the locality of a city-state or dependent locality keeps the gap, and `metadata.ancestors` (the lineage the Nominatim and Photon drop-ins expose) is never populated",
	},
	{
		capability: "coincidentLocalitiesFor",
		option: "hierarchyCompletion",
		defaultOn: RESOLVE_SWITCH_DEFAULTS.hierarchyCompletion,
		degrades:
			"the dual-role pass never runs: a region that is also a locality under the same name resolves to one role only",
	},
]

/**
 * Enumerate the consequential capabilities this backend does not implement.
 *
 * Empty means every default-on option the resolver offers has the backend support it needs.
 */
export function describeCapabilityGaps(backend: ResolverBackend): readonly BackendCapabilityGap[] {
	const name = backend.constructor?.name || "backend"

	return CONSEQUENTIAL_CAPABILITIES.filter((c) => typeof backend[c.capability] !== "function").map(
		(c): BackendCapabilityGap => ({ ...c, backend: name })
	)
}

/**
 * One log line for a backend's whole set of gaps.
 *
 * Keep the log line short.
 * It states the missing methods and affected options.
 *
 * A reference points to the document that describes their consequences.
 * Each gap's `degrades` field retains details for consumers.
 * Long log lines are harder for operators to scan.
 */
export function formatCapabilityGaps(gaps: readonly BackendCapabilityGap[]): string {
	const [first] = gaps
	const names = gaps.map((g) => `${g.capability}()`).join(", ")
	const options = [...new Set(gaps.map((g) => g.option))].join(", ")
	const posture = gaps.some((g) => g.defaultOn) ? "default-ON" : "opt-in"

	return `[resolver] ${first?.backend} lacks ${names} — ${options} (${posture}) silently no-ops; see docs/engineering/reference/resolver-backends.mdx`
}

/**
 * Backends already reported, so a process that builds many resolvers over one artifact — the eval
 * harness, the gauntlet, a batch worker — states the gap once rather than once per construction.
 */
const reported = new Set<string>()

/**
 * Report a backend's gaps to stderr the first time this process sees them.
 *
 * The gaps are data on `Resolver.capabilityGaps` regardless.
 * This also reports them to an operator.
 */
export function reportCapabilityGaps(gaps: readonly BackendCapabilityGap[]): void {
	const [first] = gaps

	if (!first || reported.has(first.backend)) return
	reported.add(first.backend)

	console.error(formatCapabilityGaps(gaps))
}
