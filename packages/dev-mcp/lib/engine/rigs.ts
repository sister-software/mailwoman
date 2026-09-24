/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Manage local Pelias and Photon containers and query their loopback endpoints. Building indexes and downloading
 *   source data remain manual. Queries report observations only; `mwdev_compare` performs scored comparisons.
 */

import { APIClient } from "@mailwoman/core/api"
import { tempRootPath } from "@mailwoman/core/data-root"
import { runFile } from "@mailwoman/core/process"
import { TextSpliterator } from "spliterator"

import { assertScorableEndpoint } from "#external-arm"

/**
 * Delay between requests, matching the comparison client.
 */
const RIG_MIN_REQUEST_INTERVAL_MS = 250

const RIG_TIMEOUT_MS = 15_000

/**
 * Reuse one paced API client per rig.
 */
const clients = new Map<EngineRigName, APIClient>()

function clientFor(name: EngineRigName): APIClient {
	const existing = clients.get(name)

	if (existing) return existing

	const rig = ENGINE_RIGS[name]

	const client = new APIClient({
		displayName: `rig:${name}`,
		minRequestIntervalMs: RIG_MIN_REQUEST_INTERVAL_MS,
		axios: {
			baseURL: assertScorableEndpoint(rig.endpoint),
			timeout: RIG_TIMEOUT_MS,
			headers: { "User-Agent": "mailwoman-dev-mcp" },
			// Return HTTP errors as response statuses for the caller to report.
			validateStatus: () => true,
		},
	})

	clients.set(name, client)

	return client
}

/**
 * Container runtime used by the local rig scripts.
 */
const CONTAINER_RUNTIME = "podman"

/**
 * Maximum time to wait for the endpoint after starting containers.
 */
const HEALTH_TIMEOUT_MS = 180_000

const HEALTH_POLL_MS = 3000

/**
 * Bounds of the successful HTTP status range.
 */
const HTTP_OK_MIN = 200
const HTTP_OK_MAX = 300

/**
 * Resolve a rig lifecycle script from the temporary root.
 */
function rigScriptPath(...segments: string[]): string {
	return tempRootPath(...segments)
}

/**
 * Local rig containers, endpoints, and query paths.
 * Containers are listed in startup order.
 */
export const ENGINE_RIGS = {
	pelias: {
		engine: "pelias",
		containers: ["pelias_elasticsearch", "pelias_libpostal", "pelias_interpolation", "pelias_api"],
		endpoint: "http://127.0.0.1:4000",
		healthPath: "/v1/search?text=Berlin&size=1",
		searchPath: (query: string) => `/v1/search?text=${encodeURIComponent(query)}&size=3`,
		rigScript: rigScriptPath("benchmark-rig", "pelias-lifecycle.sh"),
	},
	photon: {
		engine: "photon",
		containers: ["mailwoman-photon-benchmark"],
		endpoint: "http://127.0.0.1:2323",
		healthPath: "/api?q=Berlin&limit=1",
		searchPath: (query: string) => `/api?q=${encodeURIComponent(query)}&limit=3`,
		rigScript: rigScriptPath("photon-rig", "photon-lifecycle.sh"),
	},
} as const

export type EngineRigName = keyof typeof ENGINE_RIGS

interface ContainerState {
	name: string
	/**
	 * Container status, or `absent` when no such container exists.
	 */
	status: string
}

export interface RigStatus {
	engine: EngineRigName
	endpoint: string
	containers: ContainerState[]
	/**
	 * Whether the health endpoint answered.
	 * It may be false while containers are warming up.
	 */
	answering: boolean
	/**
	 * Whether any rig container exists.
	 */
	built: boolean
}

/**
 * Engine-neutral result.
 * `sourceID` identifies the source dataset when available.
 */
export interface RigResult {
	name: string | null
	kind: string | null
	sourceID: string | null
	lat: number | null
	lon: number | null
}

export interface RigQueryRow {
	query: string
	results: RigResult[]
	error?: string
}

async function runtime(args: string[]): Promise<string> {
	const { stdout } = await runFile(CONTAINER_RUNTIME, args, { maxBuffer: 8 * 1024 * 1024 })

	return stdout.trim()
}

/**
 * Return the status of each configured container, including absent containers.
 */
