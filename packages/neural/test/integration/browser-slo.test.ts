/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #378 browser SLO runner — the DECOMPOSED cold path, measured in a real browser against the local
 *   artifacts.
 *
 *   The end-to-end probe this replaces reported one number per stage ("warm parse+resolve 3.3 s"),
 *   and that number bundles inference, gazetteer range fetches and UI staging together, so no
 *   regression in it can be attributed. Every quantity below is measured and asserted on its own,
 *   against its own named budget, with the arm (backend) that produced it in the test name — a
 *   timing number is meaningless without the arm, and two arms never share an assertion.
 *
 *   WHAT IS UNDER MEASUREMENT: the neural browser runtime as a client bundles it —
 *   `@mailwoman/neural/web-onnx-runner` (onnxruntime-web, WASM + optional WebGPU) plus
 *   `@mailwoman/neural/tokenizer` (the SentencePiece core), reached through the package's compiled
 *   `out/` tree, which is what an npm consumer and the docs demo both bundle. Run `yarn compile`
 *   first: a stale `out/` measures stale code and nothing here can tell.
 *
 *   WHAT IS NOT: `@mailwoman/neural/web-loader` composes those two into a `NeuralAddressClassifier`,
 *   which reaches `@mailwoman/core` and from there `env-paths` / `graceful-fs` / `node:*`. Bundling
 *   THAT needs the node-builtin shim policy the docs site keeps in `docs/plugins/demo-assets/`, and
 *   a second copy of it would be a maintenance hazard inside a harness whose subject is timing. The
 *   two node imports the reduced graph does meet (`node:fs/promises` in the tokenizer's
 *   `loadFromFile`, `node:module` in the emscripten preamble) are DYNAMIC and node-guarded, so
 *   marking them external is the entire shim. The cost of the reduction: the warm number is
 *   tokenize+infer, not tokenize+infer+decode — which is the model-only number the instrumentation
 *   plan asked for, and the decoder is platform-free TS running identically on both hosts.
 *
 *   The demo additionally pulls the FST gazetteer (`fst-en-us.bin`, ~22 MB) through the runtime
 *   pipeline rather than through the neural loader. It is deliberately outside this accounting; add
 *   it here only alongside the pipeline stage that fetches it.
 *
 *   BUDGETS ARE REGRESSION TRIPWIRES, NOT TARGETS. They are set generously against the first run on
 *   the lab workstation. A failure means the quantity moved a lot; the repair is to read the receipt
 *   this file prints, not to widen the constant.
 *
 *   Byte budgets assert RAW bytes rather than wire bytes: raw is the artifact-size regression signal
 *   and is deterministic, while the wire number depends on the compressor. Both are reported,
 *   because the wire column is the one comparable to a live-demo trace.
 *
 *   READING THE RECEIPT: vitest's default reporter hides console output from a file whose tests all
 *   pass, so run it with the verbose reporter when you want the numbers rather than the verdict:
 *
 *   ```
 *   yarn vitest --run --config vitest.slow.config.ts \
 *     packages/neural/test/integration/browser-slo.test.ts --reporter=verbose
 *   ```
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { dataRootPath } from "@mailwoman/core/data-root"
import { gzipSync } from "@mailwoman/core/fs/compression"
import { statPath, realPath, pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { createRequire } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { median, percentile } from "@mailwoman/core/stats"
import { architecture, cpuCount, cpuModel, platformName, totalMemoryBytes } from "@mailwoman/core/utils/system"
import { resolveWeights, type ResolvedWeights } from "@mailwoman/neural"
import { build } from "esbuild"
import { basename, dirname, extname, normalize, resolvePath as resolveFilePath, sep } from "path-ts"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

// MARK: Budgets. One per decomposed quantity, each naming its arm.

/**
 * Raw bytes of `model.onnx`. The shipped int8 export measured 39,419,629 B (v4.4.0); the budget leaves room for a
 * quantization change without leaving room for an fp32 export (~4× larger).
 */
const MODEL_RAW_BYTES_BUDGET = 56_000_000

/**
 * Raw bytes of `tokenizer.model` — 1,632,289 B at the v0.9.0 multisplice vocabulary.
 */
const TOKENIZER_RAW_BYTES_BUDGET = 4_000_000

/**
 * Raw bytes of the onnxruntime-web `.wasm` the runtime requests from `wasmPaths`. WHICH variant it asks for is ORT's
 * decision at load time, not ours — the first run fetched the 22,867,301 B asyncify build — so the budget covers the
 * family rather than one file name. Compresses ~4× on the wire (5,580,159 B measured, against the live demo's 5.66 MB
 * brotli figure).
 */
const ORT_WASM_RAW_BYTES_BUDGET = 40_000_000

/**
 * Raw bytes of the sql.js-httpvfs runtime — its UMD entry, its worker, and `sql-wasm.wasm`.
 */
const SQLITE_RUNTIME_RAW_BYTES_BUDGET = 8_000_000

/**
 * Raw bytes of the bundled browser runtime JS (onnxruntime-web + the neural runner + the SentencePiece core, minified).
 * The demo's own app JS is larger — it carries React and MapLibre on top of this — so read the budget as a floor moving
 * under the client, not as the page weight.
 */
const RUNTIME_JS_RAW_BYTES_BUDGET = 4_000_000

/**
 * Raw bytes of the evidence lexicons plus the retrieval binaries the shipped web loader fetches beside the model: model
 * card, gazetteer / country / street-type / locality-surface lexicons, the postcode anchor binary, the placetype-pair
 * index. Asserted as one class because a per-artifact budget would need an edit every time a channel ships a new
 * lexicon generation.
 */
const EVIDENCE_RAW_BYTES_BUDGET = 32_000_000

/**
 * Session init on the WASM arm — tokenizer load plus ORT session creation, warm-up infer included, with the model bytes
 * already in memory so no network enters the number.
 */
const INIT_WASM_MS_BUDGET = 12_000

/**
 * Session init on the WebGPU arm. Asserted only when the browser granted a WebGPU adapter AND the runner's diagnostics
 * report `webgpu` — the runner falls back to WASM silently, so without that check the arm would measure the other arm
 * under a WebGPU name. Headless Chromium grants a SOFTWARE adapter (SwiftShader) where no GPU is reachable, which is
 * why the receipt prints the adapter's identity beside the number: 2,997 ms on SwiftShader is not a claim about
 * hardware.
 */
const INIT_WEBGPU_MS_BUDGET = 20_000

/**
 * Median tokenize+infer on the WASM arm, single-threaded. The 2026-06 node one-thread probe measured 41–44 ms p50/p95
 * on this class of model.
 */
const WARM_P50_WASM_MS_BUDGET = 140

/**
 * P95 tokenize+infer on the WASM arm, single-threaded.
 */
const WARM_P95_WASM_MS_BUDGET = 220

/**
 * HTTP range requests a cold gazetteer session costs — opening `candidate.db` over sql.js-httpvfs plus the
 * candidate-table probes. The candidate table is clustered so a probe touches a handful of B-tree pages; the demo's own
 * measured session was 38 requests. This budget is what fails when a schema or clustering change turns a probe into a
 * scan.
 */
const GAZETTEER_RANGE_REQUESTS_BUDGET = 120

/**
 * Peak `performance.memory.usedJSHeapSize` across the whole browser session. V8 accounts `ArrayBuffer` storage and WASM
 * linear memory OUTSIDE the JS heap, so this number does NOT include the ~53 MB of artifact bytes the session holds nor
 * ORT's own arena — it bounds the JS side only, which is where a leak in the runner or the tokenizer would show.
 * Measured at ~10 MiB on the first run; the budget is the "something is retaining objects per parse" regression check,
 * not a memory target.
 */
const PEAK_HEAP_BYTES_BUDGET = 268_435_456

// MARK: Fixtures.

/**
 * The warm-inference input set: four board-register en-US rows and the same four in the lowercase register, because
 * lowercase is what users type and every eval here carries a lowercase arm.
 */
const WARM_INPUTS = [
	"1600 Pennsylvania Ave NW, Washington, DC 20500",
	"350 Fifth Avenue, New York, NY 10118",
	"1 Infinite Loop, Cupertino, CA 95014",
	"PO Box 1234, Anchorage, AK 99501",
	"1600 pennsylvania ave nw, washington, dc 20500",
	"350 fifth avenue, new york, ny 10118",
	"1 infinite loop, cupertino, ca 95014",
	"po box 1234, anchorage, ak 99501",
] as const

/**
 * Lowercase rows in {@link WARM_INPUTS} — half of them, stated once so the receipt cannot drift from the fixture.
 */
const WARM_LOWERCASE_INPUTS = 4

/**
 * Measured parses per arm — above the plan's floor of 50, and a whole multiple of the input set so every register
 * contributes equally to the percentiles.
 */
const WARM_ITERATIONS = 64

/**
 * Discarded parses before measurement starts. The first few carry ORT's per-shape allocation.
 */
const WARM_WARMUP_ITERATIONS = 8

/**
 * `name_key` probes issued against the candidate table — the shape `WOFCandidateTableLookup` runs per resolve, enough
 * of them to touch more than one region of a multi-gigabyte file.
 */
const CANDIDATE_PROBE_KEYS = ["washington", "newyork", "cupertino", "anchorage", "london"] as const

/**
 * Rows a candidate probe pulls back — the resolver's own fetch width.
 */
const CANDIDATE_PROBE_LIMIT = 8

/**
 * Bytes per HTTP range request, matching the demo's sql.js-httpvfs configuration (16 SQLite pages at the candidate DB's
 * 8 KiB page size). Changing it changes the request count by construction.
 */
const HTTPVFS_CHUNK_SIZE = 65_536

/**
 * Chromium flags that let the WebGPU arm be attempted at all. Headless Chromium ships WebGPU behind this flag and
 * grants an adapter only where the host exposes a GPU, so on a headless CI box the probe still comes back empty and the
 * arm skips — which is the honest outcome, not a failure. The adapter's own identity goes in the receipt, because a
 * software adapter and a discrete GPU are different arms wearing the same name.
 */
const WEBGPU_LAUNCH_ARGS = ["--enable-unsafe-webgpu"] as const

/**
 * The candidate-table probe. `WOFCandidateTableLookup` issues this shape per resolve — a contiguous probe on the
 * `WITHOUT ROWID` B-tree keyed by `name_key` — and the range-fetch count is a property of that access pattern, not of
 * the SELECT list.
 */
const CANDIDATE_PROBE_SQL =
	"SELECT spr_id, name, country_id, placetype_id, latitude, longitude, neg_rank, is_primary, population " +
	`FROM candidate WHERE name_key = ? ORDER BY neg_rank ASC LIMIT ${CANDIDATE_PROBE_LIMIT}`

// MARK: Checks

/**
 * Artifact-conditional exactly like `weights.test.ts`: a checkout without the dev weights, or without Playwright's
 * browser, skips this suite rather than failing it.
 */
const requireFromHere = createRequire(import.meta.url)

async function tryResolveWeights(): Promise<ResolvedWeights | null> {
	try {
		return await resolveWeights({ locale: "en-us" })
	} catch {
		return null
	}
}

/**
 * Ask a package where one of its files lives. Never assemble a path into another package's install directory by hand —
 * the layout is its owner's to change.
 */
async function tryResolveFile(specifier: string): Promise<string | null> {
	try {
		const resolved = requireFromHere.resolve(specifier)

		return (await pathExists(resolved)) ? resolved : null
	} catch {
		return null
	}
}

async function tryChromiumExecutable(): Promise<string | null> {
	try {
		const executable = chromium.executablePath()

		return (await pathExists(executable)) ? executable : null
	} catch {
		return null
	}
}

const weights = await tryResolveWeights()
const haveModel = weights !== null && (await pathExists(weights.modelPath)) && (await pathExists(weights.tokenizerPath))
const haveBrowser = (await tryChromiumExecutable()) !== null

/**
 * A LOCATOR for the onnxruntime-web asset directory, not the file the runtime will fetch: ORT picks its own `.wasm`
 * variant at load time, and the whole directory is mounted at `/ort/` so whichever it asks for is served and counted.
 */
const ORT_DIST_LOCATOR = await tryResolveFile("onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm")

const SQLJS_ENTRY_FILE = await tryResolveFile("sql.js-httpvfs/dist/index.js")
const CANDIDATE_DB_PATH = String(dataRootPath("wof", "candidate.db"))

const haveGazetteer = SQLJS_ENTRY_FILE !== null && (await pathExists(CANDIDATE_DB_PATH))
const canRun = haveModel && haveBrowser && ORT_DIST_LOCATOR !== null

/**
 * Directory the browser entry is resolved from — the repo root, so `@mailwoman/neural/*` and `onnxruntime-web` both
 * resolve through the workspace's own module graph.
 */
const BUNDLE_RESOLVE_DIR = String(repoRootPath())

// MARK: Static asset server

/**
 * The class a served response is counted against. Byte accounting happens on the SERVER rather than in the browser: the
 * server sees exactly what left the socket, encoding included, and cannot be fooled by a cache hit.
 */
type AssetClass = "model" | "tokenizer" | "ortWasm" | "sqliteRuntime" | "runtimeJS" | "evidence" | "gazetteerRanges"

const ASSET_CLASSES = [
	"model",
	"tokenizer",
	"ortWasm",
	"sqliteRuntime",
	"runtimeJS",
	"evidence",
	"gazetteerRanges",
] as const satisfies readonly AssetClass[]

interface ClassTally {
	requests: number
	rawBytes: number
	wireBytes: number
}

type Tally = Record<AssetClass, ClassTally>

interface DirectoryMount {
	readonly prefix: string
	readonly directory: string
	readonly classify: (fileName: string) => AssetClass
}

interface InlineRoute {
	readonly body: Buffer
	readonly contentType: string
	readonly assetClass: AssetClass
}

interface RangeMount {
	readonly path: string
	readonly file: string
	readonly assetClass: AssetClass
}

interface AssetServer extends AsyncDisposable {
	readonly origin: string
	snapshot(): Tally
}

const HTTP_OK = 200
const HTTP_PARTIAL_CONTENT = 206
const HTTP_NOT_FOUND = 404
const HTTP_RANGE_NOT_SATISFIABLE = 416

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".map": "application/json; charset=utf-8",
}

