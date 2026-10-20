#!/usr/bin/env python3
"""Rebuild aa-data.js (window.AA_DATA) from the Artificial Analysis leaderboard.

The leaderboard page embeds its table data as a JSON "models" array inside the
Next.js payload of the HTML. This script downloads the page (or reads a saved
copy), extracts that array (deprecated models included) and merges it into
aa-data.js next to this script.

Merging keeps history: models are identified by their slug, so a model the
page no longer has metrics for stays in the file with its last known values.
Each model carries:
    firstSeen        capture date the model first appeared
    lastSeen         last capture date the page gave its metrics
    deprecated       true when the site flags it (or its family) as deprecated
    deprecationDate  capture date it was first seen deprecated
    retired          true when the site no longer lists it at all
    retiredDate      capture date it was first found missing

Usage:
    python refresh_aa_data.py                     # download and merge
    python refresh_aa_data.py --input page.html   # use a saved copy of the page
    python refresh_aa_data.py --output other.js   # merge into another file
    python refresh_aa_data.py --date 2026-10-16   # capture date (when replaying a saved page)

Only the Python standard library is used.
"""

import argparse
import datetime
import json
import pathlib
import sys
import urllib.request

SOURCE_URL = "https://artificialanalysis.ai/leaderboards/models"
DEFAULT_OUTPUT = pathlib.Path(__file__).with_name("aa-data.js")
USER_AGENT = "Mozilla/5.0 (aa-data refresh script)"

# Columns of the expanded leaderboard table: (key in the page data, label, group, type).
# Types: num = plain number, pct = 0-1 score stored as a percentage, usd, tps, s, tok.
COLUMNS = [
    ("intelligenceIndex", "Artificial Analysis Intelligence Index", "Intelligence", "num"),
    ("omniscience", "AA Omniscience Index", "Intelligence", "num"),
    ("gdpvalNormalized", "GDPval-AA v2.1 (agentic real-world work)", "Intelligence", "pct"),
    ("analystAgent", "AA-AnalystAgent (spreadsheets & documents)", "Intelligence", "pct"),
    ("terminalbenchHard", "Terminal-Bench Hard", "Intelligence", "pct"),
    ("terminalBench21", "Terminal-Bench 2.1", "Intelligence", "pct"),
    ("terminalBench40", "Terminal-Bench 4.0", "Intelligence", "pct"),
    ("tau2", "τ²-Bench Telecom (tool use)", "Intelligence", "pct"),
    ("tauBanking", "τ³-Banking (tool use)", "Intelligence", "pct"),
    ("lcr", "AA-LCR (long context reasoning)", "Intelligence", "pct"),
    ("omniscienceAccuracy", "AA-Omniscience Accuracy", "Intelligence", "pct"),
    ("omniscienceNonHallucination", "AA-Omniscience Non-Hallucination Rate", "Intelligence", "pct"),
    ("hle", "Humanity's Last Exam", "Intelligence", "pct"),
    ("gpqa", "GPQA Diamond", "Intelligence", "pct"),
    ("scicode", "SciCode", "Intelligence", "pct"),
    ("ifbench", "IFBench (instruction following)", "Intelligence", "pct"),
    ("critpt", "CritPt (physics reasoning)", "Intelligence", "pct"),
    ("apexAgents", "APEX-Agents-AA (office work)", "Intelligence", "pct"),
    ("itbenchSre", "ITBench-AA (Kubernetes RCA)", "Intelligence", "pct"),
    ("mmmuPro", "MMMU Pro (visual reasoning)", "Intelligence", "pct"),
    ("intelligenceIndexCostPerTask", "Cost per task (USD)", "Price", "usd"),
    ("price1mInputTokens", "Input price (USD / 1M tokens)", "Price", "usd"),
    ("price1mOutputTokens", "Output price (USD / 1M tokens)", "Price", "usd"),
    ("cacheHitPrice", "Cache hit price (USD / 1M tokens)", "Price", "usd"),
    ("cacheWritePrice", "Cache write price (USD / 1M tokens)", "Price", "usd"),
    ("medianOutputTokensPerSecond", "Speed, median (tokens/s)", "Speed", "tps"),
    ("percentile05OutputTokensPerSecond", "Speed, P5 (tokens/s)", "Speed", "tps"),
    ("quartile25OutputTokensPerSecond", "Speed, P25 (tokens/s)", "Speed", "tps"),
    ("quartile75OutputTokensPerSecond", "Speed, P75 (tokens/s)", "Speed", "tps"),
    ("percentile95OutputTokensPerSecond", "Speed, P95 (tokens/s)", "Speed", "tps"),
    ("medianTimeToFirstTokenSeconds", "Latency, first chunk (s)", "Latency", "s"),
    ("medianTimeToFirstAnswerTokenSeconds", "Latency, first answer (s)", "Latency", "s"),
    ("percentile05TimeToFirstTokenSeconds", "Latency, P5 first chunk (s)", "Latency", "s"),
    ("quartile25TimeToFirstTokenSeconds", "Latency, P25 first chunk (s)", "Latency", "s"),
    ("quartile75TimeToFirstTokenSeconds", "Latency, P75 first chunk (s)", "Latency", "s"),
    ("percentile95TimeToFirstTokenSeconds", "Latency, P95 first chunk (s)", "Latency", "s"),
    ("medianEndToEndResponseTimeSeconds", "Total response time (s)", "End-to-End Response Time", "s"),
    ("medianReasoningTimeSeconds", "Reasoning time (s)", "End-to-End Response Time", "s"),
    ("contextWindowTokens", "Context window (tokens)", "Features", "tok"),
]

