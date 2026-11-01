import { describe, expect, it } from "vitest"

import { renderHierarchy } from "#adapters/wof/json-rows"

describe("renderHierarchy", () => {
	it("joins Han names with China's empty separator, largest unit first", () => {
		expect(renderHierarchy({ locality: "石河村", region: "湖南", country: "中国" }, "CN")?.raw).toBe("中国湖南石河村")
	})

	it("writes romanized names in a CJK-script country smallest first, as its Latin-script layout does", () => {
		expect(renderHierarchy({ locality: "Chaozhitun", region: "Hebei" }, "CN")?.raw).toBe("Chaozhitun, Hebei")
		expect(renderHierarchy({ locality: "Tainan", country: "Taiwan" }, "TW")?.raw).toBe("Tainan, Taiwan")

		expect(renderHierarchy({ locality: "Shibuya", region: "Tokyo", country: "Japan" }, "JP")?.raw).toBe(
			"Shibuya, Tokyo, Japan"
		)
	})

	it("separates a hierarchy that mixes a romanized ancestor with a Han name", () => {
		expect(renderHierarchy({ locality: "炉冲口", region: "hunan", country: "china" }, "CN")?.raw).toBe(
			"炉冲口, hunan, china"
		)
	})

	it("separates names in another non-CJK script", () => {
		expect(renderHierarchy({ locality: "Пекин", country: "Китай" }, "CN")?.raw).toBe("Пекин, Китай")
	})

	it("keeps the comma join in a Latin-script country", () => {
		expect(renderHierarchy({ locality: "Paris", region: "Île-de-France" }, "FR")?.raw).toBe("Paris, Île-de-France")
	})

	it("runs Japan's admin units together and gives the country its own line", () => {
		const components = { dependent_locality: "ブルックリン区", locality: "ニューヨーク", region: "ニューヨーク州" }

		expect(renderHierarchy(components, "JP")?.raw).toBe("ニューヨーク州ニューヨークブルックリン区")

		expect(renderHierarchy({ ...components, country: "アメリカ" }, "JP")?.raw).toBe(
			"アメリカ ニューヨーク州ニューヨークブルックリン区"
		)
	})

	it("keeps Korea's spaced admin units", () => {
		expect(renderHierarchy({ dependent_locality: "브루클린", region: "뉴욕 주" }, "KR")?.raw).toBe("뉴욕 주 브루클린")
	})
})
