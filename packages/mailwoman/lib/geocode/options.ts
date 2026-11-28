// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The options of a geocode session, declared once.
 *
 *   {@linkcode GeocodeSessionOptionsSchema} states each option's type and default.
 *   The session's option type, the geocode command's flag defaults and its config file all read it.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { VariantAliasExemptionSchema } from "@mailwoman/core/geocode"
import type { ChannelPins } from "@mailwoman/core/pipeline"
import { type DefaultCountrySource, ScopeStrength, type WeakResolutionReading } from "@mailwoman/core/resolver"
import type { OutcomeVocabularyLike } from "@mailwoman/core/resolver/outcome"
import { DEFAULT_VENUE_HEAD_BIAS_SCALE } from "@mailwoman/neural/prior/venue-head"
import { DEFAULT_WEIGHTS_LOCALE } from "@mailwoman/neural/weights/families"
import type { PathBuilderLike } from "path-ts"
import { z } from "zod"

import type { CapitalTier } from "#engine/resolver-backend"
import { GEOCODE_SWITCH_DEFAULTS } from "#geocode/options/switches"

/**
 * The locale a geocode parses under when the caller chooses none.
 *
 * It is the default weights locale by definition: a session's locale selects its weights package, and
 * a session built on a parser's scope reuses the classifier `createParser` loaded under that default.
 *
 * A session left at this locale states no country, since every caller starts from it.
 */
export const GEOCODE_DEFAULT_LOCALE = DEFAULT_WEIGHTS_LOCALE

/**
 * Where the value of a session option came from.
 *
 * - `"flag"`: a flag the user typed on a command line.
 * - `"config_file"`: a config file's `geocode` key.
 * - `"caller"`: a program that stated the option when it built the session's options.
 * - `"default"`: the default {@linkcode GeocodeSessionOptionsSchema} declares,
 *   because no source stated the option.
 */
export const SessionOptionSource = {
	Flag: "flag",
	ConfigFile: "config_file",
	Caller: "caller",
	Default: "default",
} as const

export type SessionOptionSource = (typeof SessionOptionSource)[keyof typeof SessionOptionSource]

/**
 * An on/off option whose default is the one `geocodeAddress` applies for a caller with no session.
 */
function switchOption(name: keyof typeof GEOCODE_SWITCH_DEFAULTS) {
	return z.boolean().default(GEOCODE_SWITCH_DEFAULTS[name])
}

/**
 * Every option of a geocode session that a JSON value can state, with its default.
 *
 * A config file may set each key except three. {@linkcode GeocodeFileOptionsSchema} leaves those out:
 *
 * - `trace` makes each decode record its trace and changes what a run returns.
 *   The debug view and the diagnostic tools turn it on for themselves.
 * - `diagnoseUnreachable` acts only under `trace`, so it belongs to the same callers.
 * - `parentPlace.source` records who chose the parent, and a file's parent is always the caller's.
 *
 * {@linkcode GeocodeSessionProgramOptions} holds the options no JSON value can state.
 *
 * A key the object doesn't declare is refused.
 */
