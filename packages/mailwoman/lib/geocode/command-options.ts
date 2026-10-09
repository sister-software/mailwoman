/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { VariantAliasExemption } from "@mailwoman/core/geocode"
import type { PathBuilderLike } from "path-ts"

import { GEOCODE_SWITCH_DEFAULTS } from "#geocode/core"
import { GEOCODE_SESSION_DEFAULTS } from "#geocode/session"
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
		locale: "en-US",
		countryScope: "auto",
		dataRoot: dataRootPath(),
		localeCountryPrior: false,
		gazetteerPrior: GEOCODE_SESSION_DEFAULTS.gazetteerPrior,
		venueHeadPrior: GEOCODE_SESSION_DEFAULTS.venueHeadPrior,
		venueHeadBiasScale: 1,
		placeCountry: true,
		postcodeCountryCoherence: GEOCODE_SWITCH_DEFAULTS.postcodeCountryCoherence,
		forkEntity: true,
		postcodeShapeCoherence: GEOCODE_SWITCH_DEFAULTS.postcodeShapeCoherence,
		postcodeContainmentCoherence: GEOCODE_SWITCH_DEFAULTS.postcodeContainmentCoherence,
		adminContainmentRerank: GEOCODE_SWITCH_DEFAULTS.adminContainmentRerank,
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
