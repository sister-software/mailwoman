// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * What a logged-in Wikimedia Action API session needs: the bot-password credentials,
 * the session cookies the login answers set, and the request limits of each mode.
 *
 * A bot password is created at `Special:BotPasswords` and logs in as `Name@app`
 * with the generated password, through `action=login`.
 * See https://www.mediawiki.org/wiki/API:Login.
 */

/**
 * A bot-password login: `username` is `Name@app`.
 */
export interface WikidataBotCredentials {
	username: string
	password: string
}

/**
 * Whether requests go out logged in or anonymously.
 */
export const WikimediaRequestMode = {
	anonymous: "anonymous",
	loggedIn: "logged-in",
} as const

export type WikimediaRequestMode = (typeof WikimediaRequestMode)[keyof typeof WikimediaRequestMode]

/**
 * The concurrency and dispatch spacing of each mode.
 */
export interface ActionAPILimits {
	/**
	 * The most requests in flight at once.
	 */
	concurrency: number
	/**
	 * The least spacing between two dispatches of one client.
	 */
	minRequestIntervalMs: number
}

/**
 * The Action API limits each mode keeps.
 *
 * Anonymous: one request in flight, as the robot policy asks, two per second at most (120 per minute,
 * under the policy's 5 per second and the rate-limit page's 200 per minute for a compliant User-Agent).
 * Logged in: three in flight, as both pages allow, about three per second at most (182 per minute,
 * under 10 per second and under the 200 per minute the rate-limit page gives an account with few edits).
 */
export const ACTION_API_LIMITS: Readonly<Record<WikimediaRequestMode, ActionAPILimits>> = {
	anonymous: { concurrency: 1, minRequestIntervalMs: 500 },
	"logged-in": { concurrency: 3, minRequestIntervalMs: 330 },
}

/**
 * The bot credentials from two environment values, or `null` when neither is set.
 *
 * @throws When only one is set, or the username lacks the bot password's `@app` part.
 */
export function botCredentialsFrom(
	username: string | null | undefined,
	password: string | null | undefined
): WikidataBotCredentials | null {
	if (!username && !password) return null

	if (!username || !password) {
		throw new Error("WIKIDATA_BOT_USERNAME and WIKIDATA_BOT_PASSWORD are set together or not at all")
	}

	if (!/^[^@]+@[^@]+$/u.test(username)) {
		throw new Error("WIKIDATA_BOT_USERNAME is a bot-password login of the form Name@app")
	}

	return { username, password }
}

/**
 * The text with each credential value replaced by a marker, for an error a login raised.
 */
export function redactCredentials(text: string, credentials: WikidataBotCredentials): string {
	let redacted = text

	for (const secret of [credentials.password, credentials.username]) {
		redacted = redacted.replaceAll(secret, "[redacted]")
		redacted = redacted.replaceAll(encodeURIComponent(secret), "[redacted]")
	}

	return redacted
}

/**
 * The cookies one host set, sent back on every later request to it.
 *
 * Every request of a Wikidata API client goes to one host, so a cookie's domain and path are not consulted.
 * A cookie set to expire, by `Max-Age=0` or a past `Expires`, is dropped.
 */
export class SessionCookies {
	readonly #values = new Map<string, string>()

	/**
	 * The number of cookies held.
	 */
	public get size(): number {
		return this.#values.size
	}

	/**
	 * Keep the cookies a response's `Set-Cookie` header sets.
	 */
	public absorb(header: unknown, now = Date.now()): void {
		const lines = Array.isArray(header) ? header : typeof header === "string" ? [header] : []

		for (const line of lines) {
			if (typeof line !== "string") continue

			const [pair = "", ...attributes] = line.split(";")
			const separator = pair.indexOf("=")

			if (separator <= 0) continue

			const name = pair.slice(0, separator).trim()
			const value = pair.slice(separator + 1).trim()

			if (isExpired(attributes, now)) {
				this.#values.delete(name)
			} else {
				this.#values.set(name, value)
			}
		}
	}

	/**
	 * The `Cookie` header value, or `null` when no cookie is held.
	 */
	public header(): string | null {
		if (!this.#values.size) return null

		return [...this.#values].map(([name, value]) => `${name}=${value}`).join("; ")
	}
}

function isExpired(attributes: readonly string[], now: number): boolean {
	for (const attribute of attributes) {
		const [key = "", ...rest] = attribute.split("=")
		const value = rest.join("=").trim()

		switch (key.trim().toLowerCase()) {
			case "max-age":
				if (Number(value) <= 0) return true
				break
			case "expires": {
				const expires = Date.parse(value)

				if (Number.isFinite(expires) && expires <= now) return true

				break
			}
		}
	}

	return false
}