/**
 * Extensions worth compressing. `.onnx`, `.model` and `.bin` are already entropy-dense — the live demo serves them
 * identity-encoded too, which is why the baseline's model figure equals the file size on disk.
 */
const COMPRESSIBLE_EXTENSIONS = new Set([".html", ".js", ".mjs", ".json", ".wasm", ".map"])

function emptyTally(): Tally {
	const entries = ASSET_CLASSES.map((name) => [name, { requests: 0, rawBytes: 0, wireBytes: 0 }] as const)

	return Object.fromEntries(entries) as Tally
}

function contentTypeFor(filePath: string): string {
	return CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream"
}

/**
 * Resolve `requestPath` under `directory`, refusing anything that escapes it.
 */
function safeJoin(directory: string, requestPath: string): string | null {
	const relative = normalize(requestPath).replace(/^(?:\.\.[/\\])+/u, "")
	const candidate = resolveFilePath(directory, relative)

	return candidate === directory || candidate.startsWith(directory + sep) ? candidate : null
}

interface RangeSpec {
	readonly start: number
	readonly end: number
}

/**
 * Parse a single-range `Range: bytes=a-b` header. Multi-range is deliberately unimplemented — sql.js-httpvfs never asks
 * for one, and half-answering a shape we do not serve would corrupt the measurement instead of failing it.
 */
