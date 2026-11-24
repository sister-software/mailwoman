// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The primary document behind each separate Latin-script layout a review compared, by ISO 3166-1 alpha-2.
 *
 * A country that writes its own script in one order and Latin script in another has two layouts.
 * `LAYOUT_CITATIONS` cites the one `layoutForCountry` answers with no script chosen,
 * and this table the Latin one.
 *
 * Each example is transcribed from the document's text layer, one string per printed line.
 */

import { ConventionSource, type LayoutCitation } from "#address/convention-claims"
import { KOREAN_TEMPLATE_SHA256, KOREAN_TEMPLATE_URL } from "#address/layouts/citations/g-m"
import { RETRIEVED_AT, upuDescription } from "#address/layouts/citations/upu-description"

/**
 * Latin-layout citations by ISO 3166-1 alpha-2.
 */
export const LATIN_LAYOUT_CITATIONS: Readonly<Record<string, LayoutCitation>> = {
	JP: upuDescription(
		"jpn",
		"2019-6",
		"715dde888e7c08cc83c3d6f313559f5420389c7a2e6dde7e4b18a8a25d325865",
		[
			["4-3-2, Hakusan", "Bunkyo-ku, TOKYO", "112-0001", "JAPAN"],
			["Mr Taro Tanaka", "10–23, Mitsugi 1–chome", "Musashi-Murayama-shi, TOKYO", "231–0012 JAPAN"],
			["Mr Taro Tanaka", "2338 Magatake", "Zaou-machi", "Katta-gun, MIYAGI", "989–0851 JAPAN"],
		],
		[
			"the postcode and the country on one line in the addressed examples (`231–0012 JAPAN`); this layout prints them on two, as the description's first form does",
			"the rural form's town on a line of its own above the county and prefecture (`Zaou-machi` then `Katta-gun, MIYAGI`); this layout writes them on one line",
			"the rural form's number without a comma (`2338 Magatake`)",
			"the prefecture left out for the 20 principal cities and where the prefecture and the city share a name (`Naka-ku, YOKOHAMA`)",
			"Japan Post's own English rows (`https://www.post.japanpost.jp/service/send/oversea/use/label/howto_en.html`, sha256 60f2cc215dfa754445b8dad23be4ad2d17a14458b803d55082667ba6509ea015) put the building and room on a line above the house number, which this layout prints as the venue line",
		]
	),
	KR: {
		source: ConventionSource.PostalStandardS42,
		url: KOREAN_TEMPLATE_URL,
		documentDate: "2019-12",
		retrievedAt: RETRIEVED_AT,
		sha256: KOREAN_TEMPLATE_SHA256,
		examples: [
			["Mr. Hong, Gil Dong", "325, Seocho-daero, Seocho-gu", "Seoul 06600"],
			["Mr. Hong, Gil Dong", "101-103", "2275-12, Dalgubeol-daero, Suseong-gu", "Daegu 42000"],
			["Mr. Hong, Gil Dong", "AMOREPACIFIC, 2F", "24, Songnim-ro, Dong-gu", "Incheon 22550"],
			["Mr. Hong, Gil Dong", "PO Box 00", "51, Oncheon-ro, Yuseong-gu", "Daejeon 34168"],
		],
		unexpressed: [
			"the surname before the given name with a comma (`Hong, Gil Dong`), which belongs to the addressee's value",
			"the building wing and door joined with a hyphen (`101-103`); the UPU description (`korEn.pdf`, 03/2016) prefers `101-dong 103-ho`",
			"the template's examples print no country line; the UPU description ends each with `REP. OF KOREA`",
		],
	},
}
