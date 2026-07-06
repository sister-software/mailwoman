/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressInfo } from "node:net"

import express from "express"
import { expect, test } from "vitest"

import {
	COMPONENT_TO_LIBPOSTAL,
	createLibpostalRouter,
	type LibpostalEngine,
	type ParseMatch,
	toLibpostalComponents,
} from "./index.js"

test("toLibpostalComponents: maps our classifications to libpostal labels, in order", () => {
	const matches: ParseMatch[] = [
		{ classification: "house_number", value: "1600" },
		{ classification: "street", value: "Pennsylvania Ave NW" },
		{ classification: "locality", value: "Washington" },
		{ classification: "region", value: "DC" },
		{ classification: "postcode", value: "20500" },
	]
	expect(toLibpostalComponents(matches)).toEqual([
		{ label: "house_number", value: "1600" },
		{ label: "road", value: "Pennsylvania Ave NW" },
		{ label: "city", value: "Washington" },
		{ label: "state", value: "DC" },
		{ label: "postcode", value: "20500" },
	])
})

test("toLibpostalComponents: passes unmapped classifications through unchanged", () => {
	expect(toLibpostalComponents([{ classification: "some_future_tag", value: "x" }])).toEqual([
		{ label: "some_future_tag", value: "x" },
	])
})

test("COMPONENT_TO_LIBPOSTAL: the core US/EU mappings hold", () => {
	expect(COMPONENT_TO_LIBPOSTAL.street).toBe("road")
	expect(COMPONENT_TO_LIBPOSTAL.locality).toBe("city")
	expect(COMPONENT_TO_LIBPOSTAL.region).toBe("state")
	expect(COMPONENT_TO_LIBPOSTAL.postcode).toBe("postcode")
})

const corsEngine: LibpostalEngine = { parse: async () => [] }

/** Boot the app on an ephemeral port, hand the base URL to `fn`, always close. */
async function withServer(app: express.Express, fn: (base: string) => Promise<void>): Promise<void> {
	const server = app.listen(0)
	await new Promise((resolve) => server.once("listening", resolve))
	const { port } = server.address() as AddressInfo

	try {
		await fn(`http://127.0.0.1:${port}`)
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
	}
}

test("CORS: permissive Access-Control-Allow-Origin on responses (browser clients)", async () => {
	await withServer(express().use(createLibpostalRouter(corsEngine)), async (base) => {
		const res = await fetch(`${base}/parse?query=1600+pennsylvania+ave`)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
	})
})

test("CORS: preflight OPTIONS answers 204 with CORS headers (POST /parse is preflighted)", async () => {
	await withServer(express().use(createLibpostalRouter(corsEngine)), async (base) => {
		const res = await fetch(`${base}/parse`, { method: "OPTIONS" })
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		expect(res.headers.get("access-control-allow-methods")).toContain("POST")
	})
})

test("CORS: { cors: false } disables the headers (for a proxy that owns CORS)", async () => {
	await withServer(express().use(createLibpostalRouter(corsEngine, { cors: false })), async (base) => {
		const res = await fetch(`${base}/parse?query=x`)
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})