NOTES = (
    'All numeric columns of the leaderboard table with "Expand columns". '
    'Columns of type "pct" are stored as percentages (0-100). Missing values are omitted.'
)


def download_page(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8")


def unescape_payload(html):
    """The Next.js payload stores JSON inside JS strings, so quotes appear as \\" ."""
    backslash = "\\"
    placeholder = "\x00"
    text = html.replace(backslash + backslash, placeholder)
    text = text.replace(backslash + '"', '"')
    return text.replace(placeholder, backslash)


def slug_lists(text):
    """Yield every JSON array of objects starting with "slug" in the payload.

    Key names have changed over time ("models", "initialModels"), so arrays are
    recognised by their content rather than their key.
    """
    decoder = json.JSONDecoder()
    marker = ':[{"slug"'
    position = text.find(marker)
    while position >= 0:
        try:
            candidate, _ = decoder.raw_decode(text, position + 1)
        except json.JSONDecodeError:
            candidate = None
        if isinstance(candidate, list) and candidate and isinstance(candidate[0], dict):
            yield candidate
        position = text.find(marker, position + 1)


def largest_list_with(lists, *keys):
    matching = [items for items in lists if all(key in items[0] for key in keys)]
    return max(matching, key=len, default=None)


def extract_page_data(html):
    """Return (models with metrics, {model slug: deprecated} from the site catalog).

    Recent pages only carry metrics for current models. Deprecated ones are
    still listed in a light catalog: "releases" (model families with a
    deprecated flag) and a model -> release map. The catalog is {} when absent.
    """
    lists = list(slug_lists(unescape_payload(html)))

    models = largest_list_with(lists, "intelligenceIndex", "shortName")
    if models is None:
        raise ValueError("Leaderboard models array not found in the page (site layout may have changed).")

    releases = largest_list_with(lists, "releaseDate", "deprecated") or []
    release_of_model = largest_list_with(lists, "releaseSlug") or []
    release_deprecated = {release["slug"]: bool(release.get("deprecated")) for release in releases}
    catalog = {
        item["slug"]: release_deprecated[item["releaseSlug"]]
        for item in release_of_model
        if item.get("releaseSlug") in release_deprecated
    }
    return models, catalog


def convert_value(raw, column_type):
    if raw is None:
        return None
    value = raw * 100 if column_type == "pct" else raw
    value = float(f"{value:.4g}")
    if column_type == "tok" and value == int(value):
        return int(value)
    return value


def build_model(source):
    model = {
        "name": source["shortName"],
        "slug": source["slug"],
        "creator": source["modelCreatorName"],
        "license": "Open" if source.get("isOpenWeights") else "Proprietary",
        "intelligenceEstimated": bool(source.get("intelligenceIndexIsEstimated")),
        "deprecated": bool(source.get("deprecated")),
    }
    for key, _label, _group, column_type in COLUMNS:
        value = convert_value(source.get(key), column_type)
        if value is not None:
            model[key] = value
    return model


def read_existing_models(path):
    """Models of an existing aa-data.js, or [] when there is none."""
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    # Skip the header comment, which also mentions "window.AA_DATA = ".
    marker = "\nwindow.AA_DATA = "
    start = text.find(marker)
    if start < 0:
        return []
    data, _ = json.JSONDecoder().raw_decode(text, start + len(marker))
    previous_capture = data.get("capturedAt")
    models = data.get("models", [])
    for model in models:
        # Files written before history tracking have no dates.
        model.setdefault("firstSeen", previous_capture)
        model.setdefault("lastSeen", previous_capture)
        model.setdefault("deprecated", False)
    return models


def model_key(model):
    # Files written before history tracking have no slug.
    return model.get("slug") or "name:" + model["name"]


def with_history(model, previous, capture_date):
    """Return the fresh model with firstSeen, lastSeen and deprecationDate filled in."""
    previous = previous or {}
    model["firstSeen"] = previous.get("firstSeen") or capture_date
    model["lastSeen"] = capture_date
    if model["deprecated"]:
        model["deprecationDate"] = previous.get("deprecationDate") or capture_date
    return model


def as_missing(model, catalog, capture_date):
    """Keep a model the page has no metrics for, with its last known values.

    Still in the site catalog: deprecated (or whatever the catalog says).
    Absent from the catalog too: retired.
    """
    if model_key(model) in catalog:
        model["deprecated"] = catalog[model_key(model)]
        model.pop("retired", None)
        model.pop("retiredDate", None)
        if model["deprecated"]:
            model.setdefault("deprecationDate", capture_date)
    else:
        model["retired"] = True
        model.setdefault("retiredDate", capture_date)
    return model


def merge_models(existing_models, fresh_models, catalog, capture_date):
    existing_by_key = {model_key(model): model for model in existing_models}
    existing_by_name = {model["name"]: model for model in existing_models}

    merged = []
    matched_keys = set()
    for model in fresh_models:
        previous = existing_by_key.get(model_key(model)) or existing_by_name.get(model["name"])
        if previous:
            matched_keys.add(model_key(previous))
        merged.append(with_history(model, previous, capture_date))

    missing = [
        as_missing(model, catalog, capture_date)
        for key, model in existing_by_key.items()
        if key not in matched_keys
    ]
    return merged + missing


def build_data(raw_models, catalog, existing_models, capture_date):
    fresh_models = [build_model(model) for model in raw_models]

    missing_keys = [key for key, *_ in COLUMNS if not any(key in model for model in fresh_models)]
    if missing_keys:
        print(f"Warning: columns missing from the page data: {', '.join(missing_keys)}", file=sys.stderr)

    models = merge_models(existing_models, fresh_models, catalog, capture_date)
    models.sort(key=lambda model: -(model.get("intelligenceIndex") or -1))

    return {
        "source": SOURCE_URL,
        "capturedAt": capture_date,
        "notes": NOTES,
        "columns": [
            {"key": key, "label": label, "group": group, "type": column_type}
            for key, label, group, column_type in COLUMNS
        ],
        "models": models,
    }


def write_data_file(data, output_path):
    body = json.dumps(data, ensure_ascii=False, indent=2)
    content = (
        '// Generated by refresh_aa_data.py. Everything after "window.AA_DATA = " is plain JSON.\n'
        f"window.AA_DATA = {body};\n"
    )
    output_path.write_text(content, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=pathlib.Path, help="saved HTML of the leaderboard page (skips the download)")
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT, help="file to merge into (default: aa-data.js)")
    parser.add_argument("--date", default=datetime.date.today().isoformat(), help="capture date, YYYY-MM-DD (default: today)")
    args = parser.parse_args()

    if args.input:
        html = args.input.read_text(encoding="utf-8")
    else:
        print(f"Downloading {SOURCE_URL} ...")
        html = download_page(SOURCE_URL)

    raw_models, catalog = extract_page_data(html)
    data = build_data(raw_models, catalog, read_existing_models(args.output), args.date)

    write_data_file(data, args.output)
    models = data["models"]
    deprecated_count = sum(1 for model in models if model["deprecated"] and not model.get("retired"))
    retired_count = sum(1 for model in models if model.get("retired"))
    print(
        f"Wrote {len(models)} models ({len(raw_models)} on the page, {deprecated_count} deprecated, "
        f"{retired_count} retired) and {len(data['columns'])} columns to {args.output}"
    )


if __name__ == "__main__":
    main()
