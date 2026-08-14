# @mailwoman/mcp

An **MCP server** exposing [Mailwoman](https://mailwoman.sister.software)'s parse/geocode/POI toolset to agents over stdio — no HTTP endpoint, just a subprocess an MCP client launches.

## Tools

| Tool                             | What it does                                                                 | Needs the model + a gazetteer |
| -------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- |
| `mailwoman_parse`                | Runtime-pipeline parse (optionally POI-aware)                                | Yes                           |
| `mailwoman_geocode`              | Street-level geocode cascade                                                 | Yes                           |
| `mailwoman_poi_search`           | POI-intent extraction, executed against a wired `poi.db`                     | Yes                           |
| `mailwoman_overpass_export`      | Renders a POI query as OverpassQL (prints the query, never runs it)          | Yes                           |
| `mailwoman_layer_manifest`       | Reads a spatial-layer database's provenance manifest + coverage summary      | No                            |
| `mailwoman_bdc_filing_landscape` | Reads a `bdc.db` layer's filing census over census blocks or H3 cells        | No                            |
| `mailwoman_plausibility_check`   | Scores one claimed broadband-service assertion against filing + POI evidence | Only when it geocodes         |
| `mailwoman_filer_lookup`         | Reads the FCC filer identity crosswalk from a `filer.db` layer               | No                            |
| `mailwoman_filer_family`         | Reads a corporate family's membership from a `filer.db` layer                | No                            |

The four model-backed tools load the `en-US` weights and open a resolver on the first call that needs them, not at
startup. With neither `$MAILWOMAN_CANDIDATE_DB` nor a WOF distribution on the data root, that first call answers with
the `mailwoman data pull candidate` fix instead of an internal resolver error.

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
