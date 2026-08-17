/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mailwomanDataRoot } from "@mailwoman/core/utils"

export interface GeocodeCommandOptions {
	locale: string
	bias?: string
	defaultCountry?: string
	countryScope: "auto" | "locale" | "none"
	resolveDB?: string
	candidateDB?: string
	dataRoot: string
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
	 * Admin-containment re-rank (#1717 stage 2). Default OFF (D-rule) — `--admin-containment-rerank` opts in.
	 */
	adminContainmentRerank: boolean
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
		dataRoot: mailwomanDataRoot(),
		localeCountryPrior: false,
		gazetteerPrior: true,
		placeCountry: true,
		postcodeCountryCoherence: true,
		forkEntity: true,
		postcodeShapeCoherence: false,
		postcodeContainmentCoherence: false,
		adminContainmentRerank: false,
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
