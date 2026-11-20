// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Runs the OGC API Features Part 1 executable test suite, `ets-ogcapi-features10`,
 *   against `mailwoman-ogc serve` on this machine and prints the result.
 *
 *   Without `--iut` the tool starts the server on 127.0.0.1 with the data root's gazetteer,
 *   runs the suite, and stops the server it started by its own process.
 *   With `--iut` it tests that URL instead and leaves the server to the caller.
 *
 *   The suite runs from OGC's published container image under Podman.
 *   The container shares the host's network as a client and opens no port,
 *   so the server stays bound to 127.0.0.1.
 *
 *   The suite writes its TestNG and EARL reports under `--out`, and the tool prints
 *   the counts and every failed or skipped test with its message.
 *   It exits 1 when a test failed.
 *
 *   Run from the repository root:
 *
 *   ```sh
 *   node packages/ogc/tools/ets.run.ts [--port 8195] [--out <dir>] [--iut <url>] [--image <ref>]
 *   ```
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { statPath } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { fileURLToPath } from "@mailwoman/core/module/file-url"
import { ProcessTask, runProcess } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isoSeconds } from "@mailwoman/core/utils"
import { sleep } from "@mailwoman/core/utils/sleep"
import { PathBuilder } from "path-ts"

/**
 * The published image of suite revision 1.9, the newest release.
 */
const DEFAULT_IMAGE = "docker.io/ogccite/ets-ogcapi-features10:1.9-teamengine-6.0.0-RC2"

/**
 * The image's TEAM Engine web application holds the suite and its dependencies,
 * and Tomcat's library directory holds the JAX-RS client the suite loads.
 * The suite runs from both without Tomcat.
 */
const SUITE_CLASSPATH = "/usr/local/tomcat/webapps/teamengine/WEB-INF/lib/*:/usr/local/tomcat/lib/*"

const SUITE_MAIN = "org.opengis.cite.ogcapifeatures10.TestNGController"

/**
 * How long the server may take to load the classifier and gazetteer before the tool gives up.
 */
const SERVER_READY_TIMEOUT_MS = 300_000

/**
 * The interval between the tool's requests to the starting server.
 */
const SERVER_POLL_INTERVAL_MS = 1000

const { values } = parseArguments({
	options: {
		port: { type: "string", default: "8195" },
		out: { type: "string" },
		iut: { type: "string" },
		image: { type: "string", default: DEFAULT_IMAGE },
	},
})

const out = PathBuilder.from(
	values.out ?? dataRootPath("audits", "ogc-ets", isoSeconds().replaceAll(":", "")).toString()
)

await makeDirectories(out)

async function waitForServer(url: string, server: ProcessTask): Promise<void> {
	const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
	const state = { exited: false }

	void server.result.finally(() => {
		state.exited = true
	})

	while (Date.now() < deadline) {
		if (state.exited) throw new Error(`the server exited before answering ${url}`)

		try {
			if ((await fetch(url)).ok) return
		} catch {
			// The server isn't listening yet.
		}

		await sleep(SERVER_POLL_INTERVAL_MS)
	}

	throw new Error(`no answer from ${url} within ${SERVER_READY_TIMEOUT_MS} ms`)
}

/**
 * One failed or skipped test from the TestNG report.
 */
interface ReportedTest {
	status: "FAIL" | "SKIP"
	name: string
	description: string
	parameters: string[]
	message: string
}

interface SuiteSummary {
	iut: string
	image: string
	report: string
	total: number
	passed: number
	failed: number
	skipped: number
	tests: ReportedTest[]
}

function attribute(attributes: string, name: string): string {
	return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? ""
}

/**
 * Read the counts and the failed and skipped tests from a `testng-results.xml`.
 */
function summarizeReport(xml: string): Omit<SuiteSummary, "iut" | "image" | "report"> {
	const header = /<testng-results([^>]*)>/.exec(xml)?.[1]

	if (header == null) throw new Error("the report has no <testng-results> element")

	const tests: ReportedTest[] = []

	for (const match of xml.matchAll(/<test-method([^>]*)>([\s\S]*?)<\/test-method>/g)) {
		const attributes = match[1]!
		const status = attribute(attributes, "status")

		if (status !== "FAIL" && status !== "SKIP") continue

		const body = match[2]!

		tests.push({
			status,
			name: attribute(attributes, "name"),
			description: attribute(attributes, "description"),
			parameters: [...body.matchAll(/<value[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((value) => value[1]!.trim()),
			message: /<message>\s*<!\[CDATA\[([\s\S]*?)\]\]>/.exec(body)?.[1]?.trim() ?? "",
		})
	}

	return {
		total: Number(attribute(header, "total")),
		passed: Number(attribute(header, "passed")),
		failed: Number(attribute(header, "failed")),
		skipped: Number(attribute(header, "skipped")),
		tests,
	}
}

async function runSuite(iut: string): Promise<SuiteSummary> {
	await writeLocalTextFile(
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">
<properties version="1.0">
  <entry key="iut">${iut}</entry>
</properties>
`,
		out("test-run-props.xml")
	)

	const suite = await runProcess(
		"podman",
		[
			"run",
			"--rm",
			"--network=host",
			"-v",
			`${out}:/run:Z`,
			"--entrypoint",
			"java",
			values.image,
			"-cp",
			SUITE_CLASSPATH,
			SUITE_MAIN,
			"-o",
			"/run",
			"-h",
			"true",
			"/run/test-run-props.xml",
		],
		{ reject: false }
	)

	await writeLocalTextFile(`${suite.stdout}${suite.stderr}\nEXIT=${suite.exitCode}\n`, out("ets.log"))

	if (suite.exitCode !== 0) throw new Error(`the suite exited ${suite.exitCode}; see ${out("ets.log")}`)

	const reports = await Promise.all(
		(await sortedGlob(out, "testng/*/testng-results.xml")).map(async (path) => ({
			path,
			modified: (await statPath(path)).mtimeMs,
		}))
	)

	const newest = reports.toSorted((a, b) => b.modified - a.modified)[0]?.path

	if (!newest) throw new Error(`the suite wrote no testng-results.xml under ${out("testng")}`)

	return { iut, image: values.image, report: newest, ...summarizeReport(await readLocalTextFile(newest)) }
}

let summary: SuiteSummary

if (values.iut) {
	summary = await runSuite(values.iut)
} else {
	const iut = `http://127.0.0.1:${values.port}/`

	await using server = new ProcessTask(
		process.execPath,
		[fileURLToPath(import.meta.resolve("#cli/main")), "serve", "--host", "127.0.0.1", "--port", values.port],
		{ stdout: "ignore", stderr: "inherit", reject: false }
	)

	await waitForServer(`${iut}conformance`, server)

	summary = await runSuite(iut)
}

await writeLocalJSONFile(summary, out("summary.json"))

console.log(`ets-ogcapi-features10 (${summary.image}) against ${summary.iut}`)
console.log(`total ${summary.total}, passed ${summary.passed}, failed ${summary.failed}, skipped ${summary.skipped}`)
console.log(`report: ${summary.report}`)

for (const test of summary.tests) {
	const parameters = test.parameters.length
		? ` [${test.parameters.map((value) => value.slice(0, 80)).join(" | ")}]`
		: ""

	console.log(`\n${test.status} ${test.name}${parameters}\n  ${test.description}\n  ${test.message.slice(0, 500)}`)
}

if (summary.failed > 0) {
	process.exitCode = 1
}
