# @mailwoman/mcp

An **MCP server** exposing [Mailwoman](https://mailwoman.sister.software)'s parse/geocode/POI toolset to agents over stdio — no HTTP endpoint, just a subprocess an MCP client launches.

## Tools

| Tool                        | What it does                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| `mailwoman_parse`           | Runtime-pipeline parse (optionally POI-aware)                           |
| `mailwoman_geocode`         | Street-level geocode cascade                                            |
| `mailwoman_poi_search`      | POI-intent extraction, executed against a wired `poi.db`                |
| `mailwoman_overpass_export` | Renders a POI query as OverpassQL (prints the query, never runs it)     |
| `mailwoman_layer_manifest`  | Reads a spatial-layer database's provenance manifest + coverage summary |

## Config

```json
{
	"mcpServers": {
		"mailwoman": {
			"command": "mailwoman-mcp",
			"args": ["--poi-db", "/path/to/poi.db"]
		}
	}
}
```

`--poi-db <path>` wires `mailwoman_poi_search` (and `mailwoman_parse`'s `poi: true` path) to a real database; omit it and those tools degrade gracefully to intent-only.