function parseRange(header: string | undefined, size: number): RangeSpec | null {
	if (!header) return null
	const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())

	if (!match) return null
	const rawStart = match[1] ?? ""
	const rawEnd = match[2] ?? ""

	if (rawStart === "" && rawEnd === "") return null

	if (rawStart === "") {
		return { start: Math.max(0, size - Number(rawEnd)), end: size - 1 }
	}

	const start = Number(rawStart)
	const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1)

	return start > end || start >= size ? null : { start, end }
}

async function createAssetServer(
	inlineRoutes: ReadonlyMap<string, InlineRoute>,
	mounts: readonly DirectoryMount[],
	rangeMount: RangeMount | null
): Promise<AssetServer> {
	const tally = emptyTally()
	const gzipCache = new Map<string, Buffer>()

	const record = (assetClass: AssetClass, rawBytes: number, wireBytes: number): void => {
		const entry = tally[assetClass]
		entry.requests += 1
		entry.rawBytes += rawBytes
		entry.wireBytes += wireBytes
	}

	const sendBuffer = (
		req: IncomingMessage,
		res: ServerResponse,
		key: string,
		body: Buffer,
		contentType: string,
		assetClass: AssetClass,
		compressible: boolean
	): void => {
		const wantsGzip = String(req.headers["accept-encoding"] ?? "").includes("gzip")
		const useGzip = compressible && wantsGzip
		let payload = body

		if (useGzip) {
			const cached = gzipCache.get(key) ?? gzipSync(body)
			gzipCache.set(key, cached)
			payload = cached
		}

		record(assetClass, body.byteLength, payload.byteLength)

		res.writeHead(HTTP_OK, {
			"Content-Type": contentType,
			"Content-Length": String(payload.byteLength),
			"Accept-Ranges": "bytes",
			...(useGzip ? { "Content-Encoding": "gzip" } : {}),
		})

		res.end(req.method === "HEAD" ? undefined : payload)
	}

	const serveRange = async (req: IncomingMessage, res: ServerResponse, mount: RangeMount): Promise<void> => {
		const size = (await statPath(mount.file)).size

		if (req.method === "HEAD") {
			res.writeHead(HTTP_OK, { "Content-Length": String(size), "Accept-Ranges": "bytes" })
			res.end()

			return
		}

		const range = parseRange(req.headers.range, size)

		if (!range) {
			// A whole-file GET of a multi-gigabyte gazetteer is never what the VFS wants, and answering
			// one would hide the very thing under measurement.
			res.writeHead(HTTP_RANGE_NOT_SATISFIABLE, { "Content-Range": `bytes */${size}` })
			res.end()

			return
		}

		const length = range.end - range.start + 1
		record(mount.assetClass, length, length)

		res.writeHead(HTTP_PARTIAL_CONTENT, {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(length),
			"Content-Range": `bytes ${range.start}-${range.end}/${size}`,
			"Accept-Ranges": "bytes",
		})

		openReadStream(mount.file, { start: range.start, end: range.end }).pipe(res)
	}

	const serveMount = async (
		req: IncomingMessage,
		res: ServerResponse,
		mount: DirectoryMount,
		requestPath: string
	): Promise<boolean> => {
		const filePath = safeJoin(mount.directory, requestPath.slice(mount.prefix.length))

		if (!filePath || !(await pathExists(filePath))) return false
		const stats = await statPath(filePath)

		if (!stats.isFile()) return false
		const compressible = COMPRESSIBLE_EXTENSIONS.has(extname(filePath))
		const assetClass = mount.classify(basename(filePath))

		sendBuffer(
			req,
			res,
			requestPath,
			await readLocalBuffer(filePath),
			contentTypeFor(filePath),
			assetClass,
			compressible
		)

		return true
	}

	const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const requestPath = (req.url ?? "/").split("?")[0] ?? "/"
		const inline = inlineRoutes.get(requestPath)

		if (inline) {
			sendBuffer(req, res, requestPath, inline.body, inline.contentType, inline.assetClass, true)

			return
		}

		if (rangeMount && requestPath === rangeMount.path) {
			await serveRange(req, res, rangeMount)

			return
		}

		for (const mount of mounts) {
			if (!requestPath.startsWith(mount.prefix)) continue

			if (await serveMount(req, res, mount, requestPath)) return

			break
		}

		res.writeHead(HTTP_NOT_FOUND)
		res.end("not found")
	}

	const server: Server = createServer(handler)

	return new Promise<AssetServer>((ready) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			const port = typeof address === "object" && address ? address.port : 0

			ready({
				origin: `http://127.0.0.1:${port}`,
				snapshot: () => structuredClone(tally),
				[Symbol.asyncDispose]: async () => {
					server.closeAllConnections()
					await server[Symbol.asyncDispose]()
				},
			})
		})
	})
}

