/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The DeepSeek client's request and retry, against a stub transport. No request leaves the process.
 */

import { createFakeClock } from "@mailwoman/core/api/test-clocks"
import { type StubRequestConfig, stubTransport } from "@mailwoman/core/api/test-transport"
import { parseJSONStrict } from "@mailwoman/core/json"
import { silentLogger } from "@mailwoman/core/logging"
import { describe, expect, it } from "vitest"

import {
	DEEPSEEK_API_URL,
	DEEPSEEK_BASE_RETRY_DELAY_MS,
	DEEPSEEK_MAX_ATTEMPTS,
	DEEPSEEK_REQUEST_TIMEOUT_MS,
	DeepSeekClient,
	type DeepSeekCompletionRequest,
} from "#recipes/deepseek/client"

const BODY: DeepSeekCompletionRequest = {
	model: "deepseek-v4-flash",
	reasoning_effort: "low",
	messages: [{ role: "user", content: "Script: Armenian" }],
	max_tokens: 100,
}

const COMPLETION = {
	choices: [{ message: { content: '{"i": 0}' }, finish_reason: "stop" }],
	usage: { total_tokens: 7 },
}

function client(results: Parameters<typeof stubTransport>[0]) {
	const transport = stubTransport(results)
	const clock = createFakeClock()

	return {
		transport,
		clock,
		client: new DeepSeekClient({ apiKey: "sk-test", axios: transport.axios, clock, logger: silentLogger() }),
	}
}

describe("DeepSeekClient", () => {
	it("posts the body to the completion endpoint with the key and the five-minute timeout", async () => {
		const { transport, client: deepseek } = client([{ body: COMPLETION }])

		await expect(deepseek.complete(BODY)).resolves.toEqual(COMPLETION)

		expect(transport.calls).toEqual([DEEPSEEK_API_URL])

		// The adapter receives Axios's whole request config.
		// The stub's type names only part of it.
		const config = transport.configs[0] as StubRequestConfig & { method?: string; data?: string }

		expect(config.method).toBe("post")
		expect(parseJSONStrict(config.data ?? "")).toEqual(BODY)
		expect(config.headers?.Authorization).toBe("Bearer sk-test")
		expect(config.timeout).toBe(DEEPSEEK_REQUEST_TIMEOUT_MS)
	})

	it("retries a rate limit, a server error and a dropped socket, then answers", async () => {
		const {
			transport,
			clock,
			client: deepseek,
		} = client([
			{ status: 429 },
			{ status: 503 },
			{ throws: { message: "socket hang up", code: "ERR_NETWORK" } },
			{ body: COMPLETION },
		])

		await expect(deepseek.complete(BODY)).resolves.toEqual(COMPLETION)

		expect(transport.calls).toHaveLength(4)
		expect(clock.sleepCalls).toEqual([1, 2, 4].map((factor) => factor * DEEPSEEK_BASE_RETRY_DELAY_MS))
	})

	it("gives up after five attempts with the status, and never retries a refused key", async () => {
		const failing = client([{ status: 502 }])

		await expect(failing.client.complete(BODY)).rejects.toMatchObject({ status: 502 })
		expect(failing.transport.calls).toHaveLength(DEEPSEEK_MAX_ATTEMPTS)

		const refused = client([{ status: 401 }])

		await expect(refused.client.complete(BODY)).rejects.toMatchObject({ status: 401 })
		expect(refused.transport.calls).toHaveLength(1)
	})

	it("refuses a response without a choice rather than reading it as an empty completion", async () => {
		const { client: deepseek } = client([{ body: { error: "overloaded" } }])

		await expect(deepseek.complete(BODY)).rejects.toThrow("without a choices[0].message")
	})
})
