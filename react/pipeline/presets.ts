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

export const PIPELINE_PRESETS: ReadonlyArray<Preset> = [
	{ label: "White House", value: "1600 Pennsylvania Ave NW, Washington, DC 20500" },
	{ label: "Apple Park", value: "1 Apple Park Way, Cupertino, CA 95014" },
	{ label: "30 Rockefeller Plaza", value: "30 Rockefeller Plaza, New York, NY 10112" },
	{ label: "Pier 39 SF", value: "Pier 39, San Francisco, CA 94133" },
	{ label: "Wrigley Field", value: "1060 W Addison St, Chicago, IL 60613" },
	{ label: "Space Needle", value: "400 Broad St, Seattle, WA 98109" },
	{ label: "ZIP only", value: "90210" },
	{ label: "Berlin (native order)", value: "Straußstraße 27, 12623 Berlin" },
	{ label: "Paris (street fall-through)", value: "181 Rue du Chevaleret, Paris" },
	// NZ dependent_locality (en-nz pair-prior arc) — Plimmerton is a suburb (dependent_locality) of the city of
	// Porirua. Lights up once a released weights bundle wires the en-nz pair-index prior; harmless before that.
	{ label: "Plimmerton (NZ dependent_locality)", value: "35 Steyne Avenue, Plimmerton, Porirua 5026" },
]
