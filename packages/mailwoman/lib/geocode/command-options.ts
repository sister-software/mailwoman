/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilderLike } from "path-ts"

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
	 * Own-name variant-alias exemption.
	 * `--no-variant-alias-exemption` opts out.
	 */
	variantAliasExemption: boolean
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
		placeCountry: true,
		postcodeCountryCoherence: true,
		forkEntity: true,
		postcodeShapeCoherence: false,
		postcodeContainmentCoherence: false,
		adminContainmentRerank: true,
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
