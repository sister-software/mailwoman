/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `parseForGeocode` over a classifier that routes by script: the routed classifier is asked for, the postal mark
 *   follows ITS encoder rather than the primary's, and a classifier without `forInput` is unchanged.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { type GeocodeClassifier, parseForGeocode } from "mailwoman/geocode"
import { describe, expect, it, vi } from "vitest"

const KAMIICHI = "〒930-0393 富山県中新川郡上市町法音寺1"
const NINE_ELMS = "1 Riverlight Quay, Nine Elms Lane, London SW11 8AY"

function stub(encoder: "sentencepiece" | "char"): GeocodeClassifier & { parse: ReturnType<typeof vi.fn> } {
	return {
		encoder,
		parse: vi.fn(async (text: string): Promise<AddressTree> => ({ raw: text, roots: [] })),
	}
}

describe("parseForGeocode over a script-routed classifier", () => {
	it("parses a kanji line on the routed classifier with the postal mark kept", async () => {
		const primary = stub("sentencepiece")
		const family = stub("char")

		const routed: GeocodeClassifier = {
			encoder: primary.encoder,
			forInput: async (text) => (/\p{Script=Han}/u.test(text) ? family : primary),
			parse: primary.parse,
		}

		await parseForGeocode(KAMIICHI, { classifier: routed })

		expect(family.parse).toHaveBeenCalledTimes(1)
		expect(primary.parse).not.toHaveBeenCalled()
		expect(String(family.parse.mock.calls[0]?.[0])).toContain("〒")
	})

	it("parses a Latin line on the primary with the postal mark path untouched", async () => {
		const primary = stub("sentencepiece")
		const family = stub("char")

		const routed: GeocodeClassifier = {
			encoder: primary.encoder,
			forInput: async (text) => (/\p{Script=Han}/u.test(text) ? family : primary),
			parse: primary.parse,
		}

		await parseForGeocode(NINE_ELMS, { classifier: routed })

		expect(primary.parse).toHaveBeenCalledTimes(1)
		expect(family.parse).not.toHaveBeenCalled()
	})

	it("strips the postal mark for a classifier that does not route, as before", async () => {
		const only = stub("sentencepiece")

		await parseForGeocode(KAMIICHI, { classifier: only })

		expect(only.parse).toHaveBeenCalledTimes(1)
		expect(String(only.parse.mock.calls[0]?.[0])).not.toContain("〒")
	})
})