export const GeocodeSessionOptionsSchema = z.strictObject({
	/**
	 * The locale tag of the weights package the session parses with, such as `en-US` or `fr-FR`.
	 */
	locale: z.string().min(1).default(GEOCODE_DEFAULT_LOCALE),

	/**
	 * An npm `--prefix` cache root to load weights from instead of the installed package.
	 *
	 * Session creation fails when this root lacks the locale's package, because it never falls back.
	 */
	weightsCacheRoot: z.string().optional(),

	/**
	 * Points the resolver prefers candidates near, as `lat,lon[:weight];lat,lon`.
	 */
	bias: z.string().optional(),

	/**
	 * An ISO 3166-1 country that scopes the resolver, or `none` to turn the scope off.
	 */
	defaultCountry: z.string().optional(),

	/**
	 * Whether the locale's country scopes the resolver.
	 *
	 * - `auto`: it filters unless the address shows evidence of another country.
	 *   `decideCountryScope` in `#geocode/scope/inferred` states that evidence, and each
	 *   run's `applied.countryScope.withheld` gives the reason when the scope yielded.
	 * - `locale`: it always filters, as `defaultCountry` set to the locale's country does.
	 * - `none`: it never scopes.
	 */
	countryScope: z.enum(["auto", "locale", "none"]).default("auto"),

	/**
	 * The path of a WOF admin SQLite distribution to resolve against.
	 */
	resolveDB: z.string().optional(),

	/**
	 * The path of a byte-range candidate database to resolve against.
	 */
	candidateDB: z.string().optional(),

	/**
	 * The path of one address-point database, in place of the one selected by region.
	 */
	addressPointsDB: z.string().optional(),

	/**
	 * The path of one interpolation database, in place of the one selected by region.
	 */
	interpolationDB: z.string().optional(),

	/**
	 * One interpolation uncertainty multiplier, in place of the calibrated per-region table.
	 */
	interpCalibration: z.number().optional(),

	/**
	 * Whether a locale country the address's evidence withheld still ranks the resolver's candidates.
	 */
	localeCountryPrior: z.boolean().default(false),

	/**
	 * Whether to feed the gazetteer FST prior to the parse.
	 */
	gazetteerPrior: z.boolean().default(true),

	/**
	 * Whether to feed the venue-head prior to the parse, using the head words of the
	 * default country, or of the locale's country when no default country is set.
	 */
	venueHeadPrior: z.boolean().default(true),

	/**
	 * Multiplier on the venue-head table's biases.
	 * Each bias is a log rate ratio.
	 */
	venueHeadBiasScale: z.number().default(DEFAULT_VENUE_HEAD_BIAS_SCALE),

	/**
	 * Whether the street-morphology matcher biases a street affix on a segment that opens
	 * with a house number, as `Plaza` in `30 Rockefeller Plaza, New York, NY 10112`.
	 */
	streetMorphologyPrior: z.boolean().default(true),

	/**
	 * Whether the coarse placer's country prior applies.
	 */
	placeCountry: z.boolean().default(true),

	/**
	 * The probability below which the coarse placer abstains.
	 */
	placeCountryThreshold: z.number().min(0).max(1).default(0.9),

	/**
	 * Whether a fork parse that doesn't resolve probes the POI data for an exact entity.
	 */
	forkEntity: z.boolean().default(true),

	/**
	 * Whether to enable the venue tier for `poi.db` entity upgrades.
	 */
	poiVenueTier: switchOption("poiVenueTier"),

	/**
	 * The national-capital promotion among same-name candidates for a bare place name.
	 */
	capitalTier: z.enum(["auto", "required", "off"] satisfies CapitalTier[]).default("auto"),

	/**
	 * Whether own-name `variant` aliases skip the cross-country primary-name penalty,
	 * affecting only the candidate backend and requiring the `name_role` column.
	 */
	variantAliasExemption: VariantAliasExemptionSchema.default("applied"),

	/**
	 * Which reading of a weak resolution lifts the span-rescore brake, or none for the shipped brake.
	 */
	spanRescoreWeakResolution: z.enum(["score", "containment", "either"] satisfies WeakResolutionReading[]).optional(),

	/**
	 * Whether coherent postcode and locality evidence overrides a country scope that disagrees with it.
	 */
	postcodeCountryCoherence: switchOption("postcodeCountryCoherence"),

	/**
	 * Whether a postcode span is excluded when its shape fits no postcode syntax
	 * of a country the address mentions.
	 */
	postcodeShapeCoherence: switchOption("postcodeShapeCoherence"),

	/**
	 * Whether the postcode's centroid re-ranks locality candidates.
	 */
	postcodeContainmentCoherence: switchOption("postcodeContainmentCoherence"),

	/**
	 * Whether a parsed region re-ranks locality candidates by admin containment.
	 */
	adminContainmentRerank: switchOption("adminContainmentRerank"),

	/**
	 * Whether a parsed dependent locality resolves inside its parent and answers the coordinate.
	 */
	dependentLocalityContainment: switchOption("dependentLocalityContainment"),

	/**
	 * Whether a `locality` span written with its country's county designator resolves as
	 * its region's county when no locality of that name is in the region.
	 */
	countyDesignatorFallback: switchOption("countyDesignatorFallback"),

	/**
	 * Whether a `subregion` or `region` value that no current division answers is accepted without scoping
	 * the result, when the value is the name of a former division linked to the resolved locality.
	 *
	 * The session reads the former divisions table when it's on, and fails when the table is absent.
	 */
	formerDivisions: switchOption("formerDivisions"),

	/**
	 * Whether a soft country scope acts inside retrieval, the locale head's contradicting
	 * country stands in as a soft scope, and a hard scope reports the places it excluded.
	 */
	scopeCountryRetrieval: switchOption("scopeCountryRetrieval"),

	/**
	 * Whether one of two `locality` spans resolves inside the other when the gazetteer contains it there.
	 */
	siblingLocalityContainment: switchOption("siblingLocalityContainment"),

	/**
	 * Whether the placetype-pair prior leaves separator pieces unbiased.
	 */
	pairPriorWordPieces: switchOption("pairPriorWordPieces"),

	/**
	 * Whether a segment child's placetype-pair bias leaves out its same-field postcode.
	 */
	pairPriorChildPostcodeStrip: switchOption("pairPriorChildPostcodeStrip"),

	/**
	 * Whether the placetype-pair index applies only when the parse's country is the index's:
	 * the default country when set, else the locale's country.
	 */
	pairIndexOwnCountry: switchOption("pairIndexOwnCountry"),

	/**
	 * Whether a parse takes the gazetteer FST of the country the locale head
	 * confidently reads, when that country ships one.
	 */
	fstCountryRouting: switchOption("fstCountryRouting"),

	/**
	 * Whether a bare name's candidates are grouped by the outcome head's readings
	 * when a request sets no hint.
	 *
	 * It stays off until a `pass` release verdict, and it needs a model with an outcome head.
	 */
	outcomeHeadOrdering: switchOption("outcomeHeadOrdering"),

	/**
	 * A parent place that scopes every lookup, such as a borough, city, region or country.
	 */
	parentPlace: z
		.strictObject({
			/**
			 * The gazetteer id of the parent place.
			 */
			id: z.number().int().positive(),

			/**
			 * Who chose the parent.
			 */
			source: z.enum(["caller", "inferred"] satisfies DefaultCountrySource[]).default("caller"),

			/**
			 * Whether the parent filters candidates or ranks the ones inside it first.
			 */
			strength: z.enum([ScopeStrength.Hard, ScopeStrength.Soft]),
		})
		.optional(),

	/**
	 * Whether to record a `GeocodeTrace` per input.
	 *
	 * The trace comes from the decode that builds the answer.
	 * That decode then also records its intermediates.
	 */
	trace: z.boolean().default(false),

	/**
	 * Whether a lookup that resolves no candidate re-probes the value in the other admin bands,
	 * leaving the result unchanged and requiring `trace`.
	 */
	diagnoseUnreachable: switchOption("diagnoseUnreachable"),
})

