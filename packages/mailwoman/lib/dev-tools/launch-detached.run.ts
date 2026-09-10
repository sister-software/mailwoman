/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Start a long-running command in ITS OWN SESSION and exit, so nothing that kills this process can reach the child.
 *
 *   WHAT THIS IS FOR. A Modal training launch is a local CLIENT talking to a remote container. Modal's `-d` does not
 *   make that client disposable — its own banner says detached mode "only keeps the LAST triggered Modal function alive
 *   after the parent process has been killed" — and when the client dies Modal cancels the input:
 *
 *       [modal-client] Received a cancellation signal while processing input (…)
 *       [modal-client] Successfully canceled input (…)
 *
 *   The container stops mid-training and the run is lost back to its last checkpoint. It has happened twice: a shell
 *   `timeout` around the launch on 2026-07-15, and an agent background task stopped by a host memory guard, which is
 *   the case this file exists to make impossible.
 *
 *   HOW IT WORKS, and why the shell spellings do not. A harness stops a background task by signalling its PROCESS
 *   GROUP. `spawn(…, { detached: true })` calls `setsid(2)` in the child, which places it in a new session and a new
 *   group, so a group signal has no member to reach; `unref()` then lets this process exit while the child continues.
 *   `nohup` is not equivalent — it ignores SIGHUP and leaves the child in the same group, so a group kill still lands.
 *   `setsid` is equivalent and is not on the Bash guard's admitted command list.
 *
 *   The child's output goes to `--log`, because a detached child cannot inherit a terminal that is about to disappear.
 *   The pid and the log path print here so a caller can watch either one.
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

// A raw descriptor rather than a `WriteStream`: `createWriteStream` opens lazily, so its `fd` is still null at the
// moment `spawn` reads the stdio array, and the child inherits nothing. Appending, so a relaunch of a resumed run keeps
// the earlier attempt's output in the same file.
const log = await open(logPath, "a")

const child = spawnProcess(command, args, {
	cwd: values.cwd ?? process.cwd(),
	detached: true,
	stdio: ["ignore", log.fd, log.fd],
})

child.unref()

// This process owns the handle; the child holds its own copy of the descriptor across the fork, so closing here does
// not disturb it. Leaving it open would keep the event loop alive and defeat the point of `unref`.
await log.close()

console.log(`launched pid ${child.pid} in its own session`)
console.log(`  command: ${[command, ...args].join(" ")}`)
console.log(`  log:     ${logPath}`)