// MARK: Browser entry

/**
 * The page-side API `/app.js` installs on `globalThis`. The bundle is built with esbuild from the package's compiled
 * `out/` tree — the artifacts an npm consumer bundles — and served as `/app.js`, which is the `runtimeJS` class.
 * Declared here so every `page.evaluate` callback below is type-checked against the same contract the entry source
 * implements.
 */
interface BrowserSLOAPI {
	download(
		urls: readonly string[]
	): Promise<{ perURL: Array<{ url: string; bytes: number; ms: number }>; totalMs: number }>
	initRunner(options: {
		modelURL: string
		tokenizerURL: string
		useWebGPU: boolean
	}): Promise<{ backend: string | null; tokenizerMs: number; sessionMs: number; totalMs: number }>
	warm(texts: readonly string[], iterations: number, warmupIterations: number): Promise<number[]>
	probeWebGPU(): Promise<{ exposed: boolean; adapter: boolean; info: string }>
	heapSupported(): boolean
	peakHeapBytes(): number
}

/**
 * One open sql.js-httpvfs database, as its UMD hands it back.
 */
interface HTTPVFSHandle {
	db: {
		exec(sql: string): Promise<unknown>
		query(sql: string, params: unknown[]): Promise<unknown[]>
	}
}

declare global {
	/**
	 * The page-side API `/app.js` installs. Declared on the global rather than reached through a cast at each call site,
	 * because every `page.evaluate` callback is serialized into the browser and can close over nothing from this file.
	 */
	// oxlint-disable-next-line no-var -- `declare global` adds a globalThis property only through `var`.
	var mwSLO: BrowserSLOAPI

	/**
	 * The sql.js-httpvfs UMD's own entry point. The lowercase `b` in `Db` is that library's export name, not ours.
	 */
	// oxlint-disable-next-line no-var -- see above.
	var createDbWorker: (
		configs: ReadonlyArray<Record<string, unknown>>,
		workerURL: string,
		wasmURL: string
	) => Promise<HTTPVFSHandle>
}

