/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressInfo } from "node:net"

import express from "express"
import { expect, test } from "vitest"

import { createPhotonRouter, type PhotonEngine } from "./index.js"

const engine: PhotonEngine = {
	search: async () => ({ type: "FeatureCollection", features: [] }),
}

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

test("CORS: permissive Access-Control-Allow-Origin on responses (upstream Photon parity)", async () => {
	await withServer(express().use(createPhotonRouter(engine)), async (base) => {
		const res = await fetch(`${base}/api?q=berlin`)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
	})
})

test("CORS: preflight OPTIONS answers 204 with CORS headers", async () => {
	await withServer(express().use(createPhotonRouter(engine)), async (base) => {
		const res = await fetch(`${base}/api`, { method: "OPTIONS" })
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		expect(res.headers.get("access-control-allow-methods")).toContain("GET")
	})
})

test("CORS: { cors: false } disables the headers (for a proxy that owns CORS)", async () => {
	await withServer(express().use(createPhotonRouter(engine, { cors: false })), async (base) => {
		const res = await fetch(`${base}/api?q=berlin`)
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})
