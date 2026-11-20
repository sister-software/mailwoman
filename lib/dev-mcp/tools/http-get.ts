// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwdev_http_get` fetches one URL with the GET method and returns the status, the content type,
 * the requested headers, and the body up to a byte cap or a projection of a JSON body.
 *
 * The request is sent without a body, a cookie or an authorization header.
 * Its `User-Agent` is a generic client name.
 * Only `http` and `https` are fetched.
 *
 * The host name is resolved before each request, including each redirect, and a host that
 * resolves to a private, link-local, unique-local, multicast or unspecified address is refused.
 * Loopback is admitted.
 *
 * The connection then goes to the addresses that check read, so a second
 * resolution can't move it to another address.
 *
 * The request goes through `APIClient` with no cache and no retry.
 * Its redirects are followed here, at most {@link MAX_REDIRECTS}, so each one is checked.
 */

import { lookup as lookupHost } from "node:dns/promises"
import { BlockList, isIP } from "node:net"

import { APIClient } from "@mailwoman/core/api"
import type { Readable } from "@mailwoman/core/fs/streams"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { silentLogger } from "@mailwoman/core/logging"
import { z } from "zod"

import { readPath } from "#dev-mcp/tally"
import type { DevTool, DevToolDeps } from "#dev-mcp/tool-kit"

const DEFAULT_MAX_BYTES = 200_000
const MAX_MAX_BYTES = 2_000_000
const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 30_000

/**
 * The address families `isIP` returns and the `lookup` callback takes.
 */
const IPV4 = 4
const IPV6 = 6

/**
 * The HTTP redirect statuses: 300 up to, but not including, 400.
 */
const REDIRECT_STATUS = { min: 300, end: 400 } as const

/**
 * A client name without a user, project or host name in it.
 */
const USER_AGENT = "dev-http-get/1.0"

/**
 * The address ranges a request may not reach.
 *
 * IPv4: this network, the RFC 1918 private ranges, shared address space, link-local,
 * IETF protocol assignments, benchmarking, multicast, reserved and broadcast.
 * IPv6: unspecified, unique-local, link-local and multicast.
 * An IPv4-mapped IPv6 address is checked as its IPv4 address.
 */
const REFUSED_RANGES = (() => {
	const list = new BlockList()

	for (const [network, prefix] of [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["224.0.0.0", 4],
		["240.0.0.0", 4],
	] as const) {
		list.addSubnet(network, prefix, "ipv4")
	}

	for (const [network, prefix] of [
		["::", 128],
		["fc00::", 7],
		["fe80::", 10],
		["ff00::", 8],
	] as const) {
		list.addSubnet(network, prefix, "ipv6")
	}

	return list
})()

const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu

/**
 * Whether a request may connect to `address`: any address outside {@link REFUSED_RANGES}, loopback included.
 */
function isAdmittedAddress(address: string): boolean {
	const mapped = MAPPED_IPV4.exec(address)

	if (mapped) return isAdmittedAddress(mapped[1]!)

	const family = isIP(address)

	if (!family) return false

	return !REFUSED_RANGES.check(address, family === IPV6 ? "ipv6" : "ipv4")
}

/**
 * Resolves a host name to every address it has, injected by a test.
 */
type ResolveHost = (hostname: string) => Promise<LookupAddress[]>

/**
 * One resolved address, in the form both the resolver and Axios's `lookup` callback use.
 */
interface LookupAddress {
	address: string
	family: 4 | 6
}

const resolveHost: ResolveHost = async (hostname) =>
	(await lookupHost(hostname, { all: true, verbatim: true })).map((entry) => ({
		address: entry.address,
		family: entry.family === IPV6 ? IPV6 : IPV4,
	}))

/**
 * The tool's input.
 */
const HTTP_GET_INPUT_SCHEMA = z.object({
	url: z.string().min(1).describe("An http or https URL."),
	accept: z.string().min(1).optional().describe("The `Accept` header. Default `*/*`."),
	json_path: z
		.string()
		.min(1)
		.optional()
		.describe(
			"A dotted path through the objects of a JSON body, such as `conformsTo` or `meta.count`. Arrays are not traversed. " +
				"An absent path, or a body that isn't JSON, is reported as an error rather than as null."
		),
	max_bytes: z
		.number()
		.int()
		.positive()
		.max(MAX_MAX_BYTES)
		.default(DEFAULT_MAX_BYTES)
		.describe(`The most body bytes read. Default ${DEFAULT_MAX_BYTES}, at most ${MAX_MAX_BYTES}.`),
	include_headers: z.array(z.string().min(1)).optional().describe("Response header names to return."),
})