const BROWSER_ENTRY_SOURCE = [
	'import * as ort from "onnxruntime-web/webgpu"',
	'import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"',
	'import { WebONNXRunner } from "@mailwoman/neural/web-onnx-runner"',
	"",
	"// Pinned so the warm number names one arm. Without cross-origin isolation ORT would settle on a",
	"// single thread anyway; stating it removes the dependence on that inference.",
	"ort.env.wasm.numThreads = 1",
	'ort.env.wasm.wasmPaths = "/ort/"',
	"",
	"const HEAP_SAMPLE_INTERVAL_MS = 50",
	"const bytesByURL = new Map()",
	"let tokenizer = null",
	"let runner = null",
	"let peakHeapBytes = 0",
	"",
	"function sampleHeap() {",
	"	const memory = performance.memory",
	"	if (memory) peakHeapBytes = Math.max(peakHeapBytes, memory.usedJSHeapSize)",
	"}",
	"",
	"setInterval(sampleHeap, HEAP_SAMPLE_INTERVAL_MS)",
	"",
	"async function download(urls) {",
	"	const perURL = []",
	"	const started = performance.now()",
	"	for (const url of urls) {",
	"		const t0 = performance.now()",
	"		const response = await fetch(url)",
	"		if (!response.ok) throw new Error(url + ' -> ' + response.status)",
	"		const bytes = new Uint8Array(await response.arrayBuffer())",
	"		bytesByURL.set(url, bytes)",
	"		perURL.push({ url, bytes: bytes.byteLength, ms: performance.now() - t0 })",
	"	}",
	"	sampleHeap()",
	"	return { perURL, totalMs: performance.now() - started }",
	"}",
	"",
	"async function initRunner(options) {",
	"	const modelBytes = bytesByURL.get(options.modelURL)",
	"	const tokenizerBytes = bytesByURL.get(options.tokenizerURL)",
	"	if (!modelBytes || !tokenizerBytes) throw new Error('initRunner called before download()')",
	"	const t0 = performance.now()",
	"	tokenizer = await MailwomanTokenizer.loadFromBytes(tokenizerBytes)",
	"	const tokenizerReady = performance.now()",
	"	const nextRunner = await WebONNXRunner.fromBytes(modelBytes, {",
	"		useWebGPU: options.useWebGPU,",
	'		wasmPathsRoot: "/ort/",',
	"	})",
	"	// The session is built lazily; this forces it, which is the cost the number is about.",
	"	await nextRunner.infer([0])",
	"	const done = performance.now()",
	"	runner = nextRunner",
	"	sampleHeap()",
	"	return {",
	"		backend: nextRunner.diagnostics ? nextRunner.diagnostics.backend : null,",
	"		tokenizerMs: tokenizerReady - t0,",
	"		sessionMs: done - tokenizerReady,",
	"		totalMs: done - t0,",
	"	}",
	"}",
	"",
	"async function warm(texts, iterations, warmupIterations) {",
	"	if (!tokenizer || !runner) throw new Error('warm() called before initRunner()')",
	"	const durations = []",
	"	for (let i = 0; i < warmupIterations + iterations; i++) {",
	"		const text = texts[i % texts.length]",
	"		const t0 = performance.now()",
	"		const encoded = tokenizer.encode(text)",
	"		await runner.infer(encoded.ids)",
	"		const elapsed = performance.now() - t0",
	"		if (i >= warmupIterations) durations.push(elapsed)",
	"	}",
	"	sampleHeap()",
	"	return durations",
	"}",
	"",
	"async function probeWebGPU() {",
	'	if (!("gpu" in navigator)) return { exposed: false, adapter: false, info: "" }',
	"	try {",
	"		const adapter = await navigator.gpu.requestAdapter()",
	'		if (!adapter) return { exposed: true, adapter: false, info: "" }',
	"		const info = adapter.info || {}",
	"		// The adapter's identity belongs in the receipt: a software adapter and a discrete GPU are",
	"		// not the same arm, and the number alone cannot tell them apart.",
	'		const described = [info.vendor, info.architecture, info.description].filter(Boolean).join(" ")',
	'		return { exposed: true, adapter: true, info: described || "unnamed adapter" }',
	"	} catch {",
	'		return { exposed: true, adapter: false, info: "" }',
	"	}",
	"}",
	"",
	"globalThis.mwSLO = {",
	"	download,",
	"	initRunner,",
	"	warm,",
	"	probeWebGPU,",
	"	heapSupported: () => !!performance.memory,",
	"	peakHeapBytes: () => {",
	"		sampleHeap()",
	"		return peakHeapBytes",
	"	},",
	"}",
].join("\n")

async function bundleBrowserEntry(resolveDir: string): Promise<Buffer> {
	const result = await build({
		stdin: { contents: BROWSER_ENTRY_SOURCE, resolveDir, sourcefile: "browser-slo-entry.ts", loader: "ts" },
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		minify: true,
		write: false,
		logLevel: "silent",
		// Both are dynamic imports behind a node-environment guard; the browser never evaluates them.
		external: ["node:fs/promises", "node:module"],
	})

	const output = result.outputFiles[0]

	if (!output) throw new Error("esbuild produced no output for the browser SLO entry")

	return Buffer.from(output.contents)
}

// MARK: The measurement.

interface ArmInit {
	readonly backend: string | null
	readonly tokenizerMs: number
	readonly sessionMs: number
	readonly totalMs: number
}

interface WarmStats {
	readonly p50: number
	readonly p95: number
	readonly samples: number
}

interface GazetteerMeasurement {
	readonly openMs: number
	readonly probeMs: number
	readonly requests: number
	readonly bytes: number
	readonly rows: readonly number[]
}

interface Measurement {
	readonly device: string
	readonly browser: string
	readonly modelFile: string
	readonly weightsSource: string
	readonly download: Tally
	readonly downloadMs: number
	readonly wasmInit: ArmInit
	readonly webgpu: { readonly exposed: boolean; readonly adapter: string; readonly init: ArmInit | null }
	readonly wasmWarm: WarmStats
	readonly gazetteer: GazetteerMeasurement | null
	readonly peakHeapBytes: number
	readonly heapSupported: boolean
	readonly pageErrors: readonly string[]
}

const BYTES_PER_MEBIBYTE = 1_048_576
const BYTES_PER_GIBIBYTE = 1_073_741_824

const INDEX_HTML =
	'<!doctype html><meta charset="utf-8"><title>mailwoman browser SLO</title><script type="module" src="/app.js"></script>'

const GAZETTEER_HTML =
	'<!doctype html><meta charset="utf-8"><title>mailwoman gazetteer probe</title><script src="/sqljs/index.js"></script>'

const MODEL_FILENAME = "model.onnx"
const TOKENIZER_FILENAME = "tokenizer.model"

function statsOf(durations: readonly number[]): WarmStats {
	const p50 = median(durations) ?? Number.NaN
	const p95 = percentile(durations, 95) ?? Number.NaN

	return { p50, p95, samples: durations.length }
}

function describeDevice(): string {
	const model = cpuModel()
	const memory = (totalMemoryBytes() / BYTES_PER_GIBIBYTE).toFixed(0)

	return `${model} × ${cpuCount()} · ${memory} GiB · ${platformName()}/${architecture()}`
}

/**
 * The weights directory doubles as the model, tokenizer and evidence source, so the class a file belongs to is decided
 * by its name rather than by its mount.
 */
