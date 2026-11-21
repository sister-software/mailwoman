// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A held-out arm: a weights cache root, the resolver switches its geocode outcomes pin,
 *   and the decoder settings its parses pin.
 *
 *   An arm is written `<weights cache root>` or `<weights cache root>#<switch>=<on|off>[,<switch>=<on|off>]`.
 *   A resolver pin leaves the arm's parse outcomes as the root's, so two arms that share
 *   a root and differ only in a resolver pin isolate a resolver change.
 *
 *   A decoder pin changes the parses.
 *   The parses are made once per root and decoder pin set.
 *
 *   The label is the arm's identity in a report, and a verdict identifies the arm by the same label.
 */

import type { DecoderSettings } from "#geocode/core"
import type { SwitchPin } from "#tools/eval-harness/switch-pin"

/**
 * The decoder settings an arm may pin.
 *
 * `fstCountryRouting` is absent because the held-out parse feeds no gazetteer FST.
 */
export const HELDOUT_ARM_DECODER_SWITCHES = [
	"pairPriorWordPieces",
	"pairPriorChildPostcodeStrip",
	"pairIndexOwnCountry",
] as const satisfies readonly (keyof DecoderSettings)[]

/**
 * The switches an arm may pin: the boolean resolver pins of `GauntletResolverPins`,
 * then the decoder settings.
 */
export const HELDOUT_ARM_SWITCHES = [
	"countyDesignatorFallback",
	"scopeCountryRetrieval",
	"siblingLocalityContainment",
	"adminContainmentRerank",
	"dependentLocalityContainment",
	"postcodeCountryCoherence",
	"poiVenueTier",
	...HELDOUT_ARM_DECODER_SWITCHES,
] as const

/**
 * The decoder settings an arm pins, as the parse reads them.
 */
export function heldoutArmDecoderSettings(arm: Pick<HeldoutArm, "pins">): DecoderSettings {
	return Object.fromEntries(
		HELDOUT_ARM_DECODER_SWITCHES.flatMap((name) => {
			const pin = arm.pins[name]

			return pin ? [[name, pin === "on"]] : []
		})
	)
}

export type HeldoutArmSwitch = (typeof HELDOUT_ARM_SWITCHES)[number]

export interface HeldoutArm {
	/**
	 * The arm as written, its identity in a report.
	 */
	label: string
	/**
	 * The root holding `node_modules/@mailwoman/neural-weights-*`.
	 */
	cacheRoot: string
	/**
	 * The switches the arm pins.
	 * An absent switch takes production's value.
	 */
	pins: Partial<Record<HeldoutArmSwitch, Exclude<SwitchPin, "production">>>
}

/**
 * Reads an arm label.
 *
 * @throws When a pin sets an unknown switch, a value other than `on` or `off`, or one switch twice.
 */
export function parseHeldoutArm(label: string): HeldoutArm {
	const hash = label.indexOf("#")
	const cacheRoot = hash === -1 ? label : label.slice(0, hash)

	if (!cacheRoot) throw new Error(`arm ${label} names no weights cache root`)

	const pins: HeldoutArm["pins"] = {}

	if (hash !== -1) {
		for (const entry of label.slice(hash + 1).split(",")) {
			const [name, value, ...rest] = entry.split("=")

			if (!HELDOUT_ARM_SWITCHES.includes(name as HeldoutArmSwitch)) {
				throw new Error(
					`arm ${label} pins ${name ?? ""}; the switches an arm may pin are ${HELDOUT_ARM_SWITCHES.join(", ")}`
				)
			}

			if (rest.length || (value !== "on" && value !== "off")) {
				throw new Error(`arm ${label} pins ${name} to ${entry.slice((name ?? "").length + 1)}; a pin is on or off`)
			}

			if (name! in pins) throw new Error(`arm ${label} pins ${name} twice`)

			pins[name as HeldoutArmSwitch] = value
		}
	}

	return { label, cacheRoot, pins }
}