type HTTPGetInput = z.input<typeof HTTP_GET_INPUT_SCHEMA>

/**
 * One response on the way to the final one.
 */
interface RedirectHop {
	url: string
	status: number
	location: string | null
	addresses: string[]
}

/**
 * What one GET returned, or why it reached no response.
 */
interface HTTPGetResult {
	url: string
	finalURL: string
	status: number | null
	contentType: string | null
	headers: Record<string, string | null>
	redirects: RedirectHop[]
	/**
	 * Whether the content type is binary.
	 *
	 * A binary body returns its length and type, and `body` is `null`.
	 * A text body is returned in `body`.
	 */
	binary: boolean
	body: string | null
	bytesRead: number
	/**
	 * Whether the body went past `maxBytes`, so `body` holds its first `maxBytes` bytes.
	 */
	truncated: boolean
	maxBytes: number
	/**
	 * The body's full length: the bytes read when the body ended within the cap,
	 * the `Content-Length` of an uncompressed body otherwise, and `null` when neither is known.
	 */
	fullLength: number | null
	json: { path: string; present: true; value: unknown } | { path: string; present: false; error: string } | null
	/**
	 * Why no response came back, with the cause code, such as `ECONNREFUSED`.
	 */
	error: { message: string; causeCode: string | null } | null
}

const TEXT_TYPE = /^(?:text\/|application\/(?:[\w.+-]*\+)?(?:json|xml|javascript|ecmascript|x-www-form-urlencoded))/iu

/**
 * Whether a content type is text: `text/*`, JSON, XML, JavaScript or a form,
 * with or without a `+json` suffix.
 *
 * A response with no content type is read as text.
 */
function isTextType(contentType: string | null): boolean {
	return !contentType || TEXT_TYPE.test(contentType.trim())
}

/**
 * Refuse a URL whose scheme isn't http or https, or whose host resolves to a refused address.
 *
 * @returns The addresses the connection may use.
 */
async function admittedAddresses(url: URL, resolve: ResolveHost): Promise<LookupAddress[]> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`mwdev_http_get fetches http and https URLs only; ${url.href} uses ${url.protocol.slice(0, -1)}.`)
	}

	const hostname = url.hostname.replace(/^\[(.*)\]$/u, "$1")
	const literal = isIP(hostname)

	const addresses: LookupAddress[] = literal
		? [{ address: hostname, family: literal === IPV6 ? IPV6 : IPV4 }]
		: await resolve(hostname)

	if (!addresses.length) throw new Error(`${hostname} resolved to no address.`)

	const refused = addresses.filter((entry) => !isAdmittedAddress(entry.address))

	if (refused.length) {
		throw new Error(
			`mwdev_http_get refuses ${url.href}: ${hostname} resolves to ${refused.map((entry) => entry.address).join(", ")}, ` +
				"in a private, link-local, unique-local, multicast or unspecified range. Loopback and public addresses are admitted."
		)
	}

	return addresses
}

/**
 * The code of the system error under an `APIClient` failure, such as `ECONNREFUSED`.
 */
function causeCode(error: unknown): string | null {
	for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
		const code = (current as { code?: unknown }).code

		if (typeof code === "string" && /^E[A-Z]+$/u.test(code)) return code
	}

	return null
}

/**
 * Read at most `maxBytes` of a stream, then stop it.
 */
async function readCapped(stream: Readable, maxBytes: number): Promise<{ bytes: Buffer; ended: boolean }> {
	const chunks: Buffer[] = []
	let total = 0

	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)

		chunks.push(buffer)
		total += buffer.byteLength

		// One byte past the cap shows the body was longer than the cap.
		if (total > maxBytes) {
			stream.destroy()

			return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), ended: false }
		}
	}

	return { bytes: Buffer.concat(chunks), ended: true }
}

function headerValue(headers: Record<string, unknown>, name: string): string | null {
	const value = headers[name.toLowerCase()]

	if (value == null) return null

	return Array.isArray(value) ? value.join(", ") : String(value)
}

/**
 * The services a GET goes through, injected by a test.
 */
export interface HTTPGetServices {
	resolve?: ResolveHost
}

/**
 * GET one URL, following and checking each redirect.
 *
 * @throws A refusal for a scheme other than http or https, a refused address, or a redirect past the limit.
 * A request that reached no response returns `error` with the cause code instead.
 */
