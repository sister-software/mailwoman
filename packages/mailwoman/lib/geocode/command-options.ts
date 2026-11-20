// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { dataRootPath } from "@mailwoman/core/data-root"
import type { VariantAliasExemption } from "@mailwoman/core/geocode"
import type { ParentPlaceScope } from "@mailwoman/core/resolver"
import { DEFAULT_VENUE_HEAD_BIAS_SCALE } from "@mailwoman/neural/venue/head-prior"
import type { PathBuilderLike } from "path-ts"

import { GEOCODE_SWITCH_DEFAULTS } from "#geocode/core"
import { GEOCODE_DEFAULT_LOCALE, GEOCODE_SESSION_DEFAULTS } from "#geocode/session"
import type { CapitalTier } from "#resolver-backend"

export interface GeocodeCommandOptions {
	locale: string
	bias?: string
	defaultCountry?: string
	countryScope: "auto" | "locale" | "none"
	resolveDB?: string
	candidateDB?: string
	dataRoot: PathBuilderLike
	addressPointsDB?: string
	interpolationDB?: string
	interpCalibration?: number
	localeCountryPrior: boolean
	gazetteerPrior: boolean
	/**
	 * Venue-head prior (`--venue-head-prior`).
	 * Off by default.
	 */
	venueHeadPrior: boolean
	/**
	 * Multiplier on the venue-head table's biases (`--venue-head-bias-scale`).
	 */
	venueHeadBiasScale: number
	/**
	 * Street-morphology prior on a trailing affix of a numbered segment (`--street-morphology-prior`).
	 * On by default.
	 */
	streetMorphologyPrior: boolean
	placeCountry: boolean
	postcodeCountryCoherence: boolean
	forkEntity: boolean
	postcodeShapeCoherence: boolean
	postcodeContainmentCoherence: boolean
	/**
	 * Admin-containment re-rank.
	 * On by default.
	 *
	 * `--no-admin-containment-rerank` opts out.
	 */
	adminContainmentRerank: boolean
	/**
	 * A parsed dependent locality resolves inside its parent and answers the coordinate (#2804).
	 * On by default.
	 *
	 * `--no-dependent-locality-containment` opts out.
	 */
	dependentLocalityContainment: boolean
	/**
	 * A `locality` span written with its country's county designator resolves as its region's county.
	 * Off by default.
	 *
	 * `--county-designator-fallback` opts in.
	 */
	countyDesignatorFallback: boolean
	/**
	 * A soft country scope acts inside retrieval, and a hard scope reports the places it excluded.
	 * Off by default.
	 *
	 * `--scope-country-retrieval` opts in.
	 */
	scopeCountryRetrieval: boolean
	/**
	 * One of two `locality` spans resolves inside the other when the gazetteer contains it there.
	 * Off by default.
	 *
	 * `--sibling-locality-containment` opts in.
	 */
	siblingLocalityContainment: boolean
	/**
	 * The placetype-pair prior leaves separator pieces unbiased.
	 * Off by default.
	 *
	 * `--pair-prior-word-pieces` opts in.
	 */
	pairPriorWordPieces: boolean
	/**
	 * A segment child's placetype-pair bias leaves out its same-field postcode.
	 * Off by default.
	 *
	 * `--pair-prior-child-postcode-strip` opts in.
	 */
	pairPriorChildPostcodeStrip: boolean
	/**
	 * The placetype-pair index applies only when the parse's country is the index's.
	 * Off by default.
	 *
	 * `--pair-index-own-country` opts in.
	 */
	pairIndexOwnCountry: boolean
	/**
	 * A parse takes the gazetteer FST of the country the locale head reads, when one ships.
	 * Off by default.
	 *
	 * `--fst-country-routing` opts in.
	 */
	fstCountryRouting: boolean
	/**
	 * A parent place that scopes every lookup (`--parent <wof id>` with `--parent-scope hard|soft`).
	 */
	parentPlace?: ParentPlaceScope
	/**
	 * Capital-status ranking axis (`--capital-tier auto|required|off`).
	 */
	capitalTier: CapitalTier
	/**
	 * Own-name variant-alias exemption (`--variant-alias-exemption applied|not_applied`).
	 */
	variantAliasExemption: VariantAliasExemption
	placeCountryThreshold: number
	format: "json" | "text" | "jsonld"
	json: boolean
	text: boolean
	jsonld: boolean
	debug: boolean
	debugSize: string
	stdin: boolean
	timing: boolean
	tiles?: string
}

export function createGeocodeCommandOptions(overrides: Partial<GeocodeCommandOptions> = {}): GeocodeCommandOptions {
	return {
		locale: GEOCODE_DEFAULT_LOCALE,
		countryScope: "auto",
		dataRoot: dataRootPath(),
		localeCountryPrior: false,
		gazetteerPrior: GEOCODE_SESSION_DEFAULTS.gazetteerPrior,
		venueHeadPrior: GEOCODE_SESSION_DEFAULTS.venueHeadPrior,
		venueHeadBiasScale: DEFAULT_VENUE_HEAD_BIAS_SCALE,
		streetMorphologyPrior: GEOCODE_SESSION_DEFAULTS.streetMorphologyPrior,
		placeCountry: true,
		postcodeCountryCoherence: GEOCODE_SWITCH_DEFAULTS.postcodeCountryCoherence,
		forkEntity: true,
		postcodeShapeCoherence: GEOCODE_SWITCH_DEFAULTS.postcodeShapeCoherence,
		postcodeContainmentCoherence: GEOCODE_SWITCH_DEFAULTS.postcodeContainmentCoherence,
		adminContainmentRerank: GEOCODE_SWITCH_DEFAULTS.adminContainmentRerank,
		dependentLocalityContainment: GEOCODE_SWITCH_DEFAULTS.dependentLocalityContainment,
		countyDesignatorFallback: GEOCODE_SWITCH_DEFAULTS.countyDesignatorFallback,
		scopeCountryRetrieval: GEOCODE_SWITCH_DEFAULTS.scopeCountryRetrieval,
		siblingLocalityContainment: GEOCODE_SWITCH_DEFAULTS.siblingLocalityContainment,
		pairPriorWordPieces: GEOCODE_SWITCH_DEFAULTS.pairPriorWordPieces,
		pairPriorChildPostcodeStrip: GEOCODE_SWITCH_DEFAULTS.pairPriorChildPostcodeStrip,
		pairIndexOwnCountry: GEOCODE_SWITCH_DEFAULTS.pairIndexOwnCountry,
		fstCountryRouting: GEOCODE_SWITCH_DEFAULTS.fstCountryRouting,
		capitalTier: GEOCODE_SESSION_DEFAULTS.capitalTier,
		variantAliasExemption: GEOCODE_SESSION_DEFAULTS.variantAliasExemption,
		placeCountryThreshold: 0.9,
		format: "json",
		json: false,
		text: false,
		jsonld: false,
		debug: false,
		debugSize: "120x36",
		stdin: false,
		timing: false,
		...overrides,
	}
}
