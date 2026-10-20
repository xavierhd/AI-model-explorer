#!/usr/bin/env python3
"""Rebuild aa-data.js (window.AA_DATA) from the Artificial Analysis leaderboard.

The leaderboard page embeds its table data as a JSON "models" array inside the
Next.js payload of the HTML. This script downloads the page (or reads a saved
copy), extracts that array, keeps the models shown in the table (not
deprecated) and writes aa-data.js next to this script.

Usage:
    python refresh_aa_data.py                     # download and rebuild
    python refresh_aa_data.py --input page.html   # use a saved copy of the page
    python refresh_aa_data.py --output other.js   # write somewhere else

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


def extract_models(html):
    """Return the largest array of model objects carrying leaderboard metrics.

    The array's key has changed over time ("models", "initialModels"), so any
    array of objects starting with "slug" is considered.
    """
    text = unescape_payload(html)
    decoder = json.JSONDecoder()
    marker = ':[{"slug"'
    best = None
    position = text.find(marker)
    while position >= 0:
        try:
            candidate, _ = decoder.raw_decode(text, position + 1)
        except json.JSONDecodeError:
            candidate = None
        is_leaderboard = (
            isinstance(candidate, list)
            and candidate
            and isinstance(candidate[0], dict)
            and "intelligenceIndex" in candidate[0]
            and "shortName" in candidate[0]
        )
        if is_leaderboard and (best is None or len(candidate) > len(best)):
            best = candidate
        position = text.find(marker, position + 1)
    if best is None:
        raise ValueError("Leaderboard models array not found in the page (site layout may have changed).")
    return best


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
        "creator": source["modelCreatorName"],
        "license": "Open" if source.get("isOpenWeights") else "Proprietary",
        "intelligenceEstimated": bool(source.get("intelligenceIndexIsEstimated")),
    }
    for key, _label, _group, column_type in COLUMNS:
        value = convert_value(source.get(key), column_type)
        if value is not None:
            model[key] = value
    return model


def build_data(raw_models):
    listed = [model for model in raw_models if not model.get("deprecated")]
    listed.sort(key=lambda model: -(model.get("intelligenceIndex") or -1))

    missing_keys = [key for key, *_ in COLUMNS if not any(key in model for model in listed)]
    if missing_keys:
        print(f"Warning: columns missing from the page data: {', '.join(missing_keys)}", file=sys.stderr)

    return {
        "source": SOURCE_URL,
        "capturedAt": datetime.date.today().isoformat(),
        "notes": NOTES,
        "columns": [
            {"key": key, "label": label, "group": group, "type": column_type}
            for key, label, group, column_type in COLUMNS
        ],
        "models": [build_model(model) for model in listed],
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
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT, help="file to write (default: aa-data.js)")
    args = parser.parse_args()

    if args.input:
        html = args.input.read_text(encoding="utf-8")
    else:
        print(f"Downloading {SOURCE_URL} ...")
        html = download_page(SOURCE_URL)

    data = build_data(extract_models(html))
    if not data["models"]:
        sys.exit("No models found; aa-data.js was not changed.")

    write_data_file(data, args.output)
    print(f"Wrote {len(data['models'])} models and {len(data['columns'])} columns to {args.output}")


if __name__ == "__main__":
    main()
