# @mailwoman/libpostal

A **libpostal-compatible** parse/expand HTTP API over [Mailwoman](https://mailwoman.sister.software)'s
neural address parser. The lowest-dependency drop-in — `/parse` needs no gazetteer, just the model.

```bash
npx @mailwoman/libpostal serve --port 8081
```

```bash
curl -s "http://localhost:8081/parse?query=1600 Pennsylvania Ave NW, Washington DC 20500"
# [{"label":"house_number","value":"1600"},{"label":"road","value":"Pennsylvania Ave NW"},
#  {"label":"city","value":"Washington"},{"label":"state","value":"DC"},{"label":"postcode","value":"20500"}]
```

## Endpoints

| Endpoint  | libpostal contract                                        |
| --------- | --------------------------------------------------------- |
| `/parse`  | `parse_address` — ordered `[{label, value}]` components   |
| `/expand` | `expand_address` — normalized forms (see the honest note) |

`/parse` maps Mailwoman's `ComponentTag` classifications to libpostal's labels (`street`→`road`,
`locality`→`city`, `region`→`state`, …) via `COMPONENT_TO_LIBPOSTAL`.

**Honest note on `/expand`:** Mailwoman's normalization is deterministic, so `/expand` returns the
original plus its normalized + abbreviation-expanded forms — not libpostal's probabilistic multi-variant
expansion. One canonical alternative, not a hypothesis set.

## Library use

```ts
import express from "express"
import { createLibpostalRouter, type LibpostalEngine } from "@mailwoman/libpostal"

const engine: LibpostalEngine = {
	async parse(query) {
		/* return [{ classification, value }] from your parser */
	},
}
express().use(createLibpostalRouter(engine)).listen(8081)
```
