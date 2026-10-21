/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whether `data pull` may fetch a bundle, decided before any byte moves. A free bundle downloads as it always has.
 *   A licensed bundle needs a configured token that verifies and whose scope admits the bundle's tier. The refusal
 *   prints the three routes to a token, so the operator who meets it knows what to do next.
 */

import { docsSiteURL, type LicenseKeyVerification, scopeAdmits } from "@mailwoman/core/license"

import type { DataBundle } from "#data/bundles"

/**
 * The token this installation has configured, with its offline verification.
 */
export interface ConfiguredKey {
	token: string
	verification: LicenseKeyVerification
}

export type LicensedPullDecision =
	| { kind: "free" }
	| { kind: "granted"; token: string }
	| { kind: "refused"; lines: string[] }

/**
 * The three routes to a token, as the refusal prints them.
 */
function routeLines(): string[] {
	return [
		"  mailwoman license declare --intent open-source --project <url>   # free for an open-source project",
		"  mailwoman license evaluate --email <address>                      # thirty days",
		`  ${docsSiteURL()}/license                                       # commercial`,
	]
}

/**
 * The scope entry a licensed bundle is served under: its tier when it has one, otherwise its name.
 */
export function bundleArtifactName(bundle: DataBundle): string {
	return bundle.tier ?? bundle.name
}

/**
 * Decide whether a bundle may be pulled with the configured key.
 */
export function licensedPullDecision(bundle: DataBundle, configured: ConfiguredKey | null): LicensedPullDecision {
	if (bundle.access !== "licensed") return { kind: "free" }

	const header = `\`${bundle.name}\` is a licensed artifact. Get a token by one of:`

	if (!configured) return { kind: "refused", lines: [header, ...routeLines()] }

	const { verification } = configured

	if (verification.status === "expired") {
		return {
			kind: "refused",
			lines: [
				header,
				...routeLines(),
				`Your key expired on ${verification.payload.expires}: mailwoman license refresh`,
			],
		}
	}

	if (verification.status !== "valid") {
		return { kind: "refused", lines: [header, ...routeLines(), `Your configured key reads ${verification.status}.`] }
	}

	const artifact = bundleArtifactName(bundle)

	if (!scopeAdmits(verification.payload.scope, artifact)) {
		return {
			kind: "refused",
			lines: [header, ...routeLines(), `Your key's scope excludes ${artifact}; its agreement covers other artifacts.`],
		}
	}

	return { kind: "granted", token: configured.token }
}
