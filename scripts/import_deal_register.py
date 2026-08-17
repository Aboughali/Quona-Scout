"""
Merges Africa_Fintech_Deal_Register_Aug2023_Aug2026_v1.xlsx into src/data/companies.json.

Runs AFTER etl.py + apply_manual_overrides.py, on top of their output, so the gold sheet
remains the base layer and this register is an additive enrichment pass.

Merge rules (all deliberate, see the case brief's data-import-safety section):
  * ONE STARTUP = ONE COMPANY RECORD. Rows are matched to existing companies by canonical
    name (case/punctuation/whitespace-insensitive), never appended blindly.
  * A trailing parenthetical qualifier -- e.g. "MoneyHash (pre-Series A)", which is a round
    label leaking into the company-name column -- is stripped for matching so the round lands
    on the real company instead of creating a phantom one.
  * Round-level dedup is fingerprinted on (type, amount) with a date tolerance, because the
    same financing event is routinely reported with different date precision across sources
    (one sheet logs 2025-01-01, another 2025-01-20). Matching on exact date alone would
    duplicate the round; matching on type alone would collapse genuinely separate raises.
  * Nothing is ever overwritten with something worse: a blank/"not available" register value
    never replaces an existing value, and a genuine disagreement between two populated values
    is recorded in the round's `conflict` field rather than silently resolved.
  * "Leads to Verify" is NOT imported. That tab is explicitly labelled in the workbook's own
    README as unverified hypotheses ("Do not promote a row into 'Deals' without a primary
    source URL"), and importing it would put unsourced rounds into a scored database.

Run:  python3 scripts/import_deal_register.py
"""
import json
import os
import re
from datetime import date, datetime

import openpyxl

REGISTER = os.path.expanduser("~/Downloads/Africa_Fintech_Deal_Register_Aug2023_Aug2026_v1.xlsx")
COMPANIES = "src/data/companies.json"
REPORT = "src/data/deal_register_import_report.json"

REGISTER_SOURCE = "Africa Fintech Deal Register (Aug 2023-Aug 2026)"

# Kept identical to scripts/etl.py so a register-sourced company faces the same funnel.
GEO_AUTO_PASS_COUNTRIES = {"Egypt", "South Africa"}
SERIES_A_PLUS_TYPES = {"Series A", "Series B", "Series C", "Series D", "Series E"}
# Same-event tolerance. Wide enough to absorb "first of the month" vs. exact announcement
# date, narrow enough that two real raises months apart stay separate.
DATE_TOLERANCE_DAYS = 45

NOT_AVAILABLE_MARKERS = (
    "not available in the provided materials",
    "not named in sources reviewed",
    "not confirmed",
    "n.a",
    "",
)

C = {
    "date": 2, "name": 4, "website": 5, "country": 6, "region": 7,
    "operating_countries": 8, "founded": 10, "founders": 11, "description": 12,
    "sector": 13, "subsector": 14, "business_model": 16,
    "round_type": 17, "round_label": 18, "amount": 19, "amount_disclosure": 20,
    "lead": 22, "investors": 23, "valuation": 29,
    "primary_url": 30, "secondary_url": 31, "confidence": 34,
    "verification": 35, "conflicts": 36,
}


def norm_company_name(name):
    s = re.sub(r"[^a-z0-9]+", " ", str(name).strip().lower())
    return re.sub(r"\s+", " ", s).strip()


def strip_parenthetical(name):
    return re.sub(r"\s*\([^)]*\)\s*$", "", str(name)).strip()


def clean(v):
    """Returns a usable string, or None for blanks and explicit 'no data' markers -- so a
    register cell saying 'Not available in the provided materials' never overwrites a real
    researched value with a placeholder."""
    if v is None:
        return None
    s = str(v).strip()
    if s.lower() in NOT_AVAILABLE_MARKERS:
        return None
    return s or None


def as_float(v):
    try:
        f = float(v)
        return f
    except (TypeError, ValueError):
        return None


