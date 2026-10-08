/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The geocode result: the data shape one geocoded input projects to.
 *
 * The schemas here are the source of truth and each type is inferred from its schema.
 * The `mailwoman` package computes the result and the HTTP surfaces serve it.
 */

import { RESOLUTION_TIERS } from "@mailwoman/annotations/geo"
import { DerivationProjectionSchema, EpistemicStatusSchema } from "@mailwoman/evidence"
import { z } from "zod"

import { DroppedSpanSchema } from "#decoder/serialize/json"
import { ComponentTagSchema } from "#decoder/types"
import { QueryIntentMarkerSchema } from "#pipeline/types"

/**
 * The geocoder resolution tier that produced a coordinate.
 */
export const ResolutionTierSchema = z
	.enum(RESOLUTION_TIERS)
	.meta({ id: "ResolutionTier", description: "The geocoder tier that produced the coordinate." })

/**
 * One entry of {@link GeocodeResult.hierarchy}, locality to country, most specific first.
 */
export const HierarchyEntrySchema = z
	.object({
		tag: z.string(),
		/**
		 * The raw parsed span.
		 */
		value: z.string(),
		/**
		 * The resolved gazetteer name.
		 */
		name: z.string(),
		lat: z.number().nullable(),
		lon: z.number().nullable(),
		placeID: z.string().nullable(),
		/**
		 * `true` when the winner's ancestor chain vouches for this entry, `false` when it
		 * resolved outside the winner's lineage, and `null` when the lineage is unverifiable.
		 */
		in_winner_lineage: z.boolean().nullable(),
	})
	.meta({ id: "HierarchyEntry", description: "One resolved admin level, most specific first." })

export type HierarchyEntry = z.infer<typeof HierarchyEntrySchema>

/**
 * One ranked alternative place: the winner first, then same-query runner-ups.
 */
export const GeocodeCandidateSchema = z
	.object({
		name: z.string(),
		tag: z.string(),
		lat: z.number(),
		lon: z.number(),
		countryCode: z.string().nullable(),
		placeID: z.string().nullable(),
	})
	.meta({ id: "GeocodeCandidate", description: "A ranked candidate place." })

export type GeocodeCandidate = z.infer<typeof GeocodeCandidateSchema>

/**
 * The verdict for one parsed admin qualifier.
 */
export const AdminCoherenceVerdictSchema = z.enum(["confirmed", "contradicted", "unstated", "unverifiable"])

export type AdminCoherenceVerdict = z.infer<typeof AdminCoherenceVerdictSchema>

/**
 * Whether the variant-alias exemption lifted a node's winner past the cross-country alias penalty.
 */
export const VariantAliasExemptionSchema = z
	.enum(["applied", "not_applied"])
	.meta({ id: "VariantAliasExemption", description: "Whether the variant-alias exemption chose a node's winner." })

export type VariantAliasExemption = z.infer<typeof VariantAliasExemptionSchema>

/**
 * Whether the winner's resolved ancestry confirms, contradicts or cannot check
 * the parsed `region` and `country`.
 *
 * `unstated` is the explicit claim that the input had no such qualifier.
 */
export const AdminCoherenceReportSchema = z
	.object({ region: AdminCoherenceVerdictSchema, country: AdminCoherenceVerdictSchema })
	.meta({ id: "AdminCoherenceReport", description: "Flag-only verdicts for the parsed region and country." })

export type AdminCoherenceReport = z.infer<typeof AdminCoherenceReportSchema>

/**
 * One authoritative-provider match, field for field from the provider's answer.
 */
export const AuthoritativeAssertionMatchSchema = z.object({
	provider_place_id: z.string(),
	object_ids: z.record(z.string(), z.string()).nullable(),
	canonical_fields: z.record(z.string(), z.string()).nullable(),
	lat: z.number().nullable(),
	lon: z.number().nullable(),
	precision: z.string().nullable(),
	match_status: z.enum(["exact", "approximate"]),
	provider_score: z.number().nullable(),
})

export type AuthoritativeAssertionMatch = z.infer<typeof AuthoritativeAssertionMatchSchema>

/**
 * A configured authoritative provider's answer.
 *
 * `status` is the provider's response status plus `transport_error`.
 * `matches` is non-null exactly when the provider returned candidates: one for `matched`,
 * all of them in the provider's order for `ambiguous`.
 */
export const AuthoritativeAssertionSchema = z
	.object({
		provider: z.string(),
		status: z.enum(["matched", "ambiguous", "refused", "transport_error"]),
		matches: z.array(AuthoritativeAssertionMatchSchema).nullable(),
		attribution: z.string().nullable(),
		license: z.string().nullable(),
		retrieved_at: z.string().nullable(),
		dataset_version: z.string().nullable(),
		/**
		 * `transport_error` only: the thrown message, verbatim.
		 */
		error: z.string().nullable(),
	})
	.meta({ id: "AuthoritativeAssertion", description: "A configured authoritative provider's answer." })

export type AuthoritativeAssertion = z.infer<typeof AuthoritativeAssertionSchema>

/**
 * A parsed component that the answer's coordinate ignored.
 *
 * The only current `reason`, `postcode_move_refused`, means the postcode resolved
 * too far from the selected locality.
 */
export const UnfollowedComponentSchema = z.object({
	tag: ComponentTagSchema,
	value: z.string(),
	reason: z.literal("postcode_move_refused"),
	/**
	 * The distance in kilometers that following this component would have moved the answer.
	 */
	distance_km: z.number(),
})