function classifyWeightsFile(fileName: string): AssetClass {
	if (fileName === MODEL_FILENAME) return "model"

	if (fileName === TOKENIZER_FILENAME) return "tokenizer"

	return "evidence"
}

async function measure(resolved: ResolvedWeights, ortDistLocator: string): Promise<Measurement> {
	const weightsDirectory = dirname(resolved.modelPath)
	const appBundle = await bundleBrowserEntry(BUNDLE_RESOLVE_DIR)

	const inlineRoutes = new Map<string, InlineRoute>([
		["/", { body: Buffer.from(INDEX_HTML), contentType: "text/html; charset=utf-8", assetClass: "runtimeJS" }],
		[
			"/gazetteer.html",
			{ body: Buffer.from(GAZETTEER_HTML), contentType: "text/html; charset=utf-8", assetClass: "sqliteRuntime" },
		],
		["/app.js", { body: appBundle, contentType: "text/javascript; charset=utf-8", assetClass: "runtimeJS" }],
	])

	const mounts: DirectoryMount[] = [
		{ prefix: "/ort/", directory: dirname(ortDistLocator), classify: () => "ortWasm" },
		{ prefix: "/weights/", directory: weightsDirectory, classify: classifyWeightsFile },
	]

	if (SQLJS_ENTRY_FILE) {
		mounts.push({ prefix: "/sqljs/", directory: dirname(SQLJS_ENTRY_FILE), classify: () => "sqliteRuntime" })
	}

	const rangeMount: RangeMount | null = haveGazetteer
		? { path: "/gazetteer/candidate.db", file: CANDIDATE_DB_PATH, assetClass: "gazetteerRanges" }
		: null

	// Declared server-first so disposal runs browser-first: the pages have to be gone before the origin they were
	// fetching from stops answering.
	await using server = await createAssetServer(inlineRoutes, mounts, rangeMount)
	await using browser: Browser = await chromium.launch({ args: [...WEBGPU_LAUNCH_ARGS] })
	const pageErrors: string[] = []

	const page = await browser.newPage()
	page.on("pageerror", (error) => pageErrors.push(String(error)))

	page.on("console", (message) => {
		// ORT writes its own WARNINGS to the WASM stderr, which reaches the page as a console error
		// (`VerifyEachNodeIsAssignedToAnEp` fires on every session). Reporting those as page errors
		// trains the reader to ignore the channel, and then a real one goes unread.
		if (message.type() === "error" && !message.text().includes("W:onnxruntime")) {
			pageErrors.push(message.text())
		}
	})

	await page.goto(`${server.origin}/`)
	await page.waitForFunction(() => "mwSLO" in globalThis)

	const modelURL = `${server.origin}/weights/${MODEL_FILENAME}`
	const tokenizerURL = `${server.origin}/weights/${TOKENIZER_FILENAME}`
	const evidenceURLs = await evidenceURLsFor(resolved, weightsDirectory, server.origin)

	const downloadResult = await page.evaluate(
		(urls) => globalThis.mwSLO.download(urls),
		[modelURL, tokenizerURL, ...evidenceURLs]
	)

	const wasmInit = await page.evaluate((options) => globalThis.mwSLO.initRunner(options), {
		modelURL,
		tokenizerURL,
		useWebGPU: false,
	})

	const wasmDurations = await page.evaluate((args) => globalThis.mwSLO.warm(args.texts, args.iterations, args.warmup), {
		texts: [...WARM_INPUTS],
		iterations: WARM_ITERATIONS,
		warmup: WARM_WARMUP_ITERATIONS,
	})

	const gazetteer = rangeMount ? await measureGazetteer(browser, server, rangeMount.path) : null

	// The byte table is snapshotted HERE, not after the explicit fetches: onnxruntime-web pulls its
	// `.wasm` during session creation and sql.js-httpvfs pulls its worker + wasm when the gazetteer
	// page opens, so an earlier snapshot reports both classes as ZERO — which reads as "this
	// session downloads no WASM" rather than "the snapshot was early". Everything after this line
	// is deliberately excluded: a second session on the WebGPU arm re-fetches artifacts a cold user
	// session pays for once.
	const download = server.snapshot()
	const webgpuProbe = await page.evaluate(() => globalThis.mwSLO.probeWebGPU())
	let webgpuInit: ArmInit | null = null

	if (webgpuProbe.adapter) {
		const attempt = await page.evaluate((options) => globalThis.mwSLO.initRunner(options), {
			modelURL,
			tokenizerURL,
			useWebGPU: true,
		})

		// `WebONNXRunner` falls back to WASM silently when the WebGPU session fails to build, so the
		// arm is only real if the diagnostics say so.
		webgpuInit = attempt.backend === "webgpu" ? attempt : null
	}

	const heapSupported = await page.evaluate(() => globalThis.mwSLO.heapSupported())
	const peakHeapBytes = await page.evaluate(() => globalThis.mwSLO.peakHeapBytes())

	return {
		device: describeDevice(),
		browser: `Chromium ${browser.version()}`,
		modelFile: `${basename(await realPath(resolved.modelPath))} (${(await statPath(resolved.modelPath)).size} B)`,
		weightsSource: resolved.source,
		download,
		downloadMs: downloadResult.totalMs,
		wasmInit,
		webgpu: { exposed: webgpuProbe.exposed, adapter: webgpuProbe.info, init: webgpuInit },
		wasmWarm: statsOf(wasmDurations),
		gazetteer,
		peakHeapBytes,
		heapSupported,
		pageErrors,
	}
}

/**
 * URLs for every evidence artifact the shipped web loader fetches beside the model — skipping the ones this weights
 * package does not ship, since an overlay's absence is a packaging fact, not a failure.
 */
