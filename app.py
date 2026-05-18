"""
HERALD — Health & Epidemic Risk Alerts from Live Drug Data
Flask REST API Backend
"""

import os
import json
import pandas as pd
import numpy as np
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from datetime import datetime

app = Flask(__name__)
CORS(app)

# ── Town metadata (coordinates + climate labels) ───────────────────────────
TOWNS_META = [
    {"town": "Kisumu",     "county": "Kisumu",       "lat": -0.0917, "lon": 34.7680, "order": 1,
     "climate": "Hot & Humid",         "climate_icon": "", "elevation_m": 1131,
     "top_risks": ["Malaria", "Cholera", "Typhoid"],
     "travel_tip": "High malaria zone. Use repellent, sleep under treated nets."},
    {"town": "Vihiga",     "county": "Vihiga",        "lat": 0.0796,  "lon": 34.7238, "order": 2,
     "climate": "Wet Highlands",        "climate_icon": "", "elevation_m": 1530,
     "top_risks": ["Respiratory", "Typhoid", "GI Infections"],
     "travel_tip": "Dense population, wet climate. Respiratory infections common."},
    {"town": "Kericho",    "county": "Kericho",       "lat": -0.3686, "lon": 35.2863, "order": 3,
     "climate": "Cool & Damp",          "climate_icon": "🌫", "elevation_m": 2010,
     "top_risks": ["Respiratory", "Pneumonia", "Flu"],
     "travel_tip": "Tea highland cold. Pack a warm layer, respiratory risk elevated."},
    {"town": "Nakuru",     "county": "Nakuru",        "lat": -0.3031, "lon": 36.0800, "order": 4,
     "climate": "Rift Valley Temperate","climate_icon": "", "elevation_m": 1850,
     "top_risks": ["GI Infections", "Flu", "Skin Infections"],
     "travel_tip": "Moderate risk zone. Stay hydrated, water quality varies."},
    {"town": "Nairobi",    "county": "Nairobi",       "lat": -1.2921, "lon": 36.8219, "order": 5,
     "climate": "Urban Mixed",          "climate_icon": "", "elevation_m": 1795,
     "top_risks": ["Typhoid", "GI Infections", "Respiratory"],
     "travel_tip": "Urban disease mix. Avoid uncooked street food. GI risk moderate."},
    {"town": "Machakos",   "county": "Machakos",      "lat": -1.5177, "lon": 37.2634, "order": 6,
     "climate": "Semi-Arid",            "climate_icon": "", "elevation_m": 1600,
     "top_risks": ["GI Infections", "Respiratory", "Malaria"],
     "travel_tip": "Semi-arid heat. Carry water, GI risk from dust and water quality."},
    {"town": "Emali",      "county": "Makueni",       "lat": -2.0843, "lon": 37.5031, "order": 7,
     "climate": "Hot & Dry Plains",     "climate_icon": "☀",  "elevation_m": 1060,
     "top_risks": ["GI Infections", "Dehydration", "Malaria"],
     "travel_tip": "Very hot and dry. Hydration critical. Watch for GI spikes."},
    {"town": "Voi",        "county": "Taita-Taveta",  "lat": -3.3967, "lon": 38.5560, "order": 8,
     "climate": "Hot Savannah",         "climate_icon": "", "elevation_m": 580,
     "top_risks": ["Malaria", "GI Infections", "Typhoid"],
     "travel_tip": "Malaria-endemic savannah. Net and repellent essential overnight."},
    {"town": "Mariakani",  "county": "Kilifi",        "lat": -3.8785, "lon": 39.4662, "order": 9,
     "climate": "Coastal Hinterland",   "climate_icon": "", "elevation_m": 155,
     "top_risks": ["Malaria", "Respiratory", "GI Infections"],
     "travel_tip": "High malaria zone approaching coast. Take prophylaxis seriously."},
    {"town": "Mombasa",    "county": "Mombasa",       "lat": -4.0435, "lon": 39.6682, "order": 10,
     "climate": "Coastal Hot & Humid",  "climate_icon": "", "elevation_m": 17,
     "top_risks": ["Malaria", "Cholera", "Dengue Risk"],
     "travel_tip": "Highest malaria risk on the corridor. Coastal cholera risk. Take precautions."},
]

