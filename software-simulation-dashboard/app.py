
import streamlit as st
import requests
import pandas as pd
from streamlit_autorefresh import st_autorefresh

st.set_page_config(page_title="Milk Dashboard", layout="wide")

st.title("🥛 Smart Dairy Monitoring Dashboard")

# Auto refresh every 2 seconds (NO flicker)
st_autorefresh(interval=2000, key="datarefresh")

# Store history
if "history" not in st.session_state:
    st.session_state.history = []

# ---------------- PRODUCT LOGIC ----------------
def get_status(data, product):
    milkTemp = data["milkTemp"]
    pH = data["pH"]
    gas = data["gas"]
    turbidity = data["turbidity"]

    if product == "Milk":
        if milkTemp > 35 or pH < 6 or pH > 8 or gas > 3500 or turbidity < 700:
            return "DANGER"
        elif milkTemp > 30 or gas > 2500 or turbidity < 1000:
            return "WARNING"
        else:
            return "SAFE"

    elif product == "Curd":
        if pH > 5 or gas > 3000:
            return "DANGER"
        elif pH > 4.5:
            return "WARNING"
        else:
            return "SAFE"

    elif product == "Paneer":
        if milkTemp > 20 or gas > 3000:
            return "DANGER"
        elif milkTemp > 15:
            return "WARNING"
        else:
            return "SAFE"

    elif product == "Butter":
        if milkTemp > 25:
            return "DANGER"
        elif milkTemp > 20:
            return "WARNING"
        else:
            return "SAFE"

# -------- ANIMATION --------
def render_container_animation(status: str):
    fill_height = "0%"
    fill_text = ""

    if status == "SAFE":
        fill_height = "100%"
        fill_text = "Full and healthy"
    elif status == "WARNING":
        fill_height = "50%"
        fill_text = "Half full — monitor soon"
    else:
        fill_height = "10%"
        fill_text = "Almost empty — danger"

    status_class = status.lower()
    html = """
    <style>
    .milk-card {{ width: 240px; margin: auto 0; }}
    .milk-box {{ position: relative; width: 180px; height: 200px; margin: 0 auto; }}
    .milk-body {{
        position: absolute;
        left: 20px;
        top: 40px;
        width: 140px;
        height: 140px;
        background: rgba(255,255,255,0.95);
        border: 4px solid #c4ccd8;
        border-radius: 0 0 24px 24px;
        overflow: hidden;
        box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06);
    }}
    .milk-fill {{
        position: absolute;
        left: 0;
        bottom: 0;
        width: 100%;
        height: {fill_height};
        background: linear-gradient(180deg, rgba(255,241,143,0.95) 0%, rgba(255,199,67,0.95) 45%, rgba(255,217,102,0.95) 100%);
        box-shadow: inset 0 0 20px rgba(255,205,38,0.25);
        transition: height 0.35s ease;
    }}
    .milk-lid {{
        position: absolute;
        left: 4px;
        top: 8px;
        width: 172px;
        height: 36px;
        background: linear-gradient(180deg, #d8e3f2 0%, #a8b7ce 100%);
        border: 4px solid #c4ccd8;
        border-radius: 22px 22px 8px 8px;
    }}
    .milk-text {{ text-align: center; margin-top: 8px; font-weight: 600; color: #344054; }}
    .status-safe .milk-lid {{ background: #dff3dc; border-color: #8cc47e; }}
    .status-warning .milk-lid {{ background: #fff3cd; border-color: #d8a04a; }}
    .status-danger .milk-lid {{ background: #fde2e2; border-color: #d14949; }}
    .status-safe .milk-body {{ border-color: #81b26a; }}
    .status-warning .milk-body {{ border-color: #d29729; }}
    .status-danger .milk-body {{ border-color: #b53333; }}
    </style>
    <div class="milk-card status-{status_class}">
        <div class="milk-box">
            <div class="milk-lid"></div>
            <div class="milk-body">
                <div class="milk-fill"></div>
            </div>
        </div>
        <div class="milk-text">{fill_text}</div>
    </div>
    """.format(
        fill_height=fill_height,
        status_class=status_class,
        fill_text=fill_text,
    )
    st.markdown(html, unsafe_allow_html=True)

# -------- DROPDOWN --------
product = st.selectbox(
    "Select Dairy Product",
    ["Milk", "Curd", "Paneer", "Butter"]
)

try:
    res = requests.get("http://127.0.0.1:5000/get")
    data = res.json()

    if data:
        # Save history
        st.session_state.history.append(data)
        if len(st.session_state.history) > 50:
            st.session_state.history.pop(0)

        df = pd.DataFrame(st.session_state.history)

        # -------- STATUS --------
        status = get_status(data, product)

        if status == "SAFE":
            st.success(f"{product} STATUS: SAFE")
        elif status == "WARNING":
            st.warning(f"{product} STATUS: WARNING")
        else:
            st.error(f"{product} STATUS: DANGER")

        render_container_animation(status)

        st.subheader("📊 Live Sensor Values")

        col1, col2, col3, col4 = st.columns(4)

        col1.metric("Milk Temp (°C)", round(data["milkTemp"], 2))
        col1.metric("Air Temp (°C)", round(data["airTemp"], 2))

        col2.metric("pH Level", round(data["pH"], 2))
        col2.metric("Humidity (%)", round(data["humidity"], 2))

        col3.metric("Gas Level", data["gas"])
        col3.metric("Turbidity", data["turbidity"])

        col4.metric("Weight (kg)", round(data["weight"], 2))

        # -------- GRAPHS --------
        st.subheader("📈 Live Trends")

        g1, g2 = st.columns(2)

        with g1:
            st.line_chart(df[["milkTemp", "airTemp"]])

        with g2:
            st.line_chart(df[["pH", "humidity"]])

        g3, g4 = st.columns(2)

        with g3:
            st.line_chart(df[["gas"]])

        with g4:
            st.line_chart(df[["turbidity"]])

    else:
        st.info("Waiting for sensor data...")

except:
    st.info("Connecting to server...")