async function evidenceURLsFor(resolved: ResolvedWeights, weightsDirectory: string, origin: string): Promise<string[]> {
	const candidates = [
		resolved.modelCardPath,
		resolved.gazetteerLexiconPath,
		resolved.countryLexiconPath,
		resolved.streetTypeLexiconPath,
		resolved.localitySurfaceLexiconPath,
		resolved.anchorLookupPath?.path,
		resolved.pairIndexPath,
	]

	const present: string[] = []

	for (const path of candidates) {
		if (typeof path === "string" && (await pathExists(path))) {
			present.push(path)
		}
	}

	return present.map((path) => `${origin}/weights/${path.slice(weightsDirectory.length + 1)}`)
}

async function measureGazetteer(browser: Browser, server: AssetServer, dbPath: string): Promise<GazetteerMeasurement> {
	await using page = await browser.newPage()

	await page.goto(`${server.origin}/gazetteer.html`)
	await page.waitForFunction(() => typeof globalThis.createDbWorker === "function")
	const before = server.snapshot().gazetteerRanges

	const result = await page.evaluate(
		async (args) => {
			const config = { serverMode: "full", url: args.dbURL, requestChunkSize: args.chunkSize }
			const startedAt = performance.now()

			const opened = await globalThis.createDbWorker([{ from: "inline", config }], args.workerURL, args.wasmURL)

			// Forces the header + schema pages through SQLite, so "open" covers the whole cost of
			// getting to a queryable database: the worker, its wasm, and the first range fetches.
			await opened.db.exec("SELECT count(*) FROM sqlite_master")
			const readyAt = performance.now()
			const rows: number[] = []

			for (const key of args.keys) {
				rows.push((await opened.db.query(args.sql, [key])).length)
			}

			return { openMs: readyAt - startedAt, probeMs: performance.now() - readyAt, rows }
		},
		{
			dbURL: `${server.origin}${dbPath}`,
			workerURL: `${server.origin}/sqljs/sqlite.worker.js`,
			wasmURL: `${server.origin}/sqljs/sql-wasm.wasm`,
			chunkSize: HTTPVFS_CHUNK_SIZE,
			keys: [...CANDIDATE_PROBE_KEYS],
			sql: CANDIDATE_PROBE_SQL,
		}
	)

	const after = server.snapshot().gazetteerRanges

	return {
		openMs: result.openMs,
		probeMs: result.probeMs,
		requests: after.requests - before.requests,
		bytes: after.rawBytes - before.rawBytes,
		rows: result.rows,
	}
}

// MARK: Receipt.

const numberFormat = new Intl.NumberFormat("en-US")

function bytesColumn(entry: ClassTally): string {
	return `${numberFormat.format(entry.rawBytes)} raw / ${numberFormat.format(entry.wireBytes)} wire`
}

function byteRow(label: string, entry: ClassTally, budget: number): string {
	return `      ${label.padEnd(16)} ${bytesColumn(entry)}   budget ${numberFormat.format(budget)}`
}

function initRow(label: string, arm: ArmInit, budget: number): string {
	const parts = `tokenizer ${arm.tokenizerMs.toFixed(0)} ms + session ${arm.sessionMs.toFixed(0)} ms`

	return `      ${label.padEnd(16)} ${parts} = ${arm.totalMs.toFixed(0)} ms   budget ${budget} ms`
}

function gazetteerRows(gazetteer: GazetteerMeasurement | null): string[] {
	if (!gazetteer) return ["      NOT MEASURED — candidate.db or the sql.js-httpvfs runtime is absent"]
	const mebibytes = (gazetteer.bytes / BYTES_PER_MEBIBYTE).toFixed(2)

	return [
		`      ${gazetteer.requests} range requests / ${mebibytes} MiB   budget ${GAZETTEER_RANGE_REQUESTS_BUDGET} requests`,
		`      open ${gazetteer.openMs.toFixed(0)} ms · ${gazetteer.rows.length} probes ${gazetteer.probeMs.toFixed(0)} ms · rows ${gazetteer.rows.join("/")}`,
		"      loopback latency is a floor on the wire cost, not a WAN estimate — the COUNT is the durable number",
	]
}

function webgpuRows(webgpu: Measurement["webgpu"]): string[] {
	if (webgpu.init) {
		return [
			initRow("webgpu arm", webgpu.init, INIT_WEBGPU_MS_BUDGET),
			`      ${" ".repeat(16)} adapter: ${webgpu.adapter}`,
		]
	}

	const why = webgpu.exposed ? "no adapter granted" : "navigator.gpu not exposed by this browser"

	return [`      ${"webgpu arm".padEnd(16)} NOT MEASURED — ${why}; the budget is not asserted`]
}

function formatReceipt(m: Measurement): string {
	const heapMiB = (m.peakHeapBytes / BYTES_PER_MEBIBYTE).toFixed(0)
	const heapBudgetMiB = (PEAK_HEAP_BYTES_BUDGET / BYTES_PER_MEBIBYTE).toFixed(0)
	const heapNote = m.heapSupported ? "" : " (performance.memory unavailable — reported 0)"

	return [
		"",
		"  #378 browser SLO — decomposed cold path",
		`  device        : ${m.device}`,
		`  browser       : ${m.browser} (playwright, headless)`,
		`  model         : ${m.modelFile} · ${m.weightsSource}`,
		"",
		`  1 cold download bytes (${m.downloadMs.toFixed(0)} ms over loopback)`,
		byteRow("model", m.download.model, MODEL_RAW_BYTES_BUDGET),
		byteRow("tokenizer", m.download.tokenizer, TOKENIZER_RAW_BYTES_BUDGET),
		byteRow("ORT wasm", m.download.ortWasm, ORT_WASM_RAW_BYTES_BUDGET),
		byteRow("sqlite runtime", m.download.sqliteRuntime, SQLITE_RUNTIME_RAW_BYTES_BUDGET),
		byteRow("runtime JS", m.download.runtimeJS, RUNTIME_JS_RAW_BYTES_BUDGET),
		byteRow("evidence", m.download.evidence, EVIDENCE_RAW_BYTES_BUDGET),
		"",
		"  2 init (model bytes already in memory — no network in the number)",
		initRow("wasm arm", m.wasmInit, INIT_WASM_MS_BUDGET),
		...webgpuRows(m.webgpu),
		"",
		`  3 warm inference — wasm arm, 1 thread, ${m.wasmWarm.samples} parses over ${WARM_INPUTS.length} inputs (${WARM_LOWERCASE_INPUTS} lowercase)`,
		`      p50 ${m.wasmWarm.p50.toFixed(1)} ms   p95 ${m.wasmWarm.p95.toFixed(1)} ms   budget p50 ${WARM_P50_WASM_MS_BUDGET} / p95 ${WARM_P95_WASM_MS_BUDGET}`,
		"",
		"  4 resolve — candidate.db over sql.js-httpvfs",
		...gazetteerRows(m.gazetteer),
		"",
		`  5 peak JS heap    ${heapMiB} MiB   budget ${heapBudgetMiB} MiB${heapNote}`,
		"      JS heap only — V8 accounts the artifact ArrayBuffers and ORT's WASM memory outside it",
		"",
	].join("\n")
}

