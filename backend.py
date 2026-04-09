"""
Smart Dairy Monitor — Local Wokwi-Faithful Simulator
====================================================
Reads sensor initial values directly from diagram.json (exactly as Wokwi does)
and simulates the ESP32 sketch logic locally — no cloud, no compiler needed.

Sensor mapping (from diagram.json → sketch):
  temp1  (wokwi-ds18b20)          → DS18B20 milk temperature
  dht1   (wokwi-dht22)            → DHT22 air temp + humidity
  pot1   (wokwi-potentiometer)    → ADC pin 34 → pH calculation
  gas1   (wokwi-gas-sensor)       → ADC pin 33 → gas/spoilage
  ldr1   (wokwi-photoresistor)    → ADC pin 32 → turbidity
  cell1  (wokwi-hx711)            → HX711 load cell → weight

Interactive sliders on the dashboard override any sensor value in real-time.
"""

import asyncio
import json
import math
import random
import time
from contextlib import asynccontextmanager
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ─────────────────────────────────────────────────────────────────────────────
# Parse diagram.json for initial sensor values  (mirrors Wokwi part attrs)
# ─────────────────────────────────────────────────────────────────────────────
def load_diagram_sensors(path: str = "diagram.json") -> Dict:
    try:
        with open(path) as f:
            diagram = json.load(f)
    except FileNotFoundError:
        print(f"[WARN] {path} not found — using defaults")
        return {}

    parts = {p["id"]: p for p in diagram.get("parts", [])}

    def attr(part_id, key, default):
        return parts.get(part_id, {}).get("attrs", {}).get(key, default)

    return {
        # Digital sensors — exact values from diagram.json attrs
        "milk_temp_base": float(attr("temp1", "temperature", "6.3")),
        "air_temp_base":  float(attr("dht1",  "temperature", "7.2")),
        "humidity_base":  float(attr("dht1",  "humidity",    "45")),
        # HX711 — type gives max range; start at a representative loaded weight
        "hx711_type":     attr("cell1", "type", "5kg"),
    }

DIAGRAM = load_diagram_sensors()

# ─────────────────────────────────────────────────────────────────────────────
# Simulator State
# ─────────────────────────────────────────────────────────────────────────────
# Base values come directly from diagram.json
BASE = {
    "milk_temp":  DIAGRAM.get("milk_temp_base", 6.3),
    "air_temp":   DIAGRAM.get("air_temp_base",  7.2),
    "humidity":   DIAGRAM.get("humidity_base",  45.0),
    # Wokwi potentiometer default: knob centered → ADC ≈ 2048/4095 → pH ≈ 7.0
    # But user can override this via slider
    "ph":         7.0,
    # Wokwi gas sensor: clean air ≈ low ADC; polluted ≈ high ADC
    "gas":        350,
    # Wokwi LDR/photoresistor: normal indoor light → ADC ≈ 2400
    "turbidity":  2400,
    # HX711 load cell after tare — representative dairy product weight (g)
    "weight":     650.0,
}

# User overrides from dashboard sliders (None = use simulation)
overrides: Dict[str, float] = {}

product = "MILK"
history: List[dict] = []
connected_clients: Set[WebSocket] = set()
_tick = 0


