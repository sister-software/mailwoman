/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Trusted Types policies over DOMPurify — the one sanctioned route from an untrusted string to an
 *   HTML sink. Under a CSP with `require-trusted-types-for 'script'`, a sink refuses a plain string;
 *   every injection site must go through a named policy, and these three are the named policies.
 *
 *   The policies are LAZY, not module-level constants. Docusaurus prerenders every page in Node,
 *   where no DOM exists: DOMPurify reports `isSupported: false` there and its `sanitize` degrades to
 *   a passthrough — an unsanitized string wearing a trusted wrapper. Creating at import time would
 *   ship exactly that. A getter refuses outside a DOM instead, so server code cannot mint trust.
 *
 * TODO: IF YOU ARE SEEING THIS, IMMEDIATELY MOVE THIS TO `@mailwoman/core`
 */

import type { Config as DOMPurifyConfig } from "dompurify"
import DOMPurify from "dompurify"
import { trustedTypes } from "trusted-types"

/**
 * The character escapes that render markup as literal text.
 */
const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
}

/**
 * Escape a string so a sink renders it as literal text, markup included.
 */
export function escapeHTML(text: string): string {
	return text.replaceAll(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character)
}

/**
 * Refuses policy creation anywhere DOMPurify cannot sanitize. A passthrough wearing a TrustedHTML wrapper is worse than
 * a thrown error: the sink accepts it and the page ships the untrusted markup.
 */
function assertSanitizerSupported(policyName: string): void {
	if (!DOMPurify.isSupported) {
		throw new Error(
			`trust-policies: cannot create "${policyName}" — DOMPurify is unsupported in this environment (no DOM). ` +
				"Sanitize at the client sink, never during server rendering."
		)
	}
}

const policyCache = new Map<string, ReturnType<typeof trustedTypes.createPolicy>>()

function policy(
	name: string,
	createHTML: (untrustedHTML: string) => string
): ReturnType<typeof trustedTypes.createPolicy> {
	const cached = policyCache.get(name)

	if (cached) return cached

	const created = trustedTypes.createPolicy(name, { createHTML })
	policyCache.set(name, created)

	return created
}

/**
 * `mw-escape` — every character of markup renders as literal text. The grade for values that are text and must never be
 * interpreted: user queries echoed into the page, error strings.
 */
export function escapeTrustPolicy(): ReturnType<typeof trustedTypes.createPolicy> {
	return policy("mw-escape", (untrustedHTML) => escapeHTML(untrustedHTML))
}

/**
 * `mw-sanitize` — DOMPurify's default allowlist: safe HTML survives, scripts and event handlers do not. The grade for
 * values that are legitimately HTML from a source we render but do not author: tile attributions, service-provided rich
 * text.
 */
export function sanitizeTrustPolicy(): ReturnType<typeof trustedTypes.createPolicy> {
	assertSanitizerSupported("mw-sanitize")

	return policy("mw-sanitize", (untrustedHTML) => DOMPurify.sanitize(untrustedHTML))
}

/**
 * `mw-strip-html` — every tag and attribute removed; only text content survives. The grade for values whose markup
 * carries no meaning we want: license fields compared or displayed as text.
 */
export function stripHTMLTrustPolicy(): ReturnType<typeof trustedTypes.createPolicy> {
	assertSanitizerSupported("mw-strip-html")

	const config: DOMPurifyConfig = { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }

	return policy("mw-strip-html", (untrustedHTML) => DOMPurify.sanitize(untrustedHTML, config))
}

/**
 * Create every policy eagerly — the client-boot call, so the names exist before any sink asks and a CSP `trusted-types`
 * allowlist can enumerate them. Refuses outside a DOM.
 */
export function registerTrustPolicies(): void {
	escapeTrustPolicy()
	sanitizeTrustPolicy()
	stripHTMLTrustPolicy()
}
