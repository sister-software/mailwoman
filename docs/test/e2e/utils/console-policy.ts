/**
 * @file Console message classification policy for e2e tests.
 *
 *   FAIL_PATTERNS — substrings / regexes that indicate a real bug. Add entries when the operator
 *   reports a new symptom so the next regression fails the suite instead of slipping through.
 *
 *   IGNORE_PATTERNS — known-noisy but harmless messages (onnxruntime initializer cleanup, WebGL GPU
 *   stall warnings, etc.). Stripped from capture entirely.
 */

/** Real failures — the test SHOULD fail when one of these surfaces. */
export const FAIL_PATTERNS: RegExp[] = [
	/style is not done loading/i,
	/cannot read properties of null \(reading 'addsource'\)/i,
	/cannot read properties of null \(reading 'addlayer'\)/i,
	/cannot read properties of null \(reading 'setterrain'\)/i,
	/cannot read properties of undefined \(reading 'addsource'\)/i,
	/uncaught.*maplibre/i,
	/uncaught.*sqlite/i,
	/uncaught.*onnxruntime/i,
	// Workspace-alias regression: webpack failing to find one of our packages.
	/cannot find module '@mailwoman\//i,
	// Asset 404 on first-party content.
	/\b(404|net::err_)/i,
]

/** Noise — never causes a failure, never appears in the captured event list. */
export const IGNORE_PATTERNS: RegExp[] = [
	/Removing initializer 'val_/, // onnxruntime cleanup
	/WebGL.*GPU stall/i,
	/^SQL TRACE/,
	/^SPIKE /,
	/No available adapters/,
	/removing requested execution provider/,
	/Mapbox|Maplibre.*[Dd]eprecat/,
	// Docusaurus dev-mode HMR chatter (only fires under `yarn start`).
	/\[HMR\]/,
]

export type Classification = "fail" | "noise"

export function classify(text: string): Classification {
	for (const p of FAIL_PATTERNS) if (p.test(text)) return "fail"
	return "noise"
}

export function isIgnored(text: string): boolean {
	return IGNORE_PATTERNS.some((p) => p.test(text))
}

export function listFailures(texts: string[]): string[] {
	return texts.filter((t) => classify(t) === "fail")
}
