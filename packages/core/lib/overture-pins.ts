/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The pinned Overture release for the ADDRESSES theme.
 *
 *   Overture publishes one release tag across its themes and prunes old releases from the bucket on roughly a monthly
 *   window, so every reader carries a pin. The pins are per THEME, not per tool: the divisions theme (the admin
 *   gazetteer) and the places theme (poi.db) are pinned together in `mailwoman`'s gazetteer pipeline (`defaults.ts`,
 *   `poi/defaults.ts`), and bumping them is a new-vintage decision for those artifacts. This is the third pin, for the
 *   addresses theme every address-point, postcode-centroid, district and coarse-placer build reads, and it lives in
 *   core because readers exist on both sides of the `mailwoman` boundary.
 *
 *   Five tools carried their own literal before this constant existed, at two different releases, and one of them
 *   would have defaulted to a directory that holds no addresses parquet at all: on the lab data root the addresses
 *   theme is fetched at `2026-06-17.0` (53 country parquets), the older `2026-05-20.0` holds 23, and the divisions
 *   pin's directory holds none. A tool that needs another vintage takes it through its own `--release` option; the
 *   default is this one, so the vintage a build read is the vintage the corpus and the CJK board were built from.
 */

/**
 * The addresses-theme release directory under `<data-root>/overture/`.
 */
export const OVERTURE_ADDRESSES_RELEASE = "2026-06-17.0"