// MARK: Suite.

/**
 * The whole probe runs once: a browser launch plus a 39 MB model load per arm is not something to repeat per assertion.
 * Generous rather than a performance target.
 */
const PROBE_TIMEOUT_MS = 900_000

describe.skipIf(!canRun)("#378 browser SLO — decomposed cold path", () => {
	let measurement: Measurement

	beforeAll(async () => {
		measurement = await measure(weights!, ORT_DIST_LOCATOR!)

		console.log(formatReceipt(measurement))
	}, PROBE_TIMEOUT_MS)

	afterAll(() => {
		if (measurement?.pageErrors.length) {
			console.warn(`  page errors during the probe:\n    ${measurement.pageErrors.join("\n    ")}`)
		}
	})

	test("1 · cold download — ONNX model bytes", () => {
		expect(measurement.download.model.rawBytes).toBeGreaterThan(0)
		expect(measurement.download.model.rawBytes).toBeLessThanOrEqual(MODEL_RAW_BYTES_BUDGET)
	})

	test("1 · cold download — tokenizer bytes", () => {
		expect(measurement.download.tokenizer.rawBytes).toBeGreaterThan(0)
		expect(measurement.download.tokenizer.rawBytes).toBeLessThanOrEqual(TOKENIZER_RAW_BYTES_BUDGET)
	})

	test("1 · cold download — onnxruntime-web WASM bytes", () => {
		expect(measurement.download.ortWasm.rawBytes).toBeGreaterThan(0)
		expect(measurement.download.ortWasm.rawBytes).toBeLessThanOrEqual(ORT_WASM_RAW_BYTES_BUDGET)
	})

	test("1 · cold download — runtime JS bundle bytes", () => {
		expect(measurement.download.runtimeJS.rawBytes).toBeGreaterThan(0)
		expect(measurement.download.runtimeJS.rawBytes).toBeLessThanOrEqual(RUNTIME_JS_RAW_BYTES_BUDGET)
	})

	test("1 · cold download — evidence lexicons + retrieval binaries", () => {
		expect(measurement.download.evidence.rawBytes).toBeGreaterThan(0)
		expect(measurement.download.evidence.rawBytes).toBeLessThanOrEqual(EVIDENCE_RAW_BYTES_BUDGET)
	})

	test("1 · cold download — sql.js-httpvfs runtime bytes", (ctx) => {
		if (!haveGazetteer) {
			ctx.skip("the sql.js-httpvfs runtime is not installed")

			return
		}

		expect(measurement.download.sqliteRuntime.rawBytes).toBeGreaterThan(0)
		expect(measurement.download.sqliteRuntime.rawBytes).toBeLessThanOrEqual(SQLITE_RUNTIME_RAW_BYTES_BUDGET)
	})

	test("2 · init — wasm arm", () => {
		expect(measurement.wasmInit.backend).toBe("wasm")
		expect(measurement.wasmInit.totalMs).toBeLessThanOrEqual(INIT_WASM_MS_BUDGET)
	})

	test("2 · init — webgpu arm", (ctx) => {
		if (!measurement.webgpu.init) {
			ctx.skip(
				measurement.webgpu.exposed
					? "WebGPU is exposed but no adapter was granted"
					: "navigator.gpu is not exposed by this browser — headless Chromium on Linux does not ship it"
			)

			return
		}

		expect(measurement.webgpu.init.backend).toBe("webgpu")
		expect(measurement.webgpu.init.totalMs).toBeLessThanOrEqual(INIT_WEBGPU_MS_BUDGET)
	})

	test("3 · warm inference — wasm arm median", () => {
		expect(measurement.wasmWarm.samples).toBeGreaterThanOrEqual(WARM_ITERATIONS)
		expect(measurement.wasmWarm.p50).toBeLessThanOrEqual(WARM_P50_WASM_MS_BUDGET)
	})

	test("3 · warm inference — wasm arm p95", () => {
		expect(measurement.wasmWarm.p95).toBeLessThanOrEqual(WARM_P95_WASM_MS_BUDGET)
	})

	test("4 · resolve — candidate.db range-fetch count", (ctx) => {
		if (!measurement.gazetteer) {
			ctx.skip("candidate.db or the sql.js-httpvfs runtime is absent")

			return
		}

		// Every probe must have returned rows: a key that matches nothing still descends the B-tree, so
		// a zero-row session would be a cheaper measurement of a different thing.
		expect(measurement.gazetteer.rows.every((count) => count > 0)).toBe(true)
		expect(measurement.gazetteer.requests).toBeGreaterThan(0)
		expect(measurement.gazetteer.requests).toBeLessThanOrEqual(GAZETTEER_RANGE_REQUESTS_BUDGET)
	})

	test("5 · peak JS heap", (ctx) => {
		if (!measurement.heapSupported) {
			ctx.skip("performance.memory is unavailable in this browser")

			return
		}

		expect(measurement.peakHeapBytes).toBeGreaterThan(0)
		expect(measurement.peakHeapBytes).toBeLessThanOrEqual(PEAK_HEAP_BYTES_BUDGET)
	})
})