def parse_date(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return None


def parse_date_str(s):
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


ROLE_PARENTHETICAL = re.compile(
    r"\s*\((?:equity\s+|debt\s+)?(?:co-?led|co-?lead|lead|led|participating|equity|debt)\)\s*$",
    re.I,
)


def split_investors(raw):
    """The register separates investors with ';' (the gold sheet uses ','). Handles both.

    Trailing parentheticals are handled carefully: a ROLE annotation ("Quona Capital (co-led)")
    is stripped, because leaving it produces a second, phantom investor that then gets its own
    fund profile and its own score. A descriptive parenthetical that is part of the entity's
    identity ("Baalbaki (family office)", "Norrsken (accelerator)") is preserved -- unless the
    bare name also appears in the same round, in which case the two are plainly the same
    investor written twice and the annotated form is dropped."""
    s = clean(raw)
    if not s:
        return []
    out = []
    for p in re.split(r"[;,]", s):
        p = p.strip()
        if not p or p.lower() in NOT_AVAILABLE_MARKERS:
            continue
        p = ROLE_PARENTHETICAL.sub("", p).strip()
        if p:
            out.append(p)

    bare = {x.lower() for x in out}
    deduped = []
    for name in out:
        stripped = re.sub(r"\s*\([^)]*\)\s*$", "", name).strip()
        if stripped and stripped.lower() != name.lower() and stripped.lower() in bare:
            continue  # annotated variant of a name already present on this round
        deduped.append(name)
    return deduped


# Maps the register's round-type wording onto the gold sheet's vocabulary. Pre-Series A is
# preserved verbatim -- the frontend taxonomy has it as a first-class type and must never
# coarsen it into Seed.
ROUND_TYPE_MAP = {
    "pre-seed": "Pre-Seed",
    "seed": "Seed",
    "pre-series a": "Pre-Series A",
    "series a": "Series A",
    "series b": "Series B",
    "series c": "Series C",
    "debt + equity": "Debt",
    "venture debt": "Debt",
    "debt": "Debt",
    "grant": "Grant",
}


def map_round_type(raw):
    s = clean(raw)
    if not s:
        return None
    key = s.strip().lower()
    if key in ROUND_TYPE_MAP:
        return ROUND_TYPE_MAP[key]
    if "pre-series a" in key or "pre series a" in key:
        return "Pre-Series A"
    if key.startswith("equity round"):
        return "Venture Round"
    return s


# Two sources rounding the same raise differently ($6.75m vs "$6.8m") must not become two
# rounds. A relative tolerance absorbs that without merging genuinely different raises, which
# in practice differ by far more than this.
AMOUNT_REL_TOLERANCE = 0.02


def amounts_compatible(a, b):
    if a is None or b is None:
        return True  # one side undisclosed -- not evidence of a different event
    if abs(a - b) <= 0.01:
        return True
    scale = max(abs(a), abs(b))
    return scale > 0 and abs(a - b) / scale <= AMOUNT_REL_TOLERANCE


def same_event(existing, cand_type, cand_amount, cand_date):
    """Two records describe the same financing event when the round type matches, the dates
    are within tolerance, and the amounts are compatible (equal, near-equal, or one
    undisclosed). Deliberately conservative: when in doubt the round stays separate, because
    inventing a duplicate raise is a more damaging error than leaving two rows to review.
    Two Seed rounds a year apart, or with materially different amounts, stay separate."""
    e_type = (existing.get("type") or "").strip().lower()
    c_type = (cand_type or "").strip().lower()
    if e_type != c_type:
        return False

    e_date = parse_date_str(existing.get("date"))
    if e_date and cand_date and abs((e_date - cand_date).days) > DATE_TOLERANCE_DAYS:
        return False
    if bool(e_date) != bool(cand_date):
        return False

    return amounts_compatible(as_float(existing.get("amountUsdM")), cand_amount)


def main():
    with open(COMPANIES) as f:
        companies = json.load(f)

    by_norm = {norm_company_name(c["name"]): c for c in companies}
    existing_ids = {c["id"] for c in companies}

    wb = openpyxl.load_workbook(REGISTER, data_only=True)
    rows = list(wb["Deals"].iter_rows(values_only=True))

    report = {
        "register_rows_read": 0, "rows_skipped_non_data": 0,
        "matched_existing_company": 0, "matched_via_parenthetical": 0,
        "new_companies_added": 0, "rounds_added": 0, "rounds_merged_same_event": 0,
        "fields_enriched": 0, "conflicts_flagged": 0,
        "new_company_names": [], "conflicts": [], "flagged_for_review": [],
    }

    for r in rows[1:]:
        raw_name = clean(r[C["name"]])
        if not raw_name:
            continue
        # The sheet carries a trailing prose footnote in the name column; it is not a company.
        if raw_name.lower().startswith("column a") or len(raw_name) > 60:
            report["rows_skipped_non_data"] += 1
            continue
        report["register_rows_read"] += 1

        key = norm_company_name(raw_name)
        target = by_norm.get(key)
        matched_via_paren = False
        if target is None:
            alt = norm_company_name(strip_parenthetical(raw_name))
            if alt != key and alt in by_norm:
                target = by_norm[alt]
                matched_via_paren = True
                report["matched_via_parenthetical"] += 1
                report["flagged_for_review"].append({
                    "register_name": raw_name,
                    "merged_into": target["name"],
                    "why": "Register name carries a trailing round-label qualifier; merged onto the base company rather than creating a duplicate.",
                })

        cand_type = map_round_type(r[C["round_type"]])
        cand_amount = as_float(r[C["amount"]])
        cand_date = parse_date(r[C["date"]])
        investors = split_investors(r[C["investors"]])
        leads = split_investors(r[C["lead"]])
        url = clean(r[C["primary_url"]])
        confidence = clean(r[C["confidence"]])

        new_round = {
            "date": cand_date.isoformat() if cand_date else "",
            "type": cand_type,
            "amountBracket": None,
            "amountUsdM": cand_amount,
            "amountDisclosure": clean(r[C["amount_disclosure"]]),
            "valuationUsdM": as_float(r[C["valuation"]]),
            "estimatedValuationUsdM": None,
            "investors": sorted(set(investors) | set(leads)),
            "link": url,
            "comment": clean(r[C["conflicts"]]),
            "sourceDataset": REGISTER_SOURCE,
            "conflict": None,
            "registerConfidence": confidence,
            "verificationStatus": clean(r[C["verification"]]),
        }

        if target is None:
            # Genuinely new company. Stage flags are left for the funnel to recompute; the
            # ETL's own classification logic is not duplicated here.
            slug_base = re.sub(r"[^a-z0-9]+", "-", raw_name.strip().lower()).strip("-")
            slug = slug_base
            n = 2
            while slug in existing_ids:
                slug = f"{slug_base}-{n}"
                n += 1
            existing_ids.add(slug)

            country = clean(r[C["country"]])
            sector = clean(r[C["sector"]]) or "Fintech"
            founders = [f.strip() for f in re.split(r"[;,]", clean(r[C["founders"]]) or "") if f.strip()]
            founded = r[C["founded"]]

            # Stage flags use the SAME rules as scripts/etl.py -- core fintech only at Stage 2
            # (adjacent is flagged for review, never auto-passed), Series A+ excludes at Stage 3,
            # Egypt/South Africa auto-pass at Stage 4. Nothing bespoke is invented for the
            # register: a company entering this way faces the identical funnel.
            is_core_fintech = sector.strip().lower() == "fintech"
            adjacent = sector.strip().lower() == "fintech-adjacent"
            stage2_pass = is_core_fintech
            stage2_reason = (
                f"Sector = {sector} ({REGISTER_SOURCE})" if is_core_fintech
                else f"Sector = {sector} -- flagged for manual review, not auto-passed ({REGISTER_SOURCE})"
            )

            has_series_a = cand_type in SERIES_A_PLUS_TYPES
            stage3_pass = not has_series_a
            stage3_reason = (
                f"Has raised: {cand_type} ({REGISTER_SOURCE})" if has_series_a
                else f"No Series A or later round on record ({REGISTER_SOURCE})"
            )

            geo_auto = country in GEO_AUTO_PASS_COUNTRIES
            stage4_reason = (
                f"HQ/base = {country} (auto-pass)" if geo_auto
                else f"HQ/base = {country}; no multi-market evidence found"
            )

            cut_stage, cut_reason = None, None
            if not stage2_pass:
                cut_stage, cut_reason = 2, stage2_reason
            elif not stage3_pass:
                cut_stage, cut_reason = 3, stage3_reason
            elif not geo_auto:
                cut_stage, cut_reason = 4, stage4_reason

            company = {
                "id": slug,
                "name": raw_name,
                "website": clean(r[C["website"]]),
                "country": country,
                "region": clean(r[C["region"]]),
                "description": clean(r[C["description"]]) or "",
                "sector": sector,
                "foundingYear": int(founded) if isinstance(founded, (int, float)) else None,
                "founders": founders,
                "investors": sorted(set(new_round["investors"])),
                "rounds": [new_round],
                "latestRoundType": cand_type,
                "sourceConfidence": "High" if confidence == "HIGH" else "Medium" if confidence in ("MED-HI", "MED") else "Low",
                "fintechSubSector": clean(r[C["subsector"]]) or "",
                "businessModel": clean(r[C["business_model"]]) or "",
                "stage1": {"pass": True, "reason": f"Raised a round within the intake window ({REGISTER_SOURCE})"},
                "stage2": {"pass": stage2_pass, "reason": stage2_reason, "adjacentCandidate": adjacent},
                "stage3": {"pass": stage3_pass, "reason": stage3_reason},
                "stage4": {"pass": geo_auto, "reason": stage4_reason, "autoPass": geo_auto, "multiMarketSignal": False},
                "stage5": {"pass": None, "reason": "Pending syndicate research"},
                "overrides": {
                    "seriesAReclass": {"active": False, "note": ""},
                    "geography3Markets": {"active": False, "note": ""},
                    "fintechPivot": {"active": False, "note": ""},
                    "syndicateJudgment": {"active": False, "note": ""},
                },
                "cutStage": cut_stage, "cutReason": cut_reason,
                "sourceDataset": REGISTER_SOURCE,
            }
            companies.append(company)
            by_norm[key] = company
            report["new_companies_added"] += 1
            report["rounds_added"] += 1
            report["new_company_names"].append(raw_name)
            continue

        # ---- Existing company: merge the round in, never append a duplicate event ----
        if not matched_via_paren:
            report["matched_existing_company"] += 1

        merged_into = None
        for existing in target["rounds"]:
            if same_event(existing, cand_type, cand_amount, cand_date):
                merged_into = existing
                break

        if merged_into is not None:
            before = dict(merged_into)
            merged_into["investors"] = sorted(set(merged_into.get("investors", [])) | set(new_round["investors"]))
            if not merged_into.get("link") and url:
                merged_into["link"] = url
            existing_ds = merged_into.get("sourceDataset")
            if existing_ds and REGISTER_SOURCE not in existing_ds:
                merged_into["sourceDataset"] = f"{existing_ds} + {REGISTER_SOURCE}"
            merged_into.setdefault("registerConfidence", confidence)

            # Preserve, never silently resolve, a real disagreement on the amount.
            e_amt = as_float(before.get("amountUsdM"))
            if e_amt is None and cand_amount is not None:
                merged_into["amountUsdM"] = cand_amount
            elif e_amt is not None and cand_amount is not None and abs(e_amt - cand_amount) > 0.01:
                merged_into["conflict"] = {
                    "field": "amountUsdM",
                    "values": [
                        {"value": e_amt, "source": before.get("sourceDataset") or "Gold sheet"},
                        {"value": cand_amount, "source": REGISTER_SOURCE},
                    ],
                }
                report["conflicts_flagged"] += 1
                report["conflicts"].append({"company": target["name"], "field": "amountUsdM", "existing": e_amt, "register": cand_amount})
            report["rounds_merged_same_event"] += 1
        else:
            target["rounds"].append(new_round)
            report["rounds_added"] += 1

        target["rounds"].sort(key=lambda x: x.get("date") or "")

        # Union investors at company level; enrich only genuinely empty company fields.
        target["investors"] = sorted(set(target.get("investors", [])) | set(new_round["investors"]))
        for field, value in (
            ("website", clean(r[C["website"]])),
            ("description", clean(r[C["description"]])),
            ("fintechSubSector", clean(r[C["subsector"]])),
            ("businessModel", clean(r[C["business_model"]])),
        ):
            if value and not target.get(field):
                target[field] = value
                report["fields_enriched"] += 1

        if target["rounds"]:
            target["latestRoundType"] = target["rounds"][-1].get("type")

    companies.sort(key=lambda c: c["name"].lower())
    with open(COMPANIES, "w") as f:
        json.dump(companies, f, indent=2)
    with open(REPORT, "w") as f:
        json.dump(report, f, indent=2)

    print("=== Deal register import ===")
    print(f"Register rows read:                {report['register_rows_read']}")
    print(f"  non-data rows skipped:           {report['rows_skipped_non_data']}")
    print(f"Matched an existing company:       {report['matched_existing_company']}")
    print(f"  matched via paren-qualifier:     {report['matched_via_parenthetical']}")
    print(f"New companies added:               {report['new_companies_added']}")
    print(f"Rounds added:                      {report['rounds_added']}")
    print(f"Rounds merged as same event:       {report['rounds_merged_same_event']}")
    print(f"Empty company fields enriched:     {report['fields_enriched']}")
    print(f"Amount conflicts flagged:          {report['conflicts_flagged']}")
    print(f"Total companies now:               {len(companies)}")
    if report["new_company_names"]:
        print("New: " + ", ".join(sorted(report["new_company_names"])))
    print(f"Wrote {REPORT}")


if __name__ == "__main__":
    main()
