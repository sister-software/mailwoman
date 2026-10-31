/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The test renders the progress feed in a subprocess against real Ink. Ink writes its final frame at unmount.
 *   It strips ANSI codes before matching stdout.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { expect, test } from "vitest"

import { stripAnsi } from "#cli-kit"

const HARNESS = `
	import { createElement as h, useEffect } from "react"
	import { render } from "ink"
	import { TypedEventTarget } from "@mailwoman/core/utils/events"
	import { ProgressLines, useProgressFeed } from "mailwoman/cli/kit"

	class Source extends TypedEventTarget {
		step(command, stage, percent) {
			this.emit("progress", { command, stage, percent, processed: percent / 10, total: 10 })
		}
	}

	const source = new Source()

	function View() {
		const feed = useProgressFeed()

		useEffect(() => feed.watch(source), [])

		return h(ProgressLines, { entries: feed.entries })
	}

	const app = render(h(View))

	setTimeout(() => {
		source.step("git clone a", "Receiving objects", 20)
		source.step("git clone a", "Receiving objects", 50)
		source.step("git clone b", "Resolving deltas", 100)
		setTimeout(() => app.unmount(), 50)
	}, 50)
`

test("renders the latest step per command", async () => {
	const { stdout } = await runFile(process.execPath, ["--input-type=module", "-e", HARNESS], {
		cwd: repoRootPath(),
		env: childEnv(),
	})

	const text = stripAnsi(stdout)

	expect(text).toContain("git clone a: Receiving objects 50% (5/10)")
	expect(text).toContain("git clone b: Resolving deltas 100% (10/10)")
	expect(text).not.toContain("20%")
}, 30_000)