async function httpGet(raw: HTTPGetInput, services: HTTPGetServices = {}): Promise<HTTPGetResult> {
	const input = HTTP_GET_INPUT_SCHEMA.parse(raw)
	const resolve = services.resolve ?? resolveHost
	const redirects: RedirectHop[] = []

	await using client = new APIClient({
		displayName: "mwdev-http-get",
		logger: silentLogger(),
		axios: {
			timeout: REQUEST_TIMEOUT_MS,
			maxRedirects: 0,
			proxy: false,
			decompress: true,
			responseType: "stream",
			validateStatus: () => true,
		},
	})

	let url = new URL(input.url)

	for (;;) {
		const addresses = await admittedAddresses(url, resolve)

		let response

		try {
			response = await client.fetch<Readable>({
				url: url.href,
				method: "GET",
				headers: { "User-Agent": USER_AGENT, Accept: input.accept ?? "*/*" },
				// The connection uses the addresses the check above admitted.
				lookup: (_hostname, options, callback) => {
					callback(null, (options as { all?: boolean }).all === true ? addresses : addresses[0]!)
				},
			})
		} catch (error) {
			return {
				url: input.url,
				finalURL: url.href,
				status: null,
				contentType: null,
				headers: {},
				redirects,
				binary: false,
				body: null,
				bytesRead: 0,
				truncated: false,
				maxBytes: input.max_bytes,
				fullLength: null,
				json: null,
				error: { message: error instanceof Error ? error.message : String(error), causeCode: causeCode(error) },
			}
		}

		const headers = response.headers as Record<string, unknown>
		const location = headerValue(headers, "location")

		if (response.status >= REDIRECT_STATUS.min && response.status < REDIRECT_STATUS.end && location) {
			response.data.destroy()

			redirects.push({
				url: url.href,
				status: response.status,
				location,
				addresses: addresses.map((entry) => entry.address),
			})

			if (redirects.length > MAX_REDIRECTS) {
				throw new Error(
					`mwdev_http_get follows at most ${MAX_REDIRECTS} redirects, and ${input.url} redirected more: ${stringifyJSON(redirects.map((hop) => hop.url))}.`
				)
			}

			url = new URL(location, url)

			continue
		}

		const contentType = headerValue(headers, "content-type")
		const binary = !isTextType(contentType)
		const { bytes, ended } = await readCapped(response.data, input.max_bytes)
		const declared = headerValue(headers, "content-length")
		const encoded = headerValue(headers, "content-encoding")

		const fullLength = ended
			? bytes.byteLength
			: declared != null && !encoded && Number.isFinite(Number(declared))
				? Number(declared)
				: null

		const body = binary ? null : bytes.toString("utf8")

		return {
			url: input.url,
			finalURL: url.href,
			status: response.status,
			contentType,
			headers: Object.fromEntries((input.include_headers ?? []).map((name) => [name, headerValue(headers, name)])),
			redirects,
			binary,
			body,
			bytesRead: bytes.byteLength,
			truncated: !ended,
			maxBytes: input.max_bytes,
			fullLength,
			json: input.json_path ? projectJSON(body, input.json_path, { binary, truncated: !ended }) : null,
			error: null,
		}
	}
}

/**
 * Project a JSON body by a dotted path, or state why it couldn't be.
 */
function projectJSON(
	body: string | null,
	path: string,
	state: { binary: boolean; truncated: boolean }
): NonNullable<HTTPGetResult["json"]> {
	if (state.binary || body == null)
		return { path, present: false, error: "the body is a binary type, so it was not parsed" }

	if (state.truncated) {
		return { path, present: false, error: "the body passed max_bytes, so the truncated text was not parsed as JSON" }
	}

	let value: unknown

	try {
		value = parseJSONStrict<unknown>(body)
	} catch (error) {
		return {
			path,
			present: false,
			error: `the body is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		}
	}

	const read = readPath(value, path)

	if (!read.present)
		return { path, present: false, error: `the path ${stringifyJSON(path)} is absent from the JSON body` }

	return { path, present: true, value: read.value }
}

/**
 * The `mwdev_http_get` tool.
 *
 * @param services The host resolver, injected by a test.
 */
export const httpGetTool = (_deps: DevToolDeps, services: HTTPGetServices = {}): DevTool => ({
	name: "mwdev_http_get",
	description:
		"GET one http or https URL and return the status, the final URL and redirect chain, the content type, the requested " +
		"headers, and the body up to `max_bytes` with `truncated` and the full length when known, or the value at " +
		"`json_path` in a JSON body. A binary type returns its length without the body. It sends no body, cookie or " +
		"credential. A host that resolves to a private, link-local or unique-local address is refused, and loopback is " +
		"admitted. A request that reached no response returns `error` with its cause code, such as ECONNREFUSED.",
	inputSchema: HTTP_GET_INPUT_SCHEMA,
	handler: async (args) => httpGet(args as HTTPGetInput, services),
})