/**
 * The session options a config file may state, under the file's `geocode` key.
 *
 * {@linkcode GeocodeSessionOptionsSchema} gives the reason for each key left out.
 */
export const GeocodeFileOptionsSchema = GeocodeSessionOptionsSchema.omit({
	trace: true,
	diagnoseUnreachable: true,
}).extend({
	parentPlace: GeocodeSessionOptionsSchema.shape.parentPlace.unwrap().omit({ source: true }).optional(),
})

/**
 * The session options only a program can supply, because a config file can't hold their values.
 */
export interface GeocodeSessionProgramOptions {
	/**
	 * The data root the session reads its databases and weights overlay from.
	 *
	 * A file can't hold a path builder.
	 * The geocode command takes the root as `--data-root`.
	 */
	dataRoot: PathBuilderLike

	/**
	 * Where the session's `locale` came from.
	 * Each geocode states it beside the locale.
	 *
	 * A file can't state it, because only the program that read the file knows the file supplied the locale.
	 *
	 * @defaultValue `"caller"` when the options stated a locale, else `"default"`
	 */
	localeSource: SessionOptionSource

	/**
	 * The former divisions table the `formerDivisions` option reads.
	 *
	 * A file can't hold a path builder.
	 *
	 * @defaultValue `formerDivisionsTablePath()`, `$MAILWOMAN_DATA_ROOT/gazetteer/former-divisions-v1.json`
	 */
	formerDivisionsTable?: PathBuilderLike

	/**
	 * Per-channel feed pins for the classifier's soft-feature channels, for a diagnostic session.
	 *
	 * A channel pinned `off` is fed zeros in place of its built features.
	 * Unset feeds every channel as built, as every production session does, so a file never sets it.
	 */
	channelPins?: ChannelPins

	/**
	 * Receives initialization progress messages.
	 *
	 * A file can't hold a function.
	 */
	onProgress?: (message: string) => void

	/**
	 * The outcome vocabulary a request's `outcomeHint` and `outcomeFilter` are checked against.
	 *
	 * Without it, a request that sets either field is refused.
	 */
	outcomeVocabulary?: readonly OutcomeVocabularyLike[]
}

/**
 * The options a geocode session is built from, with every default applied.
 */
export type GeocodeSessionOptions = z.output<typeof GeocodeSessionOptionsSchema> & GeocodeSessionProgramOptions

/**
 * The options a caller states.
 *
 * {@linkcode createGeocodeSessionOptions} fills each one left out.
 */
export type GeocodeSessionOptionsInput = z.input<typeof GeocodeSessionOptionsSchema> &
	Partial<GeocodeSessionProgramOptions>

/**
 * The value of each session option that has a default, read from {@linkcode GeocodeSessionOptionsSchema}.
 */
export const GEOCODE_SESSION_DEFAULTS: Readonly<z.output<typeof GeocodeSessionOptionsSchema>> =
	GeocodeSessionOptionsSchema.parse({})

/**
 * Builds a session's options from the ones a caller states, filling each one left out with its default.
 *
 * The data root defaults to `$MAILWOMAN_DATA_ROOT`.
 * The locale's source defaults to the caller when `input` states a locale, and to the default otherwise.
 *
 * @throws {z.ZodError} When a stated option has the wrong type or isn't an option.
 */
export function createGeocodeSessionOptions(input: GeocodeSessionOptionsInput = {}): GeocodeSessionOptions {
	const { dataRoot, localeSource, formerDivisionsTable, channelPins, onProgress, outcomeVocabulary, ...stated } = input

	return {
		...GeocodeSessionOptionsSchema.parse(stated),
		dataRoot: dataRoot ?? dataRootPath(),
		localeSource: localeSource ?? (stated.locale == null ? SessionOptionSource.Default : SessionOptionSource.Caller),
		...(formerDivisionsTable ? { formerDivisionsTable } : {}),
		...(channelPins ? { channelPins } : {}),
		...(onProgress ? { onProgress } : {}),
		...(outcomeVocabulary ? { outcomeVocabulary } : {}),
	}
}
