/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The DeepSeek chat-completion request: one paid call per generation batch, through {@linkcode APIClient}.
 *
 *   The Python `client.py` retried a 429, 500, 502, 503 or 504 response and any network failure five times, waiting
 *   2 s and then 1.5 times longer each attempt. This client makes the same five attempts through `APIClient`'s
 *   retry policy. That policy also retries 408 and the other 5xx statuses, honors a `Retry-After` header, and doubles
 *   a 2 s base wait. A final failure is a `ResourceError` carrying the HTTP status.
 */

import { APIClient, type APIClientConfig, type ClockLike, pluckResponseData } from "@mailwoman/core/api"
import type { IRuntimeLogger } from "@mailwoman/core/logging"

import { $private } from "#env"

/**
 * The chat-completion endpoint every generation request is sent to.
 */
export const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions"

/**
 * The model a run requests unless `--model` names another.
 */
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"

/**
 * Attempts per request, the first included.
 */
export const DEEPSEEK_MAX_ATTEMPTS = 5

/**
 * The wait before the second attempt, in milliseconds.
 */
export const DEEPSEEK_BASE_RETRY_DELAY_MS = 2000

/**
 * How long one attempt may take, in milliseconds.
 * A batch of 50 rows at low reasoning effort takes minutes.
 */
export const DEEPSEEK_REQUEST_TIMEOUT_MS = 300_000

/**
 * One chat message of a request.
 */
export interface DeepSeekMessage {
	role: "system" | "user"
	content: string
}

/**
 * The request body both generation modes send.
 */
export interface DeepSeekCompletionRequest {
	model: string
	reasoning_effort: "low"
	messages: DeepSeekMessage[]
	max_tokens: number
}

/**
 * The fields of a completion the generators read.
 */
export interface DeepSeekCompletionResponse {
	choices: Array<{ message: { content?: string | null }; finish_reason?: string | null }>
	usage?: unknown
}

/**
 * What answers a completion request: {@linkcode DeepSeekClient}, or a test's fake.
 */
export interface DeepSeekCompleter {
	complete(body: DeepSeekCompletionRequest): Promise<DeepSeekCompletionResponse>
}

/**
 * The DeepSeek key from the private environment.
 *
 * @throws When `DEEPSEEK_API_KEY` is unset or blank, naming the variable.
 */
export function requireDeepSeekAPIKey(): string {
	const apiKey = $private.DEEPSEEK_API_KEY?.trim()

	if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set; generation needs it")

	return apiKey
}

/**
 * Options for {@linkcode DeepSeekClient}.
 *
 * `axios` and `clock` exist for tests.
 * A test passes a stub adapter and a fake clock, so no request leaves the process.
 */
export interface DeepSeekClientOptions {
	apiKey: string
	axios?: APIClientConfig["axios"]
	clock?: ClockLike
	logger?: IRuntimeLogger
}

/**
 * The chat-completion client.
 */
export class DeepSeekClient extends APIClient implements DeepSeekCompleter {
	constructor(options: DeepSeekClientOptions) {
		super({
			displayName: "deepseek",
			retry: { maxAttempts: DEEPSEEK_MAX_ATTEMPTS, baseDelayMs: DEEPSEEK_BASE_RETRY_DELAY_MS },
			...(options.clock ? { clock: options.clock } : {}),
			...(options.logger ? { logger: options.logger } : {}),
			axios: {
				...options.axios,
				timeout: DEEPSEEK_REQUEST_TIMEOUT_MS,
				headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
			},
		})
	}

	/**
	 * POSTs one completion request and returns the parsed response.
	 *
	 * @throws When the response holds no `choices` entry, because neither generator can read a batch from it.
	 */
	public async complete(body: DeepSeekCompletionRequest): Promise<DeepSeekCompletionResponse> {
		const response = await this.fetch<DeepSeekCompletionResponse>({
			url: DEEPSEEK_API_URL,
			method: "post",
			data: body,
		}).then(pluckResponseData)

		if (!Array.isArray(response?.choices) || !response.choices[0]?.message) {
			throw new Error(`DeepSeek answered ${DEEPSEEK_API_URL} without a choices[0].message`)
		}

		return response
	}
}
