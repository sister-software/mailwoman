/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one sanctioned route from an untrusted string to an HTML sink: DOMPurify behind Trusted
 *   Types policies. Under a CSP with `require-trusted-types-for 'script'`, a sink refuses a plain
 *   string; every injection site must go through a named policy, and these three are the named
 *   policies.
 *
 *   The sanitizer is `isomorphic-dompurify`, so the SAME engine answers in a browser (plain
 *   DOMPurify over the page's window) and in Node (DOMPurify over a jsdom window) — server code,
 *   Docusaurus prerendering, and SDK tooling all sanitize for real instead of degrading to a
 *   passthrough. The plain {@link sanitizeHTML} and {@link stripHTML} functions are that engine
 *   without the Trusted Types wrapper, for callers that need the transform rather than a sink token.
 *
 *   KEEP THIS MODULE A LEAF. The Node build constructs its jsdom window at import time — measured at
 *   0.45 s and ~130 MB over a bare Node process — so an import from a barrel (`core/utils`, the CLI
 *   graph) would tax every process in the repo. It is priced for modules that actually sanitize.
 */

import DOMPurify, { type Config as DOMPurifyConfig } from "isomorphic-dompurify"
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
 * Untrusted HTML through DOMPurify's default allowlist: safe markup survives, scripts and event handlers do not.
 */
export function sanitizeHTML(untrustedHTML: string): string {
	assertSanitizerSupported("sanitizeHTML")

	return DOMPurify.sanitize(untrustedHTML)
}

const STRIP_CONFIG: DOMPurifyConfig = { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }

/**
 * Every tag and attribute removed; only text content survives, entity-ENCODED for an HTML sink. For decoded plain text
 * — comparison, storage — use {@link stripHTMLToText}.
 */
export function stripHTML(untrustedHTML: string): string {
	assertSanitizerSupported("stripHTML")

	return DOMPurify.sanitize(untrustedHTML, STRIP_CONFIG)
}

/**
 * The text CONTENT of untrusted HTML: tags gone, entities decoded, script/style bodies discarded. A real parse, so a
 * `<` inside an attribute value, an unclosed tag, or a comment cannot corrupt the reading the way a regex scan can.
 * Whitespace arrives as the source wrote it — collapse it at the caller if the caller compares.
 */
export function stripHTMLToText(untrustedHTML: string): string {
	assertSanitizerSupported("stripHTMLToText")

	return DOMPurify.sanitize(untrustedHTML, { RETURN_DOM: true }).textContent ?? ""
}

/**
 * Refuses to answer anywhere DOMPurify cannot sanitize. A passthrough wearing a TrustedHTML wrapper is worse than a
 * thrown error: the sink accepts it and the page ships the untrusted markup. With `isomorphic-dompurify` this holds
 * only in an environment with neither a DOM nor jsdom.
 */
function assertSanitizerSupported(callerName: string): void {
	if (!DOMPurify.isSupported) {
		throw new Error(`trust-policies: ${callerName} — DOMPurify is unsupported in this environment.`)
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
 * `mw-sanitize` — {@link sanitizeHTML} as a policy. The grade for values that are legitimately HTML from a source we
 * render but do not author: tile attributions, service-provided rich text.
 */
export function sanitizeTrustPolicy(): ReturnType<typeof trustedTypes.createPolicy> {
	return policy("mw-sanitize", (untrustedHTML) => sanitizeHTML(untrustedHTML))
}

/**
 * `mw-strip-html` — {@link stripHTML} as a policy. The grade for values whose markup carries no meaning we want: license
 * fields compared or displayed as text.
 */
export function stripHTMLTrustPolicy(): ReturnType<typeof trustedTypes.createPolicy> {
	return policy("mw-strip-html", (untrustedHTML) => stripHTML(untrustedHTML))
}

/**
 * Create every policy eagerly — the client-boot call, so the names exist before any sink asks and a CSP `trusted-types`
 * allowlist can enumerate them.
 */
export function registerTrustPolicies(): void {
	escapeTrustPolicy()
	sanitizeTrustPolicy()
	stripHTMLTrustPolicy()
}