DRUG_INFO = {
    "Coartem":     {"signal": "malaria",     "weight": 0.95, "description": "Antimalarial — very specific malaria marker"},
    "Panadol":     {"signal": "malaria",     "weight": 0.40, "description": "Paracetamol — general fever proxy"},
    "Flagyl":      {"signal": "gi",          "weight": 0.85, "description": "Metronidazole — GI bacterial infections"},
    "ORS":         {"signal": "gi",          "weight": 0.80, "description": "Oral rehydration — diarrhoea/dehydration"},
    "Imodium":     {"signal": "gi",          "weight": 0.70, "description": "Anti-diarrhoeal — acute GI signal"},
    "Septrin":     {"signal": "respiratory", "weight": 0.80, "description": "Co-trimoxazole — bacterial respiratory"},
    "Amoxicillin": {"signal": "respiratory", "weight": 0.75, "description": "Broad-spectrum — respiratory/pneumonia"},
    "Piriton":     {"signal": "respiratory", "weight": 0.50, "description": "Antihistamine — allergy/upper respiratory"},
}

ALERT_ADVICE = {
    "GREEN": {
        "emoji": "🟢", "label": "All Clear",
        "summary": "No elevated disease signals this week. Normal precautions apply.",
        "actions": ["✔ Carry standard first aid kit", "✔ Stay hydrated", "✔ Normal food and water precautions"]
    },
    "AMBER": {
        "emoji": "🟡", "label": "Advisory",
        "summary": "Moderate disease signal detected. Elevated precautions advised.",
        "actions": ["⚠ Apply insect repellent especially at dusk", "⚠ Use bottled or boiled water only",
                    "⚠ Carry basic medications — ORS, antihistamine", "⚠ Monitor symptoms closely for 48hrs"]
    },
    "RED": {
        "emoji": "🔴", "label": "High Alert",
        "summary": "Significant disease spike detected. Strong precautions essential.",
        "actions": ["🚨 Sleep under a treated mosquito net", "🚨 Avoid street food and uncooked produce",
                    "🚨 Carry antimalarials / prescription medications", "🚨 Know the nearest hospital location",
                    "🚨 Seek medical advice before extended stay"]
    }
}

# ── Data loading ───────────────────────────────────────────────────────────
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

def load_data():
    scored_path = os.path.join(DATA_DIR, "herald_scored_weekly.csv")
    sales_path  = os.path.join(DATA_DIR, "herald_drug_sales.csv")
    scored = pd.read_csv(scored_path)
    sales  = pd.read_csv(sales_path)
    scored["week_start"] = pd.to_datetime(scored["week_start"])
    sales["week_start"]  = pd.to_datetime(sales["week_start"])
    return scored, sales

scored_df, sales_df = load_data()
ALL_WEEKS   = sorted(scored_df["week_start"].unique())
LATEST_WEEK = ALL_WEEKS[-1]

# ── Find the peak-risk week ─────────────────────────────────────────────────
# Average composite score across all towns per week, then take the argmax.
# This is the week with the most widespread outbreak activity — the best
# week to show on a demo so RED/AMBER alerts are immediately visible.
_weekly_avg = scored_df.groupby("week_start")["score_composite"].mean()
PEAK_WEEK   = _weekly_avg.idxmax()  # pandas Timestamp

# ── Helper ─────────────────────────────────────────────────────────────────
def town_meta(name):
    return next((t for t in TOWNS_META if t["town"] == name), {})

def score_row_to_dict(row):
    return {
        "score_malaria":     round(float(row.get("score_malaria", 0)), 3),
        "score_gi":          round(float(row.get("score_gi", 0)), 3),
        "score_respiratory": round(float(row.get("score_respiratory", 0)), 3),
        "score_composite":   round(float(row.get("score_composite", 0)), 3),
        "alert_level":       str(row.get("alert_level", "GREEN")),
        "temp_c":            round(float(row.get("temp_c", 20)), 1),
        "rainfall_mm":       round(float(row.get("rainfall_mm", 50)), 1),
        "humidity_pct":      round(float(row.get("humidity_pct", 60)), 1),
    }

# ══════════════════════════════════════════════════════════════════════════
# ROUTES
# ══════════════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    return render_template("index.html")


# ── GET /api/meta ──────────────────────────────────────────────────────────
@app.route("/api/meta")
def get_meta():
    """
    Return global dataset metadata so the frontend can set itself up:
      - latest_week : the most recent week in the dataset (calendar end)
      - peak_week   : the week with the highest avg composite score across
                      all towns — this is the most dramatic outbreak week
                      and is used as the default 'Peak Risk' view
      - total_weeks : how many weekly snapshots exist (slider range)

    The frontend uses latest_week and peak_week to pre-populate the two
    toggle buttons; it never has to compute these itself.
    """
    return jsonify({
        "latest_week":  str(LATEST_WEEK)[:10],
        "peak_week":    str(PEAK_WEEK)[:10],
        "total_weeks":  len(ALL_WEEKS),
        "peak_avg_score": round(float(_weekly_avg.max()), 3),
    })