async function containerStates(rig: (typeof ENGINE_RIGS)[EngineRigName]): Promise<ContainerState[]> {
	let listing: string

	try {
		listing = await runtime(["ps", "-a", "--format", "{{.Names}}\t{{.Status}}"])
	} catch (error) {
		throw new Error(`${CONTAINER_RUNTIME} unavailable: ${(error as Error).message}`)
	}

	const known = new Map(
		[...TextSpliterator.from(listing)]
			.filter((line) => line.length)
			.map((line) => {
				const [name, ...rest] = TextSpliterator.from(line, { delimiter: "\t" })

				return [name!.trim(), rest.join("\t").trim()] as const
			})
	)

	return rig.containers.map((name) => ({ name, status: known.get(name) ?? "absent" }))
}

/**
 * Return whether the endpoint currently answers its health query.
 */
async function answering(name: EngineRigName): Promise<boolean> {
	try {
		const response = await clientFor(name).fetch<unknown>({ url: ENGINE_RIGS[name].healthPath })

		return response.status >= HTTP_OK_MIN && response.status < HTTP_OK_MAX
	} catch {
		return false
	}
}

export async function rigStatus(name: EngineRigName): Promise<RigStatus> {
	const rig = ENGINE_RIGS[name]
	const containers = await containerStates(rig)

	return {
		engine: name,
		endpoint: rig.endpoint,
		containers,
		answering: await answering(name),
		built: containers.some((c) => c.status !== "absent"),
	}
}

/**
 * Start existing containers and wait for the endpoint to respond.
 */
export async function rigStart(name: EngineRigName): Promise<RigStatus & { waitedMs: number }> {
	const rig = ENGINE_RIGS[name]
	const before = await containerStates(rig)

	if (before.every((c) => c.status === "absent")) {
		throw new Error(
			`${name}: no containers exist — build the rig first with ${rig.rigScript} (dump download, checksum ` +
				`verification and index extraction are deliberately outside this tool)`
		)
	}

	await runtime(["start", ...rig.containers.filter((c) => before.find((b) => b.name === c)?.status !== "absent")])

	const startedAt = Date.now()

	while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
		if (await answering(name)) break

		await new Promise<void>((resolve) => {
			setTimeout(resolve, HEALTH_POLL_MS)
		})
	}

	return { ...(await rigStatus(name)), waitedMs: Date.now() - startedAt }
}

/**
 * Stop running containers in reverse order without removing them or their data.
 */
export async function rigStop(name: EngineRigName): Promise<RigStatus> {
	const rig = ENGINE_RIGS[name]
	const present = (await containerStates(rig)).filter((c) => c.status !== "absent").map((c) => c.name)

	if (present.length) {
		await runtime(["stop", "--time", "120", ...present.toReversed()])
	}

	return rigStatus(name)
}

/**
 * Convert a rig's GeoJSON features into shared result fields.
 */
export function normalizeRigResults(engine: EngineRigName, body: unknown): RigResult[] {
	const features = (body as { features?: unknown[] })?.features

	if (!Array.isArray(features)) return []

	return features.map((raw) => {
		const feature = raw as { properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } }
		const properties = feature.properties ?? {}
		const coordinates = feature.geometry?.coordinates
		const [lon, lat] = Array.isArray(coordinates) ? (coordinates as number[]) : [undefined, undefined]

		const sourceID =
			engine === "pelias"
				? ((properties["gid"] as string | undefined) ?? null)
				: properties["osm_type"] && properties["osm_id"]
					? `osm:${String(properties["osm_type"])}:${String(properties["osm_id"])}`
					: null

		const kind =
			engine === "pelias"
				? ((properties["layer"] as string | undefined) ?? null)
				: ((properties["osm_value"] as string | undefined) ?? (properties["type"] as string | undefined) ?? null)

		return {
			name: (properties["name"] as string | undefined) ?? null,
			kind,
			sourceID,
			lat: typeof lat === "number" ? lat : null,
			lon: typeof lon === "number" ? lon : null,
		}
	})
}

/**
 * Query a rig sequentially and return observations without grading them.
 */
export async function rigQuery(name: EngineRigName, queries: readonly string[]): Promise<RigQueryRow[]> {
	const rig = ENGINE_RIGS[name]
	const rows: RigQueryRow[] = []

	const client = clientFor(name)

	for (const query of queries) {
		try {
			const response = await client.fetch<unknown>({ url: rig.searchPath(query) })

			if (response.status < HTTP_OK_MIN || response.status >= HTTP_OK_MAX) {
				rows.push({ query, results: [], error: `HTTP ${response.status}` })

				continue
			}

			rows.push({ query, results: normalizeRigResults(name, response.data) })
		} catch (error) {
			rows.push({ query, results: [], error: (error as Error).message })
		}
	}

	return rows
}
