import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "@mailwoman/platform/fs"

export async function build(root: string, bytes: Uint8Array): Promise<number> {
	if (!existsSync(root)) mkdirSync(root, { recursive: true })

	mkdirSync(`${root}/lock`)
	writeFileSync(`${root}/name.txt`, "hello")
	writeFileSync(`${root}/blob.bin`, bytes)
	writeFileSync(`${root}/meta.json`, JSON.stringify({ ok: true }))
	rmSync(`${root}/stale`, { recursive: true, force: true })

	const text = readFileSync(`${root}/name.txt`, "utf8")

	return text.length + statSync(root).size
}
