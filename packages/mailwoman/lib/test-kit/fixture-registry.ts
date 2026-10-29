/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A local stand-in for the published data bucket, and the fixture databases the installation tests serve.
 *
 *   The registry answers HEAD and ranged GET with an ETag per object, and can drop a connection part-way
 *   through a body or answer 404, so the installer's resume, restart and failure paths run against real HTTP.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { writeLocalBuffer, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { md5Hex, sha256Hex } from "@mailwoman/core/hash"
import {
	type ArtifactManifest,
	ArtifactFormat,
	artifactIDFromSHA256,
	artifactSetID,
	type LayerInstallation,
	type LayerInstallationID,
	layerInstallationID,
	type SelectionEntry,
	NormalizationRequirement,
	ROLE_REQUIREMENTS,
	ServingRole,
} from "@mailwoman/core/layers"
import {
	ADDRESS_POINT_COLUMNS,
	type AddressPointDatabase,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address"
import { normalizeStreetForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import {
	createStreetSegmentTable,
	type StreetSegmentDatabase,
} from "@mailwoman/resolver-wof-sqlite/street/segment-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { type PathBuilderLike, relative } from "path-ts"

import { catalogPaths, writeInstallation, writeRecordAtomically } from "#data/catalog"

/**
 * A static object store with HEAD, ranged GET, per-object ETags and injected failures.
 */
export class FixtureRegistry implements AsyncDisposable {
	readonly objects = new Map<string, { body: Buffer; etag: string }>()
	/**
	 * Every request, as `METHOD key` with ` bytes=N-` appended for a resumed range.
	 */
	readonly requests: string[] = []
	/**
	 * Object key to the number of bytes the next unranged GET sends before the connection drops.
	 */
	readonly interruptAfter = new Map<string, number>()
	/**
	 * Object keys that answer 404.
	 */
	readonly missing = new Set<string>()
	/**
	 * Object key to the number of bytes the next unranged GET sends before the body stalls,
	 * open, until the client closes the connection.
	 */
	readonly stallAfter = new Map<string, number>()
	/**
	 * The keys whose stalled bytes have been written, in order.
	 */
	readonly stalled: string[] = []
	#server: Server | null = null
	baseURL = ""

	put(key: string, body: Buffer, etag = `"${md5Hex(body)}"`): void {
		this.objects.set(key, { body, etag })
	}

	async start(): Promise<this> {
		this.#server = createServer((request, response) => this.#answer(request, response))

		await new Promise<void>((resolve) => {
			this.#server!.listen(0, "127.0.0.1", resolve)
		})

		this.baseURL = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/`

		return this
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.#server?.closeAllConnections()

		await new Promise<void>((resolve) => {
			if (this.#server) {
				this.#server.close(() => resolve())
			} else {
				resolve()
			}
		})
	}

	#answer(request: IncomingMessage, response: ServerResponse): void {
		const key = decodeURIComponent((request.url ?? "/").slice(1))
		const range = request.headers.range
		const object = this.objects.get(key)

		this.requests.push(`${request.method} ${key}${range && range !== "bytes=0-" ? ` ${range}` : ""}`)

		if (!object || this.missing.has(key)) {
			response.writeHead(404).end()

			return
		}

		const headers = {
			etag: object.etag,
			"last-modified": "Wed, 28 Oct 2026 00:00:00 GMT",
			"accept-ranges": "bytes",
		}

		if (request.method === "HEAD") {
			response.writeHead(200, { ...headers, "content-length": object.body.length }).end()

			return
		}

		const start = Number(/^bytes=(\d+)-$/u.exec(range ?? "")?.[1] ?? 0)

		if (start > 0) {
			response.writeHead(206, {
				...headers,
				"content-length": object.body.length - start,
				"content-range": `bytes ${start}-${object.body.length - 1}/${object.body.length}`,
			})

			response.end(object.body.subarray(start))

			return
		}

		const sentBeforeDrop = this.interruptAfter.get(key)

		response.writeHead(200, { ...headers, "content-length": object.body.length })

		if (sentBeforeDrop != null) {
			this.interruptAfter.delete(key)
			// The delay lets the client read the bytes before the connection drops mid-body.
			response.write(object.body.subarray(0, sentBeforeDrop), () => setTimeout(() => response.destroy(), 100))

			return
		}

		const sentBeforeStall = this.stallAfter.get(key)

		if (sentBeforeStall != null) {
			this.stallAfter.delete(key)
			// The body stays open until the client gives up, as a transfer a customer cancels does.
			response.write(object.body.subarray(0, sentBeforeStall), () => this.stalled.push(key))

			return
		}

		response.end(object.body)
	}
}

/**
 * The street of the District of Columbia's one fixture address point, 1275 Pennsylvania Avenue NW, 20004.
 */
export const FIXTURE_DC_STREET = "Pennsylvania Avenue NW"

/**
 * The fixture point's coordinates.
 */
export const FIXTURE_DC_POINT = { lat: 38.8964, lon: -77.0297 } as const

/**
 * Write an address-point database holding the one District of Columbia fixture point.
 */
export async function writeFixtureAddressPoints(path: PathBuilderLike): Promise<void> {
	using db = new DatabaseClient<AddressPointDatabase>(path)

	await createAddressPointTable(db)

	const key = normalizeStreetForKey(FIXTURE_DC_STREET)

	db.prepare(`INSERT INTO address_point VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`).run(
		key,
		key,
		"1275",
		null,
		"20004",
		"washington",
		FIXTURE_DC_STREET,
		FIXTURE_DC_POINT.lat,
		FIXTURE_DC_POINT.lon,
		"fixture",
		"r1",
		null,
		null
	)
}

/**
 * Install one artifact of `bytes` as `role` under `dataRoot`: its file, manifest and installation record.
 *
 * By default a candidate or a POI database is unscoped, and every other role is
 * scoped to the District of Columbia and keyed by US streets.
 * `options` sets another scope, street locale or file format.
 *
 * @returns The selection entry that selects it, and its path.
 */
export async function installFixtureArtifact(
	dataRoot: PathBuilderLike,
	role: ServingRole,
	fileName: string,
	bytes: string | Buffer,
	options: {
		scope?: ArtifactManifest["scope"]
		entryScope?: SelectionEntry["scope"]
		locale?: string
		format?: ArtifactManifest["format"]
	} = {}
): Promise<{ entry: SelectionEntry; path: string; installationID: LayerInstallationID }> {
	const root = dataRoot.toString()
	const id = artifactIDFromSHA256(sha256Hex(bytes))
	const directory = catalogPaths(root).artifactDirectory(role, id)
	const path = directory(fileName).toString()
	const unscoped = role === ServingRole.Candidate || role === ServingRole.POI
	const keyed = ROLE_REQUIREMENTS[role].normalization === NormalizationRequirement.Required

	const manifest: ArtifactManifest = {
		id,
		role,
		format: options.format ?? ArtifactFormat.SQLite,
		schemaVersion: 1,
		bytes: Buffer.byteLength(bytes),
		normalization: keyed ? { algorithm: "street-key", version: "1", locale: options.locale ?? "us" } : null,
		scope:
			options.scope ??
			(unscoped ? { countries: [], subdivisions: null } : { countries: ["US"], subdivisions: ["US-DC"] }),
		observedCountries: null,
		coverageEvidence: false,
		sources: [{ publisher: "fixture", release: null, url: null, sha256: null, md5: null }],
		recipe: null,
		builderSHA: null,
		license: "CC0-1.0",
		createdAt: "2026-10-29T00:00:00Z",
	}

	await (typeof bytes === "string" ? writeLocalTextFile(bytes, path) : writeLocalBuffer(bytes, path))
	await writeRecordAtomically(manifest, directory("manifest.json"))

	const set = artifactSetID([{ artifactID: id, role, schemaVersion: 1 }])
	const origin = { kind: "published" as const, entry: role, release: fileName }

	const installation: LayerInstallation = {
		id: layerInstallationID(set, origin),
		artifactSet: set,
		origin,
		artifacts: [{ artifactID: id, role, path: relative(root, path) }],
		installedAt: "2026-10-29T00:00:00Z",
	}

	await writeInstallation(root, installation)

	const scope =
		options.entryScope ?? (unscoped ? { country: null, subdivision: null } : { country: "US", subdivision: "US-DC" })

	return {
		entry: { role, scope, order: [{ installationID: installation.id, artifactID: id }] },
		path,
		installationID: installation.id,
	}
}

/**
 * Write an interpolation database with an empty `street_segment` table.
 */
export async function writeFixtureInterpolation(path: PathBuilderLike): Promise<void> {
	using db = new DatabaseClient<StreetSegmentDatabase>(path)

	await createStreetSegmentTable(db)
}
