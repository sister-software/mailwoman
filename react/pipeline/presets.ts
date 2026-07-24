/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Default query + example addresses for the pipeline explorer. Hosts can override via props; these
 *   mirror the docs demo's set so the extracted component looks identical out of the box.
 */

import type { Preset } from "../common/PresetChips.tsx"

export const PIPELINE_DEFAULT_ADDRESS = "1600 Pennsylvania Ave NW, Washington, DC 20500"

// `country` mirrors the docs `EXAMPLE_ADDRESSES` set (kept in parity) — the placetype-pair country pin (#1278 phase 2's
// `{country}` override). A host that wires the pair prior pins the country while the input equals the preset text, so a
// locale structural routing can't detect (NZ) still fires; free-typed input drops to structural detection.
export const PIPELINE_PRESETS: ReadonlyArray<Preset> = [
	{ label: "White House", value: "1600 Pennsylvania Ave NW, Washington, DC 20500", country: "us" },
	{ label: "Apple Park", value: "1 Apple Park Way, Cupertino, CA 95014", country: "us" },
	{ label: "30 Rockefeller Plaza", value: "30 Rockefeller Plaza, New York, NY 10112", country: "us" },
	{ label: "Pier 39 SF", value: "Pier 39, San Francisco, CA 94133", country: "us" },
	{ label: "Wrigley Field", value: "1060 W Addison St, Chicago, IL 60613", country: "us" },
	{ label: "Space Needle", value: "400 Broad St, Seattle, WA 98109", country: "us" },
	{ label: "ZIP only", value: "90210", country: "us" },
	{ label: "Berlin (native order)", value: "Straußstraße 27, 12623 Berlin", country: "de" },
	{ label: "Paris (street fall-through)", value: "181 Rue du Chevaleret, Paris", country: "fr" },
	// GB dependent_locality (placetype-pair-prior arc) — "Henbury" flips to dependent_locality via the en-gb pair-index
	// prior; the UK postcode is also structurally detectable (parity with docs EXAMPLE_ADDRESSES).
	{
		label: "Macclesfield (GB dependent_locality)",
		value: "41 Hightree Drive, Henbury, Macclesfield, SK11 9PD",
		country: "gb",
	},
	// NZ dependent_locality (en-nz pair-prior arc) — Plimmerton is a suburb (dependent_locality) of Porirua. Postcode
	// DELIBERATELY OMITTED: a trailing "Porirua 5026" folds "porirua 5026" in segment mode and misses the index's bare
	// "porirua" key (tracked as #1308). The `country: "nz"` pin is load-bearing — locale-gate can't structurally detect
	// NZ (4-digit postcode isn't distinctive), so only the pin selects the nz index; free-typed NZ stays unfired.
	{ label: "Plimmerton (NZ dependent_locality)", value: "35 Steyne Avenue, Plimmerton, Porirua", country: "nz" },
]
