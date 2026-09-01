/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which optional {@link ResolverBackend} methods the loaded backend does not implement, and what each absence
 *   silently costs.
 *
 *   `ancestors` and `coincidentLocalitiesFor` are optional on the backend contract, so a backend that omits them is
 *   valid — but the resolver passes that lack through as a guard that simply returns. The option those guards serve
 *   (`hierarchyCompletion`) defaults to ON, so a caller who never touched it gets a feature that reports success while
 *   doing nothing. That is absence read as a negative answer, and the rule is that a magnitude never carries its own
 *   absence: the gap has to be stated somewhere a caller can read it.
 *
 *   This module states it. `describeCapabilityGaps` is pure and cheap enough to run at construction; the resolver
 *   exposes the result on `Resolver.capabilityGaps` and warns once so the gap appears in a log without a caller having
 *   to ask. It changes no resolution behavior — a gap that was silent is now legible, nothing more.
 */

import type { BackendCapabilityGap, ResolverBackend } from "@mailwoman/core/resolver"

/**
 * The optional backend methods whose absence degrades a passing default, paired with what stops working. A method whose
 * absence is inert (or whose option is opt-in and therefore a deliberate caller choice) does not belong here — the list
 * exists to name silent degradation, not to inventory the interface.
 */
const CONSEQUENTIAL_CAPABILITIES: ReadonlyArray<Omit<BackendCapabilityGap, "backend">> = [
	{
		capability: "ancestors",
		gates: "hierarchyCompletion",
		defaultOn: true,
		degrades:
			"the containment lineage is never read: a parse that drops the locality of a city-state or dependent locality keeps the gap, and `metadata.ancestors` (the lineage the Nominatim and Photon drop-ins expose) is never populated",
	},
	{
		capability: "coincidentLocalitiesFor",
		gates: "hierarchyCompletion",
		defaultOn: true,
		degrades:
			"the dual-role pass never runs: a region that is also a locality under the same name resolves to one role only",
	},
]

/**
 * Enumerate the consequential capabilities this backend does not implement. Empty means every default-ON option the
 * resolver offers has the backend support it needs.
 */
export function describeCapabilityGaps(backend: ResolverBackend): readonly BackendCapabilityGap[] {
	const name = backend.constructor?.name || "backend"

	return CONSEQUENTIAL_CAPABILITIES.filter((c) => typeof backend[c.capability] !== "function").map(
		(c): BackendCapabilityGap => ({ ...c, backend: name })
	)
}

/**
 * One log line for a backend's whole set of gaps. Deliberately short: what is missing, which option that costs, and
 * where the consequences are written down. The per-gap `degrades` prose stays on the data for a consumer that wants it,
 * because a line long enough to carry it is a line an operator learns to skip.
 */
export function formatCapabilityGaps(gaps: readonly BackendCapabilityGap[]): string {
	const [first] = gaps
	const names = gaps.map((g) => `${g.capability}()`).join(", ")
	const options = [...new Set(gaps.map((g) => g.gates))].join(", ")
	const posture = gaps.some((g) => g.defaultOn) ? "default-ON" : "opt-in"

	return `[resolver] ${first?.backend} lacks ${names} — ${options} (${posture}) silently no-ops; see docs/engineering/reference/resolver-backends.mdx`
}

/**
 * Backends already reported, so a process that builds many resolvers over one artifact — the eval harness, the
 * gauntlet, a batch worker — states the gap once rather than once per construction.
 */
const reported = new Set<string>()

/**
 * Report a backend's gaps to stderr the first time this process sees them. The gaps are data on
 * `Resolver.capabilityGaps` regardless; this exists so they also reach an operator who never thought to look. The line
 * disappears on its own once the backend implements the methods, so it cannot become permanent wallpaper.
 */
export function reportCapabilityGaps(gaps: readonly BackendCapabilityGap[]): void {
	const [first] = gaps

	if (!first || reported.has(first.backend)) return
	reported.add(first.backend)

	console.error(formatCapabilityGaps(gaps))
}
