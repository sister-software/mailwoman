/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilderLike } from "path-ts"

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
	 * Admin-containment re-rank. On by default.
	 *
	 * `--no-admin-containment-rerank` opts out.
	 */
	adminContainmentRerank: boolean
	/**
	 * Capital-status ranking axis. Deliberately tri-state with no entry in
	 * {@link createGeocodeCommandOptions}: unstated flows through as absent so the session default
	 * applies. `--capital-tier` demands the reference loudly, and `--no-capital-tier` opts out.
	 */
	capitalTier?: boolean
	/**
	 * Own-name variant-alias exemption. Tri-state for the same reason.
	 * `--no-variant-alias-exemption` opts out.
	 */
	variantAliasExemption?: boolean
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
		gazetteerPrior: true,
		placeCountry: true,
		postcodeCountryCoherence: true,
		forkEntity: true,
		postcodeShapeCoherence: false,
		postcodeContainmentCoherence: false,
		adminContainmentRerank: true,
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
