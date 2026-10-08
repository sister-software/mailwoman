/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   How an eval pins an on/off switch: `"production"` grades whatever production does,
 *   and `"on"` or `"off"` pins the switch either way.
 */

import { z } from "zod"

/**
 * The values of a switch pin, in the order a command-line `choices` list shows them.
 */
export const SWITCH_PIN_CHOICES = ["production", "on", "off"] as const

/**
 * Schema for {@link SwitchPin}, built from {@link SWITCH_PIN_CHOICES}.
 */
export const SwitchPinSchema = z.enum(SWITCH_PIN_CHOICES)

export type SwitchPin = z.infer<typeof SwitchPinSchema>

/**
 * The pin an optional boolean from an external interface, such as a tool schema, describes.
 */
export function switchPinOf(value: boolean | undefined): SwitchPin {
	if (value === undefined) return "production"

	return value ? "on" : "off"
}

/**
 * The switch's value under a pin, taking `production` when the pin is `"production"`.
 */
export function pinnedSwitch(pin: SwitchPin, production: boolean): boolean {
	if (pin === "production") return production

	return pin === "on"
}

/**
 * The object entry a pin contributes: the pinned boolean, or no entry for `"production"`,
 * so the consumer's own defaults table decides.
 */
export function switchPinEntry<Key extends string>(key: Key, pin: SwitchPin): Partial<Record<Key, boolean>> {
	if (pin === "production") return {}

	return { [key]: pin === "on" } as Partial<Record<Key, boolean>>
}
