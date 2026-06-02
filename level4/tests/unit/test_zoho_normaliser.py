"""Unit tests for the Zoho normaliser's deal_type heuristic (WBS 1.1)."""
from __future__ import annotations

import pytest

from ingestion.sources.zoho.normaliser import infer_deal_type


@pytest.mark.parametrize(
    ("deal", "expected"),
    [
        ({"Deal_Type": "Software"}, "software"),
        ({"Type": "service"}, "service"),
        ({"Category": "Product"}, "product"),
        ({"Type": "SaaS subscription"}, "software"),
        ({"Type": "Annual support contract"}, "service"),
        ({"Pipeline": {"name": "Software Pipeline"}}, "software"),
        ({"Layout": "Hardware Sales"}, "product"),
        ({"Deal_Name": "Renewal of AMC for printer"}, "service"),
        ({"Deal_Name": "FDM printer + filament bundle"}, "product"),
        ({"Deal_Name": "Workbench platform licence"}, "software"),
        ({"Deal_Name": "Random ABC project"}, None),
        ({}, None),
    ],
)
def test_infer_deal_type(deal: dict, expected: str | None) -> None:
    assert infer_deal_type(deal) == expected


def test_explicit_field_beats_name() -> None:
    # Explicit field wins even when the name implies something else.
    assert infer_deal_type({"Deal_Type": "service", "Deal_Name": "Annual SaaS Licence"}) == "service"
