/*
  Smart Dairy Monitor — ESP32 (Wokwi)
  Sends sensor data as JSON to a local FastAPI backend via HTTP POST.
  Run the backend first: python3 backend.py
  Then open this sketch in Wokwi (https://wokwi.com) and hit Start Simulation.
  The backend URL below uses the Wokwi virtual network host gateway.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include "HX711.h"
#include <OneWire.h>
#include <DallasTemperature.h>

// ---------- WIFI ----------
// In Wokwi, "Wokwi-GUEST" connects to a virtual WiFi that can reach
// your host machine at 10.0.2.2 (QEMU user-mode network gateway).
char ssid[] = "Wokwi-GUEST";
char pass[] = "";

// Change this IP to your computer's local network IP if running outside Wokwi.
// Inside Wokwi simulation the host machine is reachable at 10.0.2.2.
const char* SERVER_URL = "http://10.0.2.2:8000/api/push";

// ---------- OLED ----------
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// ---------- DHT ----------
#define DHTPIN 4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

// ---------- DS18B20 ----------
#define ONE_WIRE_BUS 5
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

// ---------- HX711 ----------
#define DT  18
#define SCK 19
HX711 scale;

// ---------- ANALOG ----------
#define PH_PIN        34
#define GAS_PIN       33
#define TURBIDITY_PIN 32

// ---------- OUTPUT ----------
#define RED_LED    25
#define YELLOW_LED 26
#define GREEN_LED  27
#define BUZZER     14

String product = "MILK";

// ---------- PRODUCT-BASED THRESHOLDS ----------
void getThresholds(float &t_min, float &t_max, float &ph_min, float &ph_max) {
  if (product == "MILK")        { t_min=2;  t_max=6;  ph_min=6.5; ph_max=6.8; }
  else if (product == "CURD")   { t_min=4;  t_max=8;  ph_min=4.0; ph_max=4.6; }
  else if (product == "CHEESE") { t_min=4;  t_max=10; ph_min=5.0; ph_max=6.0; }
  else                          { t_min=5;  t_max=10; ph_min=5.8; ph_max=6.5; }
}

// ---------- SENSOR + SEND FUNCTION ----------
void sendSensorData() {
  float airTemp  = dht.readTemperature();
  float humidity = dht.readHumidity();

  sensors.requestTemperatures();
  float milkTemp = sensors.getTempCByIndex(0);

  if (isnan(airTemp) || milkTemp == -127.0) {
    Serial.println("Sensor Error");
    return;
  }

  float pH      = (analogRead(PH_PIN) / 4095.0) * 14.0;
  int   gas     = analogRead(GAS_PIN);
  int   turbidity = analogRead(TURBIDITY_PIN);
  float weight  = scale.get_units(10);

  // Thresholds
  float t_min, t_max, ph_min, ph_max;
  getThresholds(t_min, t_max, ph_min, ph_max);

  // Scoring
  int dangerScore = 0, warningScore = 0;

  if (milkTemp < t_min || milkTemp > t_max)          dangerScore  += 3;
  else if (milkTemp < t_min+1 || milkTemp > t_max-1) warningScore += 2;

  if (gas > 2200)       dangerScore  += 3;
  else if (gas > 1600)  warningScore += 2;

  if (pH < ph_min || pH > ph_max)              dangerScore  += 2;
  else if (pH < ph_min+0.2 || pH > ph_max-0.2) warningScore += 1;

  if (turbidity < 1300)        dangerScore  += 2;
  else if (turbidity < 2000)   warningScore += 1;

  if (weight < 100 || weight > 2000) warningScore += 1;
  if (airTemp > 35 || humidity > 80) warningScore += 1;

  String status;
  if (dangerScore >= 3)       status = "DANGER";
  else if (warningScore >= 2) status = "WARNING";
  else                        status = "SAFE";

  // ---------- LED / BUZZER ----------
  digitalWrite(RED_LED, LOW);
  digitalWrite(YELLOW_LED, LOW);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(BUZZER, LOW);

  if (status == "DANGER")      { digitalWrite(RED_LED, HIGH);    digitalWrite(BUZZER, HIGH); }
  else if (status == "WARNING")  digitalWrite(YELLOW_LED, HIGH);
  else                           digitalWrite(GREEN_LED, HIGH);

  // ---------- SERIAL ----------
  Serial.println("-----");
  Serial.print("Product: ");   Serial.println(product);
  Serial.print("MilkTemp: ");  Serial.println(milkTemp, 2);
  Serial.print("AirTemp: ");   Serial.println(airTemp, 2);
  Serial.print("Humidity: ");  Serial.println(humidity, 2);
  Serial.print("pH: ");        Serial.println(pH, 2);
  Serial.print("Gas: ");       Serial.println(gas);
  Serial.print("Turbidity: "); Serial.println(turbidity);
  Serial.print("Weight: ");    Serial.println(weight, 1);
  Serial.print("Status: ");    Serial.println(status);

  // ---------- OLED ----------
  display.clearDisplay();
  display.setCursor(0, 0);
  display.setTextSize(1);
  display.println("Smart Dairy Monitor");
  display.print("Prod: "); display.println(product);
  display.print("MilkT: "); display.println(milkTemp);
  display.print("AirT: ");  display.println(airTemp);
  display.print("Hum: ");   display.println(humidity);
  display.print("pH: ");    display.println(pH);
  display.print("Gas: ");   display.println(gas);
  display.print("Turb: ");  display.println(turbidity);
  display.print("Status: "); display.println(status);
  display.display();

  // ---------- HTTP POST to backend ----------
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "application/json");

    // Build JSON manually (no ArduinoJson needed)
    String body = "{";
    body += "\"product\":\"" + product + "\",";
    body += "\"milk_temp\":"  + String(milkTemp, 2) + ",";
    body += "\"air_temp\":"   + String(airTemp, 2)  + ",";
    body += "\"humidity\":"   + String(humidity, 2) + ",";
    body += "\"ph\":"         + String(pH, 2)        + ",";
    body += "\"gas\":"        + String(gas)          + ",";
    body += "\"turbidity\":"  + String(turbidity)    + ",";
    body += "\"weight\":"     + String(weight, 1)    + ",";
    body += "\"danger_score\":" + String(dangerScore)  + ",";
    body += "\"warning_score\":" + String(warningScore) + ",";
    body += "\"status\":\"" + status + "\"";
    body += "}";

    int code = http.POST(body);
    Serial.print("HTTP POST: "); Serial.println(code);
    http.end();
  } else {
    Serial.println("WiFi disconnected — HTTP skipped");
  }
}

// ---------- SETUP ----------
void setup() {
  Serial.begin(115200);

  dht.begin();
  sensors.begin();

  scale.begin(DT, SCK);
  scale.set_scale(2280.f);
  scale.tare();

  pinMode(RED_LED,    OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(GREEN_LED,  OUTPUT);
  pinMode(BUZZER,     OUTPUT);

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED FAIL");
  } else {
    display.setTextColor(WHITE);
  }

  // Connect WiFi
  Serial.print("Connecting WiFi");
  WiFi.begin(ssid, pass);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 30) {
    delay(500);
    Serial.print(".");
    tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi OK: " + WiFi.localIP().toString());
  } else {
    Serial.println("\nWiFi FAILED - continuing without network");
  }
}

// ---------- LOOP ----------
void loop() {
  sendSensorData();
  delay(2000);  // every 2 seconds — same cadence as before
}