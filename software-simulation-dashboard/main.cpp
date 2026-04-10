#include <Arduino.h>
#include <DHT.h>
#include <HX711.h>
#include <WiFi.h>
#include <HTTPClient.h>

// -------------------- PINS --------------------
#define DHTPIN 4
#define DHTTYPE DHT22

#define PH_PIN 34
#define GAS_PIN 33
#define TURBIDITY_PIN 32

#define LED_RED 25
#define LED_YELLOW 26
#define LED_GREEN 27
#define BUZZER 14

#define HX_DT 18
#define HX_SCK 19

// -------------------- WIFI --------------------
const char* ssid = "Wokwi-GUEST";
const char* password = "";
const char* serverUrl = "http://192.168.128.1:5000/data";  // 🔴 CHANGE

// -------------------- OBJECTS --------------------
DHT dht(DHTPIN, DHTTYPE);
HX711 scale;

// -------------------- VARIABLES --------------------
float milkTemp, airTemp, humidity, pH;
int gasValue, turbidity;
float weight;

// -------------------- FUNCTION --------------------
int stableRead(int pin) {
  long sum = 0;
  for (int i = 0; i < 20; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return sum / 20;
}

// -------------------- SETUP --------------------
void setup() {
  Serial.begin(115200);
  dht.begin();

  pinMode(LED_RED, OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(BUZZER, OUTPUT);

  scale.begin(HX_DT, HX_SCK);
  scale.set_scale(100);
  scale.tare();

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }
}

// -------------------- LOOP --------------------
void loop() {

  airTemp = dht.readTemperature();
  humidity = dht.readHumidity();
  milkTemp = airTemp;

  int phRaw = stableRead(PH_PIN);
  pH = (phRaw / 4095.0) * 14.0;

  gasValue = stableRead(GAS_PIN);
  turbidity = stableRead(TURBIDITY_PIN);

  if (scale.is_ready()) {
    weight = scale.get_units(5);
    if (weight < 0) weight = 0;
  }

  // STATUS
  String status = "SAFE";
  if (milkTemp > 35 || pH < 6 || pH > 8 || gasValue > 3500 || turbidity < 700) {
    status = "DANGER";
  } else if (milkTemp > 30 || gasValue > 2500 || turbidity < 1000) {
    status = "WARNING";
  }

  digitalWrite(LED_GREEN, status == "SAFE");
  digitalWrite(LED_YELLOW, status == "WARNING");
  digitalWrite(LED_RED, status == "DANGER");
  digitalWrite(BUZZER, status == "DANGER");

  // JSON
  String json = "{";
  json += "\"milkTemp\":" + String(milkTemp) + ",";
  json += "\"pH\":" + String(pH) + ",";
  json += "\"gas\":" + String(gasValue) + ",";
  json += "\"turbidity\":" + String(turbidity) + ",";
  json += "\"airTemp\":" + String(airTemp) + ",";
  json += "\"humidity\":" + String(humidity) + ",";
  json += "\"weight\":" + String(weight) + ",";
  json += "\"status\":\"" + status + "\"}";

  Serial.println(json);

  // SEND TO SERVER
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");
    http.POST(json);
    http.end();
  }

  delay(2000);
}