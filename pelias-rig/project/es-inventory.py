"""
Per-country / per-source / per-layer document counts for the scoped Pelias index.

Not an aggregation: Pelias's schema maps every `parent.*` name as `text` and every `parent.*_id` as
`keyword` with `doc_values: false`, so `terms` aggs on country return HTTP 400. The counts here come
from one filtered `_count` per (country x source) pair instead — 12 x N cheap queries against a
single-shard index, which is what makes the country scoping auditable rather than asserted.

Usage: python3 es-inventory.py [--countries US,FR,...]
"""

import json
import sys
import urllib.request

ES = "http://localhost:9200/pelias"
COUNTRIES = ["US", "FR", "DE", "GB", "AU", "NZ", "AT", "CH", "CZ", "DK", "BE", "NL"]


def post(path, body):
    req = urllib.request.Request(
        f"{ES}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req))


def count(query):
    return post("/_count", {"query": query})["count"]


def main():
    countries = COUNTRIES
    for i, arg in enumerate(sys.argv):
        if arg == "--countries":
            countries = sys.argv[i + 1].split(",")

    total = count({"match_all": {}})
    print(f"total {total:,}")

    agg = post(
        "/_search?size=0",
        {"aggs": {"s": {"terms": {"field": "source", "size": 20}}, "l": {"terms": {"field": "layer", "size": 40}}}},
    )["aggregations"]

    print("--- by source ---")
    sources = [b["key"] for b in agg["s"]["buckets"]]
    for b in agg["s"]["buckets"]:
        print(f'  {b["key"]:<18} {b["doc_count"]:>12,}')

    print("--- by layer ---")
    for b in agg["l"]["buckets"]:
        print(f'  {b["key"]:<18} {b["doc_count"]:>12,}')

    print("--- by country x source ---")
    header = f'{"cc":<4}{"total":>12}' + "".join(f"{s:>14}" for s in sources)
    print(header)
    for cc in countries:
        base = {"match_phrase": {"parent.country_a": cc}}
        row = f"{cc:<4}{count(base):>12,}"
        for s in sources:
            n = count({"bool": {"must": [base, {"term": {"source": s}}]}})
            row += f"{n:>14,}"
        print(row)

    outside = count({"bool": {"must_not": [{"terms": {"parent.country_a": [c.lower() for c in countries]}}]}})
    print(f"\ndocs with no country_a in the panel list: {outside:,}")


if __name__ == "__main__":
    main()
