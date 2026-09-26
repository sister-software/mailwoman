/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Start a long-running command in its own session and exit, so no signal that kills this process can reach the
 *   child.
 *
 *   `spawn(…, { detached: true })` calls `setsid(2)`, placing the child in a new session and group, so a group
 *   signal has no member to reach; `unref()` then lets this process exit while the child continues.
 *
 *   `nohup` is not equivalent: it ignores SIGHUP and leaves the child in the same group, so a group kill still lands.
 *
 *   The child's output goes to `--log`, because a detached child cannot inherit a terminal that is about to
 *   disappear.
 *
 *   Run: node packages/mailwoman/lib/dev-tools/launch-detached.run.ts --log <file> -- <command> [arg ...]
 */

import { open } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { spawnProcess } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { dirname } from "path-ts"

const { values, positionals } = parseArguments({
	options: {
		log: { type: "string" },
		cwd: { type: "string" },
	},
	allowPositionals: true,
})

const logPath = values.log

if (!logPath) {
	throw new Error("--log <file> is required: a detached child has no terminal to inherit, so its output needs a file")
}

if (!positionals.length) {
	throw new Error("nothing to launch — put the command after `--`, e.g. `--log run.log -- modal run -d …`")
}

const [command, ...args] = positionals as [string, ...string[]]

await makeDirectories(dirname(logPath))

// A raw descriptor rather than a `WriteStream`, which opens lazily so its `fd` is still null
// when `spawn` reads the stdio array; appending keeps a relaunch's output in the same file.
const log = await open(logPath, "a")

const child = spawnProcess(command, args, {
	cwd: values.cwd ?? process.cwd(),
	detached: true,
	stdio: ["ignore", log.fd, log.fd],
})

child.unref()

// This process owns the handle; the child holds its own copy across the fork,
// and leaving it open would keep the event loop alive and defeat the point of `unref`.
await log.close()

console.log(`launched pid ${child.pid} in its own session`)
console.log(`  command: ${[command, ...args].join(" ")}`)
console.log(`  log:     ${logPath}`)