# ── GET /api/towns ─────────────────────────────────────────────────────────
@app.route("/api/towns")
def get_towns():
    """
    Return all 10 towns with their alert levels and scores for a given week.

    Query params (all optional — defaults to latest week):
      ?week=YYYY-MM-DD   — specific week to query
      ?mode=latest       — use the most recent week in the dataset
      ?mode=peak         — use the peak-risk week (most widespread outbreak)

    Mode takes priority over an explicit week string if both are supplied.
    The frontend sends ?mode=latest or ?mode=peak from the toggle buttons,
    and ?week=YYYY-MM-DD from the timeline slider.
    """
    mode     = request.args.get("mode", "")      # "latest" | "peak" | ""
    week_str = request.args.get("week", "")

    # Resolve which week to use
    if mode == "peak":
        week = PEAK_WEEK
    elif mode == "latest":
        week = LATEST_WEEK
    elif week_str:
        try:
            week = pd.to_datetime(week_str)
        except Exception:
            week = LATEST_WEEK   # fallback on bad input
    else:
        week = LATEST_WEEK       # default

    result = []
    for meta in TOWNS_META:
        # Look up scored row for this town + week
        row = scored_df[
            (scored_df["town"]       == meta["town"]) &
            (scored_df["week_start"] == week)
        ]

        if len(row):
            scores = score_row_to_dict(row.iloc[0])
        else:
            # Fallback if this exact week isn't in the dataset
            scores = {
                "score_malaria": 0, "score_gi": 0,
                "score_respiratory": 0, "score_composite": 0,
                "alert_level": "GREEN",
                "temp_c": 22, "rainfall_mm": 50, "humidity_pct": 60,
            }

        advice = ALERT_ADVICE[scores["alert_level"]]
        result.append({
            **meta,
            **scores,
            "advice": advice,
            "week":   str(week)[:10],
        })
    return jsonify(result)


# ── GET /api/town/<name> ───────────────────────────────────────────────────
@app.route("/api/town/<name>")
def get_town(name):
    """
    Return full detail for one town: current scores, 12-week history,
    drug sales breakdown, climate, and traveller advice.

    Accepts the same ?mode= / ?week= params as /api/towns so that the
    right-hand detail panel always shows data for THE SAME WEEK that is
    displayed on the map — not always the latest week.

    Without this fix, clicking 'View Full Detail' on a Peak Risk bubble
    would show latest-week (all-GREEN) data in the panel, which is
    inconsistent with the alert colour on the map marker.
    """
    meta = town_meta(name)
    if not meta:
        return jsonify({"error": "Town not found"}), 404

    # ── Resolve the display week (same logic as /api/towns) ───────────────
    mode     = request.args.get("mode", "")
    week_str = request.args.get("week", "")

    if mode == "peak":
        display_week = PEAK_WEEK
    elif mode == "latest":
        display_week = LATEST_WEEK
    elif week_str:
        try:
            display_week = pd.to_datetime(week_str)
        except Exception:
            display_week = LATEST_WEEK
    else:
        display_week = LATEST_WEEK

    town_scored = scored_df[scored_df["town"] == name].sort_values("week_start")
    town_sales  = sales_df[sales_df["town"] == name]

    # ── 12-week history centred around the display week ───────────────────
    # Take the 6 weeks before and up to 5 weeks after display_week so the
    # sparkline always shows the selected week somewhere near the right end.
    # Fallback: just use the last 12 weeks of the full dataset.
    week_idx = town_scored[town_scored["week_start"] <= display_week].index
    if len(week_idx) >= 12:
        history_rows = town_scored.loc[week_idx[-12]:]    # last 12 up to display_week
    else:
        history_rows = town_scored.tail(12)

    history = []
    for _, row in history_rows.iterrows():
        history.append({
            "week":              str(row["week_start"])[:10],
            "score_malaria":     round(float(row["score_malaria"]), 3),
            "score_gi":          round(float(row["score_gi"]), 3),
            "score_respiratory": round(float(row["score_respiratory"]), 3),
            "score_composite":   round(float(row["score_composite"]), 3),
            "alert_level":       str(row["alert_level"]),
        })

    # ── Drug sales for the display week (not hardcoded to latest) ─────────
    week_sales   = town_sales[town_sales["week_start"] == display_week]
    drugs_latest = {}
    for _, row in week_sales.iterrows():
        drug = str(row["drug"])
        drugs_latest[drug] = {
            "units_sold":  int(row["units_sold"]),
            "signal":      str(row["signal"]),
            "weight":      float(DRUG_INFO.get(drug, {}).get("weight", 0.5)),
            "description": DRUG_INFO.get(drug, {}).get("description", ""),
        }

    # ── Current scores for the display week ───────────────────────────────
    current_row = town_scored[town_scored["week_start"] == display_week]
    current     = score_row_to_dict(current_row.iloc[0]) if len(current_row) else {}

    # Overall alert counts across the full 2-year history (for reference)
    alert_counts = town_scored["alert_level"].value_counts().to_dict()

    return jsonify({
        **meta,
        "current":       current,
        "display_week":  str(display_week)[:10],
        "advice":        ALERT_ADVICE.get(current.get("alert_level", "GREEN"), ALERT_ADVICE["GREEN"]),
        "history":       history,
        "drugs_latest":  drugs_latest,
        "alert_counts":  alert_counts,
        "weeks_tracked": len(town_scored),
    })


