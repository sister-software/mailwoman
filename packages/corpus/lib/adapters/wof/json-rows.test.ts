import { describe, expect, it } from "vitest"

import { renderHierarchy } from "#adapters/wof/json-rows"

describe("renderHierarchy", () => {
	it("joins Han names with China's empty separator, largest unit first", () => {
		expect(renderHierarchy({ locality: "石河村", region: "湖南", country: "中国" }, "CN")?.raw).toBe("中国湖南石河村")
	})

	it("separates romanized names in a CJK-script country", () => {
		expect(renderHierarchy({ locality: "Chaozhitun", region: "Hebei" }, "CN")?.raw).toBe("Hebei, Chaozhitun")
		expect(renderHierarchy({ locality: "Tainan", country: "Taiwan" }, "TW")?.raw).toBe("Taiwan, Tainan")
	})

	it("separates a hierarchy that mixes a romanized ancestor with a Han name", () => {
		expect(renderHierarchy({ locality: "炉冲口", region: "hunan", country: "china" }, "CN")?.raw).toBe(
			"china, hunan, 炉冲口"
		)
	})

	it("separates names in another non-CJK script", () => {
		expect(renderHierarchy({ locality: "Пекин", country: "Китай" }, "CN")?.raw).toBe("Китай, Пекин")
	})

	it("keeps the comma join in a Latin-script country", () => {
		expect(renderHierarchy({ locality: "Paris", region: "Île-de-France" }, "FR")?.raw).toBe("Paris, Île-de-France")
	})
})
