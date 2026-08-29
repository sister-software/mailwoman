/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The LOCAL comparison rigs — start them, stop them, ask them a question.
 *
 *   `mwdev_compare`'s external arm grades an already-running engine but deliberately never starts one, so bringing a rig
 *   up was a shell exercise in `scratchpad/*-rig/*.sh` that a fresh context has no way to know about (and that a fresh
 *   checkout does not even carry — the scratchpad is gitignored). This module owns the small durable half: container
 *   lifecycle and a one-off query. The heavyweight half stays in those scripts, and stays manual on purpose — dump
 *   downloads, checksum verification, index extraction and atomic promotion are one-time operations with real disk and
 *   licence consequences, and nothing here will perform them.
 *
 *   Endpoints are PINNED TO LOOPBACK by the registry below and cannot be overridden. That is the same commitment
 *   `REFUSED_ENDPOINT_HOSTS` makes on the grading path, arrived at from the other side: a tool that can be pointed
 *   anywhere eventually gets pointed at `photon.komoot.io`, and a volunteer endpoint is not ours to spend. A comparison
 *   against some other host is `mwdev_compare`'s external arm, which refuses the shared instances by name.
 *
 *   Queries here are OBSERVATIONS, not measurements: no grading, no rate, no verdict. `mwdev_compare` is what turns two
 *   engines into a number.
 */

import { APIClient } from "@mailwoman/core/api"
import { execFile } from "@mailwoman/platform/child_process"
import { promisify } from "@mailwoman/platform/util"
import { TextSpliterator } from "spliterator"

import { assertScorableEndpoint } from "./external-arm.ts"

const exec = promisify(execFile)

/**
 * Pacing for rig traffic, ms between dispatches. These are our own containers on our own host, so the interval is not
 * politeness — it is the same discipline the graded arm uses, kept identical so an observation here and a measurement
 * there cannot differ by request pattern.
 */
const RIG_MIN_REQUEST_INTERVAL_MS = 250

const RIG_TIMEOUT_MS = 15_000

/**
 * One paced client per rig, built on first use and reused — the house `APIClient` rather than raw `fetch`, so rig
 * traffic gets the same pacing, bounded retry and `ResourceError` mapping as every other HTTP caller in the repo (and
 * so this tool exercises the client we ship).
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
			// A rig that is still warming answers 4xx/5xx; those are STATES here, read from the status field, not
			// exceptions to throw. `rigQuery` reports the code per row.
			validateStatus: () => true,
		},
	})

	clients.set(name, client)

	return client
}

/**
 * Container runtime the rigs were built with. Podman rather than Docker because that is what the lab host runs and what
 * the rig scripts already created these containers under — a `docker` invocation here would report "no such container"
 * for containers that exist.
 */
const CONTAINER_RUNTIME = "podman"

/**
 * How long to wait for a rig to answer after `start`, ms. Elasticsearch dominates: a cold Pelias stack answers its
 * first query around 30s after the containers report running, and a fixed sleep would either lie or waste the
 * difference.
 */
const HEALTH_TIMEOUT_MS = 180_000

const HEALTH_POLL_MS = 3000

/**
 * The 2xx band — a rig's answer counts only when the response is one, and both call sites read the same pair rather
 * than re-typing the numbers.
 */
const HTTP_OK_MIN = 200
const HTTP_OK_MAX = 300

/**
 * The rigs this tool can drive. `containers` is in START order; stop reverses it, because Elasticsearch must outlive
 * the API that queries it.
 */
export const ENGINE_RIGS = {
	pelias: {
		engine: "pelias",
		containers: ["pelias_elasticsearch", "pelias_libpostal", "pelias_interpolation", "pelias_api"],
		endpoint: "http://127.0.0.1:4000",
		healthPath: "/v1/search?text=Berlin&size=1",
		searchPath: (query: string) => `/v1/search?text=${encodeURIComponent(query)}&size=3`,
		rigScript: "scratchpad/benchmark-rig/pelias-lifecycle.sh",
	},
	photon: {
		engine: "photon",
		containers: ["mailwoman-photon-benchmark"],
		endpoint: "http://127.0.0.1:2323",
		healthPath: "/api?q=Berlin&limit=1",
		searchPath: (query: string) => `/api?q=${encodeURIComponent(query)}&limit=3`,
		rigScript: "scratchpad/photon-rig/photon-lifecycle.sh",
	},
} as const

export type EngineRigName = keyof typeof ENGINE_RIGS

interface ContainerState {
	name: string
	/**
	 * The runtime's own status string (`Up 2 minutes`, `Exited (0) 3 days ago`, `Created`), or `absent` when no container
	 * by that name exists — which is a DIFFERENT fact from a stopped one: absent means the rig was never built here, and
	 * building it is the manual half this module refuses to do.
	 */
	status: string
}

export interface RigStatus {
	engine: EngineRigName
	endpoint: string
	containers: ContainerState[]
	/**
	 * Whether the endpoint answered its health query just now. `false` with running containers is the normal state during
	 * an Elasticsearch warm-up, not a fault.
	 */
	answering: boolean
	/**
	 * Absent when every container is absent — the rig has to be built by its script first.
	 */
	built: boolean
}

/**
 * One result as this tool reports it — engine-neutral, so a reader compares two engines without learning two payload
 * shapes. `sourceID` is the thing worth reading: Pelias's `gid` says WHICH dataset supplied the answer
 * (`whosonfirst:locality:101750331` vs `geonames:locality:2639268`), which is how a coverage question gets settled.
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
	const { stdout } = await exec(CONTAINER_RUNTIME, args, { maxBuffer: 8 * 1024 * 1024 })

	return stdout.trim()
}

/**
 * Container states for one rig — absent containers reported as `absent` rather than omitted, so a partially built rig
 * is legible.
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
			.filter((line) => line.length > 0)
			.map((line) => {
				const [name, ...rest] = TextSpliterator.from(line, { delimiter: "\t" })

				return [name!.trim(), rest.join("\t").trim()] as const
			})
	)

	return rig.containers.map((name) => ({ name, status: known.get(name) ?? "absent" }))
}

/**
 * Does the endpoint answer right now? A failed fetch is `false`, never a throw: "not answering" is the answer.
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
 * Start a rig and wait for it to ANSWER, not merely to be running — a container that is up while Elasticsearch is still
 * loading serves 500s, and a caller told "started" would read those as the engine's opinion.
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
 * Stop a rig in reverse start order. Never removes a container or its data — the rigs carry frozen indices that cost
 * hours to rebuild, and `podman rm` is not a verb this tool has.
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
 * Normalize one engine's payload into {@link RigResult}s.
 *
 * Both rigs answer GeoJSON, and both put the interesting identity in `properties` under different keys: Pelias carries
 * `gid` + `layer`, Photon carries `osm_type`/`osm_id` + `osm_key`/`osm_value`. Reading the position is the classic
 * hazard — GeoJSON orders it [lon, lat], and reading it the other way lands every result in the wrong hemisphere while
 * still looking plausible near the equator.
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
 * Ask a running rig about a handful of strings. Sequential by construction — these are observations, and a rig sharing
 * a host with a build has no business being flooded.
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