# ─────────────────────────────────────────────────────────────────────────────
# Core simulation — mirrors sketch.ino exactly
# ─────────────────────────────────────────────────────────────────────────────
def simulate_tick() -> dict:
    """One simulation step. User overrides take full precedence over base drift."""
    global _tick
    t = _tick
    _tick += 1

    # Realistic slow drift around the diagram.json base values
    # amplitude and period tuned to match Wokwi sensor behavior
    def drift(base: float, amp: float, period: float, noise: float) -> float:
        return base + amp * math.sin(2 * math.pi * t / period) + random.uniform(-noise, noise)

    # ── Sensor readings ────────────────────────────────────────────────────
    # Each sensor uses override if set, else drifts around its base value
    milk_temp = overrides.get(
        "milk_temp",
        round(drift(BASE["milk_temp"], 0.6, 20, 0.1), 2)
    )
    air_temp = overrides.get(
        "air_temp",
        round(drift(BASE["air_temp"], 1.5, 30, 0.2), 2)
    )
    humidity = overrides.get(
        "humidity",
        round(drift(BASE["humidity"], 4.0, 25, 0.5), 2)
    )
    # pH derived from potentiometer ADC (0..4095 → 0..14) — matches sketch
    ph_raw = overrides.get(
        "ph",
        round(drift(BASE["ph"], 0.3, 28, 0.05), 2)
    )
    ph = round(max(0.0, min(14.0, ph_raw)), 2)

    gas = int(overrides.get(
        "gas",
        drift(BASE["gas"], 120, 17, 40)
    ))
    turbidity = int(overrides.get(
        "turbidity",
        drift(BASE["turbidity"], 250, 22, 60)
    ))
    weight = round(overrides.get(
        "weight",
        drift(BASE["weight"], 80, 55, 15)
    ), 1)

    # ── Product thresholds — exact copy of sketch.ino ──────────────────────
    th_map = {
        "MILK":   dict(t_min=2,  t_max=6,  ph_min=6.5, ph_max=6.8),
        "CURD":   dict(t_min=4,  t_max=8,  ph_min=4.0, ph_max=4.6),
        "CHEESE": dict(t_min=4,  t_max=10, ph_min=5.0, ph_max=6.0),
        "BUTTER": dict(t_min=5,  t_max=10, ph_min=5.8, ph_max=6.5),
    }
    th = th_map.get(product, th_map["MILK"])
    t_min, t_max     = th["t_min"],  th["t_max"]
    ph_min, ph_max   = th["ph_min"], th["ph_max"]

    # ── Scoring — exact copy of sketch.ino ────────────────────────────────
    danger_score  = 0
    warning_score = 0

    if milk_temp < t_min or milk_temp > t_max:          danger_score  += 3
    elif milk_temp < t_min + 1 or milk_temp > t_max - 1: warning_score += 2

    if gas > 2200:      danger_score  += 3
    elif gas > 1600:    warning_score += 2

    if ph < ph_min or ph > ph_max:               danger_score  += 2
    elif ph < ph_min + 0.2 or ph > ph_max - 0.2: warning_score += 1

    if turbidity < 1300:     danger_score  += 2
    elif turbidity < 2000:   warning_score += 1

    if weight < 100 or weight > 2000: warning_score += 1
    if air_temp > 35 or humidity > 80: warning_score += 1

    # ── Final status ───────────────────────────────────────────────────────
    if danger_score >= 3:
        status = "DANGER"
    elif warning_score >= 2:
        status = "WARNING"
    else:
        status = "SAFE"

    return {
        "timestamp":     round(time.time() * 1000),
        "product":       product,
        "milk_temp":     milk_temp,
        "air_temp":      air_temp,
        "humidity":      humidity,
        "ph":            ph,
        "gas":           gas,
        "turbidity":     turbidity,
        "weight":        weight,
        "danger_score":  danger_score,
        "warning_score": warning_score,
        "status":        status,
        "led_red":       status == "DANGER",
        "led_yellow":    status == "WARNING",
        "led_green":     status == "SAFE",
        "buzzer":        status == "DANGER",
        # metadata
        "source":        "local_sim",
        "tick":          t,
        "overrides":     list(overrides.keys()),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Broadcast loop (every 2 s — same as sketch timer)
# ─────────────────────────────────────────────────────────────────────────────
async def broadcast_loop():
    while True:
        data = simulate_tick()
        history.append(data)
        if len(history) > 60:
            history.pop(0)

        payload = json.dumps(data)
        dead = set()
        for ws in connected_clients:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.add(ws)
        connected_clients.difference_update(dead)

        await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("=" * 58)
    print("  Smart Dairy Monitor — Local Simulator")
    print(f"  Diagram values loaded:")
    print(f"    DS18B20 milk temp : {BASE['milk_temp']} °C")
    print(f"    DHT22 air temp    : {BASE['air_temp']} °C")
    print(f"    DHT22 humidity    : {BASE['humidity']} %")
    print(f"    pH (pot default)  : {BASE['ph']}")
    print(f"    Gas (clean air)   : {BASE['gas']} ADC")
    print(f"    Turbidity (clear) : {BASE['turbidity']} ADC")
    print(f"    Weight (tared)    : {BASE['weight']} g")
    print(f"  Dashboard: http://localhost:8000/static/index.html")
    print("=" * 58)
    task = asyncio.create_task(broadcast_loop())
    yield
    task.cancel()


# ─────────────────────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────────────────────
app = FastAPI(title="Smart Dairy Monitor — Local Simulator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="frontend"), name="static")


# ─────────────────────────────────────────────────────────────────────────────
# REST Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/latest")
def get_latest():
    if history:
        return JSONResponse(history[-1])
    return JSONResponse(simulate_tick())


@app.get("/api/history")
def get_history():
    return JSONResponse(history)


@app.get("/api/config")
def get_config():
    """Returns diagram.json base values + current overrides for the UI."""
    return {
        "base":      BASE,
        "overrides": overrides,
        "product":   product,
        "ranges": {
            "milk_temp":  {"min": -10, "max": 30,   "step": 0.1,  "unit": "°C"},
            "air_temp":   {"min": 0,   "max": 50,   "step": 0.1,  "unit": "°C"},
            "humidity":   {"min": 0,   "max": 100,  "step": 0.5,  "unit": "%"},
            "ph":         {"min": 0,   "max": 14,   "step": 0.01, "unit": "pH"},
            "gas":        {"min": 0,   "max": 4095, "step": 10,   "unit": "ADC"},
            "turbidity":  {"min": 0,   "max": 4095, "step": 10,   "unit": "ADC"},
            "weight":     {"min": 0,   "max": 5000, "step": 10,   "unit": "g"},
        }
    }


class SensorOverride(BaseModel):
    sensor: str
    value:  Optional[float] = None  # None = release override (go back to sim)


@app.post("/api/override")
async def set_override(body: SensorOverride):
    """Set or release a sensor override from the dashboard sliders."""
    valid = {"milk_temp", "air_temp", "humidity", "ph", "gas", "turbidity", "weight"}
    if body.sensor not in valid:
        return JSONResponse({"error": f"Unknown sensor '{body.sensor}'"}, status_code=400)

    if body.value is None:
        overrides.pop(body.sensor, None)
        msg = f"Released override for {body.sensor}"
    else:
        overrides[body.sensor] = body.value
        msg = f"Overriding {body.sensor} = {body.value}"

    # Immediately push a tick so the dashboard updates without waiting 2s
    data = simulate_tick()
    history.append(data)
    if len(history) > 60:
        history.pop(0)
    payload = json.dumps(data)
    dead = set()
    for ws in connected_clients:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    connected_clients.difference_update(dead)

    return {"ok": True, "message": msg, "overrides": overrides}


@app.post("/api/product/{name}")
async def set_product(name: str):
    global product
    name = name.upper()
    if name not in ("MILK", "CURD", "CHEESE", "BUTTER"):
        return JSONResponse({"error": "Unknown product"}, status_code=400)
    product = name
    # Immediately broadcast
    data = simulate_tick()
    history.append(data)
    payload = json.dumps(data)
    for ws in list(connected_clients):
        try:
            await ws.send_text(payload)
        except Exception:
            pass
    return {"product": product}


@app.post("/api/reset")
async def reset_overrides():
    """Release all overrides — sensors return to diagram.json base values."""
    overrides.clear()
    return {"ok": True, "message": "All overrides cleared — back to diagram.json values"}


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket
# ─────────────────────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    # Send history immediately
    for h in history:
        await ws.send_text(json.dumps(h))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        connected_clients.discard(ws)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend:app", host="0.0.0.0", port=8000, reload=True)
