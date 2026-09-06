/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license message as text, the same for every provider: the licensee, the dates, the key, the commands to run,
 *   and on the first message the refresh secret. It never names an amount or a Stripe id.
 */

import type { LicenseEmail } from "#email/provider"

export function licenseEmailSubject(message: LicenseEmail): string {
	return `Your Mailwoman commercial license (${message.issued} to ${message.expires})`
}

export function renderLicenseEmail(message: LicenseEmail, siteOrigin: string): string {
	const refresh = message.refreshSecret
		? [
				"Your refresh secret (shown once; keep it with the key):",
				message.refreshSecret,
				"",
				"Fetch the current key any time:",
				`  mailwoman license refresh --lid ${message.lid} --secret <secret>`,
			]
		: [
				"Fetch the current key any time with the refresh secret from your first email:",
				`  mailwoman license refresh --lid ${message.lid} --secret <secret>`,
			]

	return [
		`Licensee: ${message.licensee}`,
		`License id: ${message.lid}`,
		`Valid: ${message.issued} to ${message.expires} (UTC, inclusive)`,
		"",
		"Your license key:",
		message.token,
		"",
		"Configure it:",
		`  export MAILWOMAN_LICENSE_KEY="${message.token}"`,
		"  mailwoman license verify --online",
		"",
		...refresh,
		"",
		`Manage billing: ${siteOrigin}/license`,
	].join("\n")
}
