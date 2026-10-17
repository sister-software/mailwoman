"""The US situs reader admits a database `source` value only on its register rows' decisions.

OpenAddresses does not relicense the county and state bodies it collects, so each body's rows reach the tuples
only when that body's own decision permits transform and train.
"""

from __future__ import annotations

import json
from pathlib import Path

from mailwoman_train.countries.us.tuples import admitted_situs_sources, state_code
from mailwoman_train.source_rights import SourceRights

PERMITTED = {"permission": "permitted", "basis": "other-documented", "because": "x"}


def _rights() -> SourceRights:
    elected = {"state": "elected", "operations": {"transform": PERMITTED, "train": PERMITTED}}
    register = {
        "licenses": [
            {"licenseID": "lic-nad", **elected},
            {"licenseID": "lic-overture", **elected},
            {"licenseID": "lic-open-county", **elected},
            {"licenseID": "lic-closed-county", "state": "refused", "refusedBecause": "revocable license"},
        ],
        "sources": [
            {"sourceID": "nad", "license": "lic-nad"},
            {"sourceID": "overture", "license": "lic-overture"},
            {"sourceID": "open-county", "license": "lic-open-county"},
            {"sourceID": "closed-county", "license": "lic-closed-county"},
        ],
    }
    return SourceRights.from_documents(register, {"sources": {}})


def test_a_body_is_admitted_only_when_every_register_row_permits_training(tmp_path: Path) -> None:
    table = tmp_path / "us-situs-sources.json"
    table.write_text(
        json.dumps(
            {
                "sources": {
                    "overture:NAD": ["nad", "overture"],
                    "overture:OpenAddresses/XX/Open County": ["open-county", "overture"],
                    "overture:OpenAddresses/XX/Closed County": ["closed-county", "overture"],
                    "overture:OpenAddresses/XX/Unread County": ["no-such-row", "overture"],
                    "openaddresses": [],
                }
            }
        ),
        encoding="utf-8",
    )

    assert admitted_situs_sources(_rights(), table) == {"overture:NAD", "overture:OpenAddresses/XX/Open County"}


def test_the_committed_table_admits_nad_and_refuses_a_revocable_license() -> None:
    admitted = admitted_situs_sources()
    assert "overture:NAD" in admitted
    assert "overture:OpenAddresses/MI/Kent County" not in admitted
    assert "openaddresses" not in admitted


def test_a_county_database_reads_as_its_state() -> None:
    assert state_code(Path("address-points-us-il-cook.db")) == "IL"
    assert state_code(Path("address-points-us-ca.db")) == "CA"
