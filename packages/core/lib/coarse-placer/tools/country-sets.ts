/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The country sets the coarse-placer dataset is drawn from. `build-dataset.ts` samples them; the
 *   outlier builders consult them to keep in-map countries out of the OTHER pool.
 */

/**
 * The in-map countries the coarse-placer routes to, drawn from the v0.5.0 corpus `train` extracts.
 */
export const COUNTRIES = ["US", "FR", "GB", "CN", "NL", "IT", "DE", "JP", "ES", "KR", "TW"] as const

/**
 * #743: the EU expansion. The v0.5.0 corpus carries zero rows for these locales, so they're drawn from the Overture
 * per-country addresses theme (the same source build-eu-eval-set.ts uses). They were previously OTHER outlier exposure
 * (PL/PT/CZ) or simply unrepresentable; here they become first-class in-map countries so the soft country prior can pin
 * them.
 */
export const NEW_EU = [
	"AT",
	"BE",
	"CH",
	"CZ",
	"DK",
	"EE",
	"FI",
	"HR",
	"LT",
	"LU",
	"LV",
	"NO",
	"PL",
	"PT",
	"SI",
	"SK",
] as const

/**
 * #743 in-map dilution fix: DE/ES/IT/NL are already in COUNTRIES (corpus format), but the eu-eval sets + every NEW_EU
 * country are Overture format. Without an Overture sample of their OWN, their Overture-format eval rows scatter to the
 * Overture-trained neighbours (measured: only 63% of ES eval rows routed ES, ~26% leaked to CH/PT/HR/IT/FR/CZ).
 * SUPPLEMENT their corpus rows with an Overture sample so each owns its own format shape; the format then stops being
 * discriminative and the model falls back to the linguistic n-grams. GB excluded — its Overture parquet is empty.
 */
export const IN_MAP_EU = ["DE", "ES", "IT", "NL"] as const