export type UnfollowedComponent = z.infer<typeof UnfollowedComponentSchema>

/**
 * The locality key and postcode stored on the matched address-point row.
 */
export const RooftopSchema = z.object({ localityNorm: z.string().nullable(), postcode: z.string().nullable() })

export type Rooftop = z.infer<typeof RooftopSchema>

/**
 * The poi.db entity that supplied a `venue`-tier coordinate.
 */
export const GeocodeEntitySchema = z.object({
	name: z.string(),
	categoryID: z.string().nullable(),
	confidence: z.number(),
	country: z.string(),
})

export type GeocodeEntity = z.infer<typeof GeocodeEntitySchema>

/**
 * The result of geocoding one input.
 */
export const GeocodeResultSchema = z
	.object({
		input: z.string(),

		/**
		 * Every parsed component, projected from the resolved tree.
		 *
		 * It includes locale-specific tags, such as `prefecture` and `block`, that the fixed fields omit.
		 */
		components: z.partialRecord(ComponentTagSchema, z.string()),

		/**
		 * Spans that the one-value-per-tag projection dropped.
		 * The field is null unless some were dropped.
		 */
		dropped_components: z.array(DroppedSpanSchema).nullable(),

		/**
		 * Components in `components` that the coordinate ignored.
		 * The field is null unless some exist.
		 */
		unfollowed_components: z.array(UnfollowedComponentSchema).nullable(),
		lat: z.number().nullable(),
		lon: z.number().nullable(),
		resolution_tier: ResolutionTierSchema,

		/**
		 * What may be claimed about the coordinate.
		 *
		 * It varies independently of `resolution_tier`.
		 * A rooftop answer is `designated` when its register is declared complete
		 * and `observed` when it comes from a crowdsourced extract.
		 */
		epistemic_status: EpistemicStatusSchema,

		/**
		 * The derivation behind this answer.
		 *
		 * It is null unless the caller supplied a resolver trace sink.
		 */
		derivation: DerivationProjectionSchema.nullable(),

		/**
		 * The poi.db entity that supplied the coordinate.
		 * It is null unless the `venue` tier answered.
		 */
		entity: GeocodeEntitySchema.nullable(),

		/**
		 * The locality key and postcode stored on the matched address-point row.
		 *
		 * These values describe the rooftop rather than the query.
		 * Consumers may display them but must not filter on them.
		 */
		rooftop: RooftopSchema.nullable(),

		/**
		 * The uncertainty radius in meters, or null when the tier reports none.
		 */
		uncertainty_m: z.number().nullable(),
		locality: z.string().nullable(),
		region: z.string().nullable(),
		postcode: z.string().nullable(),

		/**
		 * The parsed house number, filled on every tier.
		 *
		 * Only the `address_point` and `interpolated` tiers place the coordinate at the house.
		 */
		house_number: z.string().nullable(),

		/**
		 * The parsed street name, reassembled from prefix, base and suffix.
		 */
		street: z.string().nullable(),

		/**
		 * The parsed venue span.
		 */
		venue: z.string().nullable(),

		/**
		 * The parsed dependent-locality span.
		 *
		 * It appears here even when `hierarchy` omits it for lack of a gazetteer match.
		 */
		dependent_locality: z.string().nullable(),

		/**
		 * The parsed unit or sub-venue span, such as `Suite 300` or `Apt 4B`.
		 */
		unit: z.string().nullable(),

		/**
		 * The uppercase ISO 3166-1 alpha-2 code from the first node that includes a resolver country.
		 */
		countryCode: z.string().nullable(),

		/**
		 * The admin hierarchy from the resolver, most specific first.
		 */
		hierarchy: z.array(HierarchyEntrySchema),

		/**
		 * Candidate places for the query's primary place.
		 *
		 * The winner comes first, followed by the resolver's alternatives with distinct coordinates.
		 */
		candidates: z.array(GeocodeCandidateSchema),

		/**
		 * The country that the postcode-country coherence pass scoped the resolve to.
		 *
		 * It is null unless the pass overrode the default country.
		 */
		postcode_country_scope: z.string().nullable(),

		/**
		 * The promoted candidate's country.
		 *
		 * It is null unless capital promotion changed a node's leading candidate.
		 */
		capital_promotion: z.string().nullable(),

		/**
		 * `applied` when the variant-alias exemption lifted a node's winner past
		 * the cross-country alias penalty.
		 */
		variant_alias_exemption: VariantAliasExemptionSchema,

		/**
		 * Query-intent advisories.
		 * They never change the answer.
		 *
		 * The field is always present.
		 * An empty array means no intent marker matched.
		 */
		intent_markers: z.array(QueryIntentMarkerSchema),

		/**
		 * Whether the winner's resolved ancestry confirms, contradicts or cannot
		 * check the parsed `region` and `country`.
		 *
		 * It is non-null whenever a winner resolved.
		 * Downstream ranking does not read it.
		 */
		admin_coherence: AdminCoherenceReportSchema.nullable(),

		/**
		 * The answer from a configured authoritative provider, reported alongside Mailwoman's own answer.
		 *
		 * The field is null when no provider is configured.
		 * Every value inside comes from the provider, including `refused` and `transport_error`.
		 */
		authoritative: AuthoritativeAssertionSchema.nullable(),
	})
	.meta({ id: "GeocodeResult", description: "One geocoded input: its coordinate, tier, components and evidence." })

export type GeocodeResult = z.infer<typeof GeocodeResultSchema>
