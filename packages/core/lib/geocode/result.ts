// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The geocode result: the data shape one geocoded input projects to.
 *
 * The schemas here define the shapes, and each type is inferred from its schema.
 * The `mailwoman` package computes the result and the HTTP surfaces serve it.
 */

import { RESOLUTION_TIERS } from "@mailwoman/annotations/geo"
import { DerivationProjectionSchema, EpistemicStatusSchema } from "@mailwoman/evidence"
import { z } from "zod"

import { DroppedSpanSchema } from "#decoder/serialize/json"
import { ComponentTagSchema } from "#decoder/types"
import { QueryIntentMarkerSchema } from "#pipeline/types"
import { ScoreUnmeasuredReason } from "#resolver/types"

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
 * Why a candidate's `score` is null.
 */
export const ScoreUnmeasuredReasonSchema = z
	.enum(Object.values(ScoreUnmeasuredReason))
	.meta({ id: "ScoreUnmeasuredReason", description: "Why a candidate's score is null." })

/**
 * One member of a place's outcome set.
 */
export const OutcomeMembershipSchema = z
	.object({
		/**
		 * The outcome kind, such as `natural.mountain`.
		 */
		outcome: z.string(),
		/**
		 * True when one source asserts the member and another denies it.
		 * The member stays in the set.
		 */
		contested: z.boolean(),
		/**
		 * Where the member came from: the data layer and `default` or `asserted`, as in `landmarks:asserted`.
		 */
		sources: z.array(z.string()),
	})
	.meta({ id: "OutcomeMembership", description: "One member of a place's outcome set." })

/**
 * Whether the loaded model reads the outcome hint and has an outcome head.
 */
export const OutcomeHintModelSchema = z
	.enum(["applied", "unsupported"])
	.meta({ id: "OutcomeHintModel", description: "Whether the loaded model reads the outcome hint." })

/**
 * One place the resolver weighed for a parsed span: the winner first, then the places it passed over.
 */
export const GeocodeCandidateSchema = z
	.object({
		/**
		 * The resolved gazetteer name.
		 */
		name: z.string(),
		/**
		 * The parsed span's component tag.
		 */
		tag: z.string(),
		/**
		 * The raw parsed span.
		 */
		value: z.string(),
		/**
		 * The gazetteer placetype of the place, such as `locality` or `region`.
		 */
		placetype: z.string(),
		lat: z.number(),
		lon: z.number(),
		countryCode: z.string().nullable(),
		placeID: z.string().nullable(),
		/**
		 * The resolver's ranking score for this candidate, larger ranking higher.
		 *
		 * Scores compare candidates within one span and have no unit across spans or answers.
		 * The field is null when the score is a rank without a measurement behind it.
		 * `scoreUnmeasured` then holds the reason.
		 */
		score: z.number().nullable(),
		/**
		 * Why `score` is null: `population_unrecorded` when the gazetteer ranks by a population
		 * it doesn't record for the place, `unrecorded` when the resolver recorded no score.
		 *
		 * The field is absent when `score` holds a value.
		 */
		scoreUnmeasured: ScoreUnmeasuredReasonSchema.optional(),
		/**
		 * True when the input matched an alias of this place, such as a former name, and differs from `name`.
		 *
		 * The field is absent when the input matched the primary name.
		 */
		matchedAlias: z.literal(true).optional(),
		/**
		 * True when a hard scope excluded this place: it lies outside the default country
		 * or the caller's parent place, so it couldn't answer.
		 *
		 * The field is absent for a place inside the scope.
		 */
		outsideScope: z.literal(true).optional(),
		/**
		 * The place's outcome set, each member with its `contested` flag and its sources.
		 *
		 * The field is present when the request set `outcomeHint` or `outcomeFilter`.
		 */
		outcomes: z.array(OutcomeMembershipSchema).optional(),
	})
	.meta({ id: "GeocodeCandidate", description: "A place the resolver weighed for one parsed span." })

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
 * - `postcode_move_refused`: the postcode resolved too far from the selected locality.
 * - `rooftop_outside_locality`: the address-point row lies too far from the selected
 *   locality, and no alternative locality lies near it.
 *   The coordinate is the rooftop.
 *   The hierarchy still holds the selected locality.
 *   The rooftop contradicts that locality.
 */
