/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Runtime pipeline host preferences.
 */

/**
 * Independent host/browser preferences. A timezone is evidence, never a locale conversion.
 */
export interface MachinePreferences {
	locale?: Intl.UnicodeBCP47LocaleIdentifier
	timeZone?: string
}