# ── GET /api/alerts/summary ────────────────────────────────────────────────
@app.route("/api/alerts/summary")
def alerts_summary():
    """High-level alert summary for current week."""
    latest = scored_df[scored_df["week_start"] == LATEST_WEEK]
    counts = latest["alert_level"].value_counts().to_dict()
    red_towns   = latest[latest["alert_level"] == "RED"]["town"].tolist()
    amber_towns = latest[latest["alert_level"] == "AMBER"]["town"].tolist()
    return jsonify({
        "week":        str(LATEST_WEEK)[:10],
        "total_towns": len(latest),
        "green":       counts.get("GREEN", 0),
        "amber":       counts.get("AMBER", 0),
        "red":         counts.get("RED", 0),
        "red_towns":   red_towns,
        "amber_towns": amber_towns,
    })


# ── GET /api/weeks ─────────────────────────────────────────────────────────
@app.route("/api/weeks")
def get_weeks():
    """Return list of all available weeks for the timeline slider."""
    return jsonify([str(w)[:10] for w in ALL_WEEKS])


# ── GET /api/journey ──────────────────────────────────────────────────────
@app.route("/api/journey")
def get_journey():
    """
    Return the 10 corridor towns in route order with their alert scores,
    ready for the animated journey simulation.

    Accepts the same ?mode= and ?week= params as /api/towns so that
    the journey simulation always runs on whatever week the map is
    currently showing (latest or peak).
    """
    mode     = request.args.get("mode", "")
    week_str = request.args.get("week", "")

    if mode == "peak":
        week = PEAK_WEEK
    elif mode == "latest":
        week = LATEST_WEEK
    elif week_str:
        try:
            week = pd.to_datetime(week_str)
        except Exception:
            week = LATEST_WEEK
    else:
        week = LATEST_WEEK

    result = []
    for meta in sorted(TOWNS_META, key=lambda t: t["order"]):
        row = scored_df[
            (scored_df["town"]       == meta["town"]) &
            (scored_df["week_start"] == week)
        ]
        if len(row):
            scores = score_row_to_dict(row.iloc[0])
        else:
            scores = {
                "alert_level": "GREEN", "score_composite": 0,
                "score_malaria": 0, "score_gi": 0, "score_respiratory": 0,
                "temp_c": 22, "rainfall_mm": 50, "humidity_pct": 60,
            }
        advice = ALERT_ADVICE[scores["alert_level"]]
        result.append({
            "order":        meta["order"],
            "town":         meta["town"],
            "county":       meta["county"],
            "lat":          meta["lat"],
            "lon":          meta["lon"],
            "climate":      meta["climate"],
            "climate_icon": meta["climate_icon"],
            "top_risks":    meta["top_risks"],
            "travel_tip":   meta["travel_tip"],
            **scores,
            "advice": advice,
        })
    return jsonify(result)


# ── GET /api/heatmap ──────────────────────────────────────────────────────
@app.route("/api/heatmap")
def get_heatmap():
    """Return composite scores for all towns across all weeks (for heatmap chart)."""
    pivot = scored_df.pivot_table(
        index="week_start", columns="town", values="score_composite"
    ).reset_index()
    pivot["week_start"] = pivot["week_start"].astype(str).str[:10]
    # Sample every 4th week
    pivot = pivot.iloc[::4]
    return jsonify(pivot.to_dict(orient="records"))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