export const UnfollowedComponentSchema = z.object({
	tag: ComponentTagSchema,
	value: z.string(),
	reason: z.enum(["postcode_move_refused", "rooftop_outside_locality"]),
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
 * The register row that supplied an `address_point` or `interpolated` coordinate,
 * as the row itself records it.
 */
export const CoordinateSourceSchema = z
	.object({
		/**
		 * The row's provenance stamp, verbatim: `openstreetmap:nz` for a row an operator built
		 * from an OpenStreetMap extract, `overture:NAD` for an Overture row, and so on.
		 */
		source: z.string(),
		/**
		 * The data release the row came from, as the row records it, or null when the resolved tree
		 * records no release value, as may happen with a tree a client sends to `/v1/resolve`.
		 */
		release: z.string().nullable(),
	})
	.meta({ id: "CoordinateSource", description: "The register row that supplied the coordinate." })

export type CoordinateSource = z.infer<typeof CoordinateSourceSchema>

/**
 * The service-level credit the OpenStreetMap Foundation's Geocoding Guideline asks
 * of a public geocoder that serves OpenStreetMap data.
 */
export const OPENSTREETMAP_CREDIT = "© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright"

/**
 * Whether a row's provenance stamp identifies an OpenStreetMap-derived row.
 *
 * `@mailwoman/osm` stamps every row it builds `openstreetmap:<cc>`, and a row the
 * street-recovery pass placed `openstreetmap:<cc>#recovered`, so the prefix decides.
 */
export function isOpenStreetMapSource(source: string | null | undefined): boolean {
	return typeof source === "string" && source.startsWith("openstreetmap:")
}

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
		 * Consumers may display them but mustn't filter on them.
		 */
		rooftop: RooftopSchema.nullable(),

		/**
		 * The register row that supplied the coordinate, with its provenance stamp and release.
		 *
		 * Set on the `address_point` and `interpolated` tiers.
		 * Their coordinates come from one register row.
		 *
		 * A landmark answer also sets it, at the `venue` tier.
		 * Its source is the landmark record's `landmark_source`, or `wikidata`
		 * when the record names none, and its release is null.
		 *
		 * It is null on every other tier, including a coordinate a later pass moved to a venue
		 * or a plus code, because that coordinate no longer comes from the row.
		 */
		coordinate_source: CoordinateSourceSchema.nullable(),

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
		 * The places the resolver weighed, grouped by parsed span.
		 *
		 * The primary place's span comes first, its winner at the head of the list.
		 * Each other resolved span follows with the places it passed over.
		 *
		 * Within a span, the resolver's ranked runner-ups come first, then the side-probe
		 * winners and the places a later pass replaced.
		 * A place appears once, under the first span that weighed it.
		 *
		 * A span lists at most 10 places and the list holds at most 25.
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
		 * Downstream ranking doesn't read it.
		 */
		admin_coherence: AdminCoherenceReportSchema.nullable(),

		/**
		 * The answer from a configured authoritative provider, reported alongside Mailwoman's own answer.
		 *
		 * The field is null when no provider is configured.
		 * Every value inside comes from the provider, including `refused` and `transport_error`.
		 */
		authoritative: AuthoritativeAssertionSchema.nullable(),

		/**
		 * `unsupported` when the loaded model has no outcome head, so only the resolver read
		 * the request's outcome fields, and `applied` when the model read them too.
		 *
		 * The field is present when the request set `outcomeHint` or `outcomeFilter`.
		 */
		outcome_hint_model: OutcomeHintModelSchema.optional(),
	})
	.meta({ id: "GeocodeResult", description: "One geocoded input: its coordinate, tier, components and evidence." })

export type GeocodeResult = z.infer<typeof GeocodeResultSchema>
