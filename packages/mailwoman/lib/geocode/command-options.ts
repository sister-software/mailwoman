/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mailwomanDataRoot } from "@mailwoman/core/data-root"
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
	 * Admin-containment re-rank (#1717 stage 2). Default ON since 2026-08-18 (promotion evidence in docs/records/evals/)
	 * — `--no-admin-containment-rerank` opts out.
	 */
	adminContainmentRerank: boolean
	/**
	 * Capital-status ranking axis (#1880). Deliberately TRI-STATE with no entry in {@link createGeocodeCommandOptions}:
	 * unstated flows through as absent so the SESSION default (ON, with the missing-reference degrade) applies —
	 * `--capital-tier` demands the reference loudly, `--no-capital-tier` opts out.
	 */
	capitalTier?: boolean
	/**
	 * Own-name variant-alias exemption (#1882). Tri-state for the same reason; `--no-variant-alias-exemption` opts out.
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
		dataRoot: mailwomanDataRoot(),
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
