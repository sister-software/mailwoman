import { formatPersonName } from "@mailwoman/record/name"
import type { GeoFeatureCollection, PointLiteral } from "@mailwoman/spatial"

import { toFeature } from "#geojson"
import type { EntityGeoData, ReconciliationBucket, ResolvedEntity } from "#types"

/**
 * Which source labels denote eligibility vs funding/enrollment.
 */
export interface ReconcileConfig {
	/**
	 * Source labels that denote membership in the eligibility set.
	 */
	eligibilitySources: readonly string[]

	/**
	 * Source labels that denote enrollment, funding or program participation.
	 */
	fundingSources: readonly string[]
}

/**
 * One entity, classified.
 */
export interface ReconciledEntity {
	entity: ResolvedEntity

	/**
	 * The distinct, sorted source labels across the entity's records.
	 */
	sources: string[]
	bucket: ReconciliationBucket
}

/**
 * Holds the entities that {@link reconcileCoverage} placed in a bucket, with a count per bucket.
 */
export interface ReconciliationResult {
	/**
	 * Entities with at least one eligibility or funding source, each assigned a bucket.
	 */
	reconciled: ReconciledEntity[]
	counts: Record<ReconciliationBucket, number>
}

/**
 * Places an entity in a reconciliation bucket according to whether its source labels
 * include eligibility sources, funding sources, or both.
 *
 * @returns `null` when the entity has neither kind of source, so callers exclude it rather than miscount it.
 */
export function bucketOf(sources: Iterable<string>, config: ReconcileConfig): ReconciliationBucket | null {
	const elig = new Set(config.eligibilitySources)
	const fund = new Set(config.fundingSources)
	let hasEligibility = false
	let hasFunding = false

	for (const s of sources) {
		if (elig.has(s)) {
			hasEligibility = true
		}

		if (fund.has(s)) {
			hasFunding = true
		}
	}

	if (hasEligibility && hasFunding) return "enrolled"

	if (hasEligibility) return "eligible-not-enrolled"

	if (hasFunding) return "funded-not-eligible"

	return null
}

/**
 * Buckets resolved entities by their sources with {@link bucketOf}, and drops those
 * that have neither eligibility nor funding sources.
 */
export function reconcileCoverage(entities: readonly ResolvedEntity[], config: ReconcileConfig): ReconciliationResult {
	const reconciled: ReconciledEntity[] = []

	const counts: Record<ReconciliationBucket, number> = {
		enrolled: 0,
		"eligible-not-enrolled": 0,
		"funded-not-eligible": 0,
	}

	for (const entity of entities) {
		const sources = [...new Set(entity.records.map((r) => r.source).filter((s): s is string => !!s))].toSorted()
		const bucket = bucketOf(sources, config)

		if (!bucket) continue

		reconciled.push({ entity, sources, bucket })

		counts[bucket]++
	}

	return { reconciled, counts }
}

/**
 * Returns a display name for an entity's representative record: the organization's
 * canonical name, else the person's name, else the record id.
 */
export function repName(entity: ResolvedEntity): string {
	const rep = entity.representative
	const person = formatPersonName(rep.name, "short")

	return rep.organization?.canonical ?? (person || rep.id)
}

/**
 * Converts the located reconciled entities to point features tagged with their bucket,
 * the shape {@link toMapHTML} colors by bucket.
 */
export function reconciliationGeoJSON(result: ReconciliationResult): GeoFeatureCollection<PointLiteral, EntityGeoData> {
	return {
		type: "FeatureCollection",
		features: result.reconciled
			.filter((c) => c.entity.coordinate)
			.map((c) => toFeature(c.entity, { bucket: c.bucket, name: repName(c.entity) })),
	}
}

/**
 * Configures the title, optional notes and spot-check length of {@link reconciliationReport}.
 */
