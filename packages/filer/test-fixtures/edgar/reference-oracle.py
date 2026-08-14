"""How expected.json was produced — a one-off audit tool, not part of any build.

An independent implementation of the Exhibit 21 extraction rules, written to check
filer/sdk/exhibit21.ts rather than to ship. Deliberately unlike it: a real HTML parser
(lxml) over a DOM, in a different language, by a different route. Its output was then read
line by line against the source documents and vendored as expected.json.

The point is non-circularity. An expected.json generated from parseExhibit21 output would
have recorded, as the contract, the eight zero-yield documents and eighteen fabricated names
the TypeScript parser produced on 2026-08-03 — all of which its own hand-written fixture
suite passed. Ground truth has to come from somewhere the implementation cannot reach.

Re-run it (needs beautifulsoup4 + lxml in a virtualenv) to audit expected.json:

    python reference-oracle.py filer/test-fixtures/edgar/*.htm

It is NOT a second parser to keep in sync, and nothing imports it. When a rule changes,
the plan and exhibit21.ts are what change; this file is the record of how the numbers in
expected.json were arrived at, and re-running it is how a reviewer checks them.
"""

import json
import re
import sys
from pathlib import Path

import lxml.html

BULLET = re.compile(r"^[•●▪◦·\*–—]+\s*")
FOOTNOTE = re.compile(r"^[\(\[]?\d{1,3}[\)\]]?$|^\*{1,3}$")
PAREN_TAIL = re.compile(r"^(?P<name>.+?)\s*\((?P<juris>[^()]{2,60})\)\s*$")

JURISDICTION_LABEL = re.compile(
    r"^(jurisdiction|domicile|state|country|state/country of organization|"
    r"jurisdiction of (incorporation|organization|formation)( or (organization|formation))?|"
    r"state (of|or) .*(incorporation|organization|formation).*|"
    r"state or country of incorporation|state/country of formation|"
    r"place of incorporation|where organized|organized under the laws of)$",
    re.I,
)
NAME_LABEL = re.compile(
    r"^(name|legal name|entity name|full legal name|name of entity|subsidiary|subsidiaries|"
    r"subsidiary name|name of subsidiar(y|ies)|legal entity|subsidiary companies|registrant)$",
    re.I,
)
OTHER_LABEL = re.compile(
    r"^(%\s*of ownership|percent(age)?( owned| of ownership)?|ownership( percentage)?|"
    r"name doing business as|conducts business under|d/?b/?a|"
    r"other name\(s\) under which entity does business|ein|employer identification.*)$",
    re.I,
)
TITLE_LABEL = re.compile(
    r"^(exhibit\s*21(\.\d+)?([\s\-–—:]+list of subsidiaries)?|list of subsidiaries.*|"
    r"subsidiaries of .*|.+ and subsidiaries|domestic subsidiaries|foreign subsidiaries|as of .*)$",
    re.I,
)
WORD_CAP = 12
DESIGNATION = re.compile(
    r"(^|[\s,.])("
    r"inc|inc\.|incorporated|llc|l\.l\.c\.|ltd|ltd\.|limited|corp|corp\.|corporation|"
    r"co|co\.|company|lp|l\.p\.|llp|plc|gmbh|s\.a\.|s\.a|sa|bv|b\.v\.|nv|n\.v\.|"
    r"ag|pty|sarl|s\.a\.r\.l\.|kk|oy|ab|as|aps|spa|s\.p\.a\.|srl|s\.r\.l\.|lda|ulc|"
    r"holdings|partnership"
    r")([\s,.)]|$)",
    re.I,
)


def is_headerish(v: str) -> bool:
    return bool(
        JURISDICTION_LABEL.match(v) or NAME_LABEL.match(v) or OTHER_LABEL.match(v) or TITLE_LABEL.match(v)
    )


def visible(el) -> str:
    txt = "".join(el.itertext())
    txt = txt.replace(" ", " ").replace("​", "")
    return re.sub(r"\s+", " ", txt).strip()


def strip_sgml(raw: str) -> str:
    m = re.search(r"<TEXT>", raw, re.I)
    body = raw[m.end():] if m else raw
    m2 = re.search(r"</TEXT>", body, re.I)
    return body[: m2.start()] if m2 else body


def rows_of(table):
    out = []
    for tr in table.xpath(".//tr"):
        if tr.xpath("ancestor::table[1]") and tr.xpath("ancestor::table[1]")[0] is not table:
            continue
        cells = tr.xpath("./td|./th")
        out.append([visible(c) for c in cells])
    return out


def drop_blank_columns(rows):
    if not rows:
        return rows
    width = max((len(r) for r in rows), default=0)
    keep = [i for i in range(width) if any((r[i] if i < len(r) else "") for r in rows)]
    return [[(r[i] if i < len(r) else "") for i in keep] for r in rows]


def header_mapping(rows):
    """Return (name_idx, juris_idx) when a header row labels a jurisdiction column."""
    for row in rows:
        values = [v for v in row if v]
        if not values or not all(is_headerish(v) for v in values):
            continue
        juris = [i for i, v in enumerate(row) if v and JURISDICTION_LABEL.match(v)]
        if len(juris) != 1:
            continue
        j = juris[0]
        for i, v in enumerate(row):
            if i == j:
                continue
            if v and OTHER_LABEL.match(v):
                continue
            return i, j
    return None


