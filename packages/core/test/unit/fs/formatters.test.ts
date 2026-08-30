/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Both bases, at every tier.
 *
 *   The locale is pinned explicitly: `Intl.NumberFormat` follows the host otherwise, and a runner's default is not a
 *   property of the formatter.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { describe, expect, it } from "vitest"

const si = (bytes: number) => ByteFormatter.formatSI(bytes, { locales: "en-US" })
const iec = (bytes: number) => ByteFormatter.formatIEC(bytes, { locales: "en-US" })

describe("formatSI", () => {
	it("scales by powers of ten, as a vendor quotes a size", () => {
		expect(si(0)).toBe("0 byte")
		expect(si(512)).toBe("512 byte")
		expect(si(64_000)).toBe("64 kB")
		expect(si(35_800_000)).toBe("35.8 MB")
		expect(si(1_400_000_000)).toBe("1.4 GB")
		expect(si(41_261_826_048)).toBe("41.3 GB")
	})
})

describe("formatIEC", () => {
	it("scales by powers of 1024", () => {
		expect(iec(0)).toBe("0 B")
		expect(iec(512)).toBe("512 B")
		expect(iec(1024)).toBe("1 KiB")
		expect(iec(35_800_000)).toBe("34.1 MiB")
	})

	// The unit is the only thing that tells a reader which base ran, so a binary quantity never wears a decimal label.
	it("labels a binary quantity binarily", () => {
		expect(iec(41_261_826_048)).not.toContain(" GB")
		expect(iec(41_261_826_048)).toBe("38.4 GiB")
	})

	it("carries every tier through TiB rather than accumulating into the largest it knows", () => {
		expect(iec(1_099_511_627_776)).toBe("1 TiB")
	})

	it("spells the sign on a delta, and never doubles the one Intl already places", () => {
		const delta = (bytes: number) => ByteFormatter.formatIEC(bytes, { locales: "en-US", signed: true })

		expect(delta(2_621_440)).toBe("+2.5 MiB")
		expect(delta(-2_621_440)).toBe("-2.5 MiB")
		expect(delta(0)).toBe("0 B")
		expect(iec(-2_621_440)).toBe("-2.5 MiB")
	})
})
