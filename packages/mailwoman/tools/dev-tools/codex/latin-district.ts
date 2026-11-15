// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The countries whose Latin skeleton prints the district as `%C` while their rows label it `subregion`.
 *
 *   Taiwan's `lfmt` is `%N%n%O%n%A%n%C, %S %Z`, and a romanized address reads
 *   `120 Zhongxiao W. Rd., Zhongzheng Dist., Taipei City 10044`: the 鄉鎮市區 sits where `%C` prints.
 *   Chunghwa Post's list, the GCIS register and the Overture-TW rows file that unit in its own
 *   column, and the corpus labels it `subregion`, the tag its local layout prints after the 縣市.
 *
 *   Each country here prints `subregion` directly before `%C` in its Latin layout,
 *   so a row that labels the district under either tag prints it once in both scripts.
 */

// country-branch: a per-country fact about how libaddressinput's `%C` lines
// up with the tags the corpus assigns.
// A per-country admin-level table naming the placetype `%C` prints would replace it.
/**
 * ISO 3166-1 alpha-2 codes whose Latin layout prints `subregion` before `locality`.
 */
export const LATIN_DISTRICT_BEFORE_LOCALITY_COUNTRIES: ReadonlySet<string> = new Set(["TW"])