def classify_table(rows, stats, carried=None):
    subs = []
    rows = drop_blank_columns(rows)
    mapping = header_mapping(rows) or carried
    width = max((len(r) for r in rows), default=0)

    pairs = [[v for v in r if v] for r in rows]
    two = [p for p in pairs if len(p) == 2 and not FOOTNOTE.match(p[0]) and not all(is_headerish(v) for v in p)]
    if not mapping and len(two) >= 4:
        seconds = [p[1] for p in two]
        designated = sum(1 for v in seconds if DESIGNATION.search(v))
        distinct = len(set(seconds))
        # A jurisdiction column repeats; a second NAME column does not. Charter writes its
        # jurisdictions as "Delaware limited liability company" (135/135 carry a designation)
        # and is separated from IDT's two-across name list only by this ratio.
        if designated * 2 > len(two) and distinct * 10 > len(two) * 7:
            stats["name-name-table"] += len(two)
            return subs, mapping

    all_single = bool(pairs) and all(len(p) <= 1 for p in pairs) and sum(1 for p in pairs if len(p) == 1) >= 2

    for row in rows:
        values = [v for v in row if v]
        if not values:
            stats["blank"] += 1
            continue
        if all(is_headerish(v) for v in values):
            stats["header"] += 1
            continue
        if FOOTNOTE.match(values[0]):
            stats["footnote"] += 1
            continue
        if len(values) == 1 and not all_single:
            stats["heading"] += 1
            continue
        if len(DESIGNATION.findall(values[0])) >= 3:
            stats["merged-cell"] += 1
            continue
        if mapping:
            i, j = mapping
            name = row[i] if i < len(row) else ""
            juris = row[j] if j < len(row) else ""
            if not name and i < j:
                # Indented corporate-tree row: the child's name sits in a column to the RIGHT of the
                # labelled name column but still LEFT of the labelled jurisdiction column. The nesting
                # depth is discarded; the name itself is not in doubt.
                for k in range(i + 1, min(j, len(row))):
                    if row[k]:
                        name = row[k]
                        break
            if name:
                subs.append({"name": name, "jurisdiction": juris} if juris else {"name": name})
                continue
        if len(values) > 2:
            stats["wide"] += 1
            continue
        if not row[0]:
            stats["leadblank"] += 1
            continue
        if len(values) == 1:
            subs.append({"name": values[0]})
            continue
        subs.append({"name": values[0], "jurisdiction": values[1]})
    return subs, mapping


def from_tables(doc, stats):
    subs = []
    tables = [t for t in doc.xpath("//table") if not t.xpath("ancestor::table")]
    carried = None
    for table in tables:
        found, carried = classify_table(rows_of(table), stats, carried)
        subs.extend(found)
    return subs, len(tables)


BLOCK = "p div li tr br h1 h2 h3 h4 h5 h6 td th".split()


def text_lines(doc):
    html = lxml.html.tostring(doc, encoding="unicode")
    for tag in BLOCK:
        html = re.sub(rf"</?{tag}[^>]*>", "\n", html, flags=re.I)
    text = lxml.html.fromstring("<div>" + html + "</div>").text_content()
    text = text.replace(" ", " ").replace("​", "")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    return [ln for ln in lines if ln]


def from_lines(lines, stats):
    subs = []
    for line in lines:
        candidate = BULLET.sub("", line).strip()
        if not candidate:
            continue
        if is_headerish(candidate):
            stats["header"] += 1
            continue
        if FOOTNOTE.match(candidate):
            stats["footnote"] += 1
            continue
        if len(candidate.split()) > WORD_CAP:
            stats["too-long"] += 1
            continue
        m = PAREN_TAIL.match(candidate)
        if m and not DESIGNATION.search(m.group("juris")):
            subs.append({"name": m.group("name").strip(), "jurisdiction": m.group("juris").strip()})
            continue
        parts = re.split(r"\s{2,}", candidate)
        if len(parts) == 2:
            subs.append({"name": parts[0].strip(), "jurisdiction": parts[1].strip()})
            continue
        if len(parts) > 2:
            stats["wide"] += 1
            continue
        subs.append({"name": candidate})
    return subs


def analyse(path: Path):
    raw = path.read_text(encoding="utf8", errors="replace")
    doc = lxml.html.fromstring(strip_sgml(raw))
    for bad in doc.xpath("//head|//script|//style|//title"):
        bad.getparent().remove(bad)
    stats = {
        k: 0
        for k in "blank header footnote heading wide leadblank blankname jurisdiction-is-a-name name-name-table too-long merged-cell".split()
    }
    subs, table_count = from_tables(doc, stats)
    strategy = "table"
    if not subs:
        stats = {k: 0 for k in stats}
        subs = from_lines(text_lines(doc), stats)
        strategy = "lines"
    return {
        "file": path.name,
        "strategy": strategy,
        "topLevelTables": table_count,
        "count": len(subs),
        "abstentions": {k: v for k, v in stats.items() if v},
        "subsidiaries": subs,
    }


if __name__ == "__main__":
    json.dump([analyse(Path(p)) for p in sorted(sys.argv[1:])], sys.stdout, indent=1, ensure_ascii=False)
