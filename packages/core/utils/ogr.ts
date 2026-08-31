/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One ogr2ogr harness for every streaming extraction.
 */

import { TextSpliterator } from "spliterator"

import { tryParsingJSON } from "#objects"
import { spawnProcess } from "#process"

const RECORD_SEPARATOR = 0x1e
const STDERR_TAIL_CHARS = 800

export interface OGRProcess {
	stdout: NodeJS.ReadableStream
	/**
	 * Resolves on a clean exit; rejects with the exit code and the stderr tail otherwise. A truncated stream reads as a
	 * short but well-formed feature list, which is exactly the partial result that must throw rather than be reported as
	 * a smaller extract — so consume the stream fully, then await this.
	 */
	settled: Promise<void>
	/**
	 * Stop the child if it is still running — the `finally` companion for a consumer that throws mid-stream.
	 */
	kill: () => void
}

/**
 * Spawn `ogr2ogr` with stderr accumulated for the failure message. The caller owns the stdout format (GeoJSONSeq, CSV,
 * …) and its parsing; {@link ogr2ogrGeoJSONSeq} is the GeoJSONSeq reading over this.
 */
export function spawnOGR2OGR(args: readonly string[], context: string): OGRProcess {
	const child = spawnProcess("ogr2ogr", [...args], { stdio: ["ignore", "pipe", "pipe"] })
	let stderr = ""

	child.stderr.setEncoding("utf8")

	child.stderr.on("data", (chunk: string) => {
		stderr += chunk
	})

	const settled = new Promise<void>((resolve, reject) => {
		child.on("error", reject)

		child.on("close", (code) => {
			if (code === 0) {
				resolve()
			} else {
				reject(new Error(`${context}: ogr2ogr exited ${code}: ${stderr.slice(-STDERR_TAIL_CHARS)}`))
			}
		})
	})

	// A failed spawn rejects `settled` BEFORE any consumer awaits it — the consumer is still draining the stream on a
	// later tick, and a consumer that abandons the stream never awaits it at all — so an unobserved rejection would trip
	// the process's unhandled-rejection hook. Observed at birth instead; every consumer still awaits the real verdict.
	settled.catch(() => undefined)

	return {
		stdout: child.stdout,
		settled,
		kill: () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill()
			}
		},
	}
}

/**
 * Stream a GeoJSONSeq extraction as parsed features.
 *
 * Strips the RFC-8142 record separator (U+001E) GDAL MAY prefix records with — `.trim()` does not remove it (not
 * whitespace), so an RS-framed record would fail to parse and be silently skipped, all of them, and an empty extract
 * would read as a real absence. A malformed record is tolerated (skipped) rather than thrown; a non-zero exit throws
 * after the stream drains.
 */
export async function* ogr2ogrGeoJSONSeq<T>(args: readonly string[], context: string): AsyncGenerator<T> {
	const proc = spawnOGR2OGR(args, context)

	try {
		for await (const raw of TextSpliterator.fromAsync(proc.stdout)) {
			const line = (raw.charCodeAt(0) === RECORD_SEPARATOR ? raw.slice(1) : raw).trim()

			if (!line) continue

			const feature = tryParsingJSON<T>(line)

			if (feature !== null) {
				yield feature
			}
		}
	} finally {
		proc.kill()
	}

	await proc.settled
}