export interface ReconciliationReportOptions {
	/**
	 * The report's level-one heading, default "Coverage reconciliation — eligibility ↔ enrollment".
	 */
	title?: string

	/**
	 * An italic paragraph under the title describing the sources and how they were scoped.
	 */
	scopeNote?: string

	/**
	 * A paragraph explaining the choice of match scorer.
	 */
	scorerNote?: string

	/**
	 * A sentence about sampling or capping, prepended to the closing caveat.
	 */
	sampleNote?: string

	/**
	 * How many "eligible, not enrolled" entities the spot-check lists, default 15.
	 */
	spotCheckLimit?: number
}

/**
 * Renders a Markdown reconciliation report with the bucket counts, the enrolled rate,
 * a spot-check of eligible-but-not-enrolled entities, and a fixed caveat.
 *
 * The enrolled rate is reported as a floor, because incomplete resolution can only miss links.
 */
export function reconciliationReport(result: ReconciliationResult, options: ReconciliationReportOptions = {}): string {
	const { counts, reconciled } = result
	const title = options.title ?? "Coverage reconciliation — eligibility ↔ enrollment"
	const spotCheckLimit = options.spotCheckLimit ?? 15
	const eligibleTotal = counts.enrolled + counts["eligible-not-enrolled"]
	const enrolledRate = eligibleTotal > 0 ? (100 * counts.enrolled) / eligibleTotal : 0

	const lines: string[] = [`# ${title}`, ""]

	if (options.scopeNote) {
		lines.push(`_${options.scopeNote}_`)
		lines.push("")
	}

	if (options.scorerNote) {
		lines.push(options.scorerNote)
		lines.push("")
	}

	lines.push(`## The reconciliation`)
	lines.push("")
	lines.push(`| bucket | entities | meaning |`)
	lines.push(`|---|---:|---|`)
	lines.push(`| **enrolled** | ${counts.enrolled} | resolves to an eligibility record AND a funding record |`)

	lines.push(
		`| **eligible, not enrolled** | ${counts["eligible-not-enrolled"]} | eligibility record, no funding record resolved (the **anti-join**) |`
	)

	lines.push(
		`| **funded, not in eligibility set** | ${counts["funded-not-eligible"]} | funding record, no eligibility record resolved |`
	)

	lines.push("")

	lines.push(
		`Of the ${eligibleTotal} entities with an eligibility record, ${enrolledRate.toFixed(1)}% also resolve to a ` +
			`funding record — a **floor**, not a coverage rate (imperfect resolution + any sampling only ever miss ` +
			`links, never invent them). The deliverable is the anti-join SET, not this percentage.`
	)

	lines.push("")
	lines.push(`## Anti-join spot-check — first ${spotCheckLimit} "eligible, not enrolled"`)
	lines.push("")
	lines.push(`| entity | sources | name | coordinate |`)
	lines.push(`|---|---|---|---|`)

	for (const c of reconciled.filter((x) => x.bucket === "eligible-not-enrolled").slice(0, spotCheckLimit)) {
		const coord = c.entity.coordinate
			? `${c.entity.coordinate.latitude.toFixed(4)}, ${c.entity.coordinate.longitude.toFixed(4)}`
			: "—"

		lines.push(`| ${c.entity.id} | ${c.sources.join(", ")} | ${repName(c.entity)} | ${coord} |`)
	}

	lines.push("")
	lines.push(`## The caveat that matters`)
	lines.push("")
	const sample = options.sampleNote ? `${options.sampleNote} ` : ""

	lines.push(
		`${sample}This is a **set-membership reconciliation, not a determination**. A missing funding record can mean ` +
			`the entity didn't apply, applied under a name we didn't resolve, is ineligible, or any number of things. We ` +
			`produce the reconciled join and surface the candidate set; **what a gap means, and whether to act on it, is ` +
			`entirely the data consumer's call.** Nothing here is an allegation.`
	)

	lines.push("")

	return lines.join("\n")
}
