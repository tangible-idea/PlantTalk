// PlantTalk 펌웨어 - Seeed XIAO Soil Moisture Sensor (XIAO ESP32-C6)
//
// 한 번 깨어날 때마다: 센서 측정 -> LED 로 상태 표시 -> Wi-Fi 로 서버에 전송 -> deep sleep.
// 서버가 응답으로 다음 측정까지의 sleep 시간을 내려준다.
//
// 핀 배치는 Seeed 공식 factory 펌웨어(ESPHome YAML)를 따른다.
//   D0  GPIO0   배터리 전압 ADC (AA 1개)
//   D1  GPIO1   토양 센서 ADC (건조할수록 전압이 높다)
//   D2  GPIO2   버튼 (active low, deep sleep 깨우기)
//   D3  GPIO21  정전용량 센서 구동용 200kHz PWM
//   D8  GPIO19  초록 LED / D9 GPIO20 빨강 LED / D10 GPIO18 노랑 LED
//   GPIO14      센서 전원 enable
//
// 버튼: 1번 누르면 즉시 측정/전송, 3번 연속 누르면 보정(calibration) 모드.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include "driver/rtc_io.h"
#include "esp_sleep.h"

#if __has_include("config.h")
#include "config.h"
#else
#error "include/config.example.h 를 include/config.h 로 복사하고 값을 채우세요"
#endif

#define FW_VERSION "0.1.0"

constexpr int PIN_BATTERY = 0;
constexpr int PIN_SOIL = 1;
constexpr int PIN_BUTTON = 2;
constexpr int PIN_PWM = 21;
constexpr int PIN_SENSOR_POWER = 14;
constexpr int PIN_LED_GREEN = 19;
constexpr int PIN_LED_RED = 20;
constexpr int PIN_LED_YELLOW = 18;

constexpr uint32_t PWM_FREQ = 200000;
constexpr uint8_t PWM_BITS = 8;
constexpr uint32_t PWM_DUTY = 174;  // 68% (factory 펌웨어와 동일)

// factory 펌웨어 기본 보정값 (V). 실제 화분에서 보정하면 NVS 에 저장된다.
constexpr float DEFAULT_DRY_V = 2.75f;
constexpr float DEFAULT_WET_V = 1.20f;

constexpr uint32_t WIFI_TIMEOUT_MS = 15000;
constexpr uint32_t DEFAULT_SLEEP_SEC = 30 * 60;
constexpr uint32_t OFFLINE_SLEEP_SEC = 15 * 60;
constexpr uint32_t MIN_SLEEP_SEC = 60;
constexpr uint32_t MAX_SLEEP_SEC = 12 * 60 * 60;

RTC_DATA_ATTR uint32_t bootCount = 0;

Preferences prefs;
float dryV = DEFAULT_DRY_V;
float wetV = DEFAULT_WET_V;

struct Reading {
  float soilV;
  float moisture;  // 0~100 %
  float batteryV;
  float battery;   // 0~100 %
};

void setLed(int pin, bool on) { digitalWrite(pin, on ? HIGH : LOW); }

void allLedsOff() {
  setLed(PIN_LED_GREEN, false);
  setLed(PIN_LED_RED, false);
  setLed(PIN_LED_YELLOW, false);
}

void blink(int pin, int times, int onMs, int offMs) {
  for (int i = 0; i < times; i++) {
    setLed(pin, true);
    delay(onMs);
    setLed(pin, false);
    delay(offMs);
  }
}

void sensorPower(bool on) {
  if (on) {
    digitalWrite(PIN_SENSOR_POWER, HIGH);
    ledcAttach(PIN_PWM, PWM_FREQ, PWM_BITS);
    ledcWrite(PIN_PWM, PWM_DUTY);
    delay(100);  // 센서 출력 안정화
  } else {
    ledcWrite(PIN_PWM, 0);
    ledcDetach(PIN_PWM);
    digitalWrite(PIN_SENSOR_POWER, LOW);
  }
}

float readVolts(int pin, int samples) {
  uint32_t sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogReadMilliVolts(pin);
    delay(20);
  }
  return sum / (float)samples / 1000.0f;
}

float clampPercent(float v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

Reading measure() {
  Reading r;
  r.soilV = readVolts(PIN_SOIL, 20);
  r.moisture = clampPercent((dryV - r.soilV) / (dryV - wetV) * 100.0f);
  r.batteryV = readVolts(PIN_BATTERY, 10);
  // factory 펌웨어 기준: 1.0V 이하면 방전, 1.5V 가 완충
  r.battery = clampPercent((r.batteryV - 1.0f) / 0.5f * 100.0f);
  return r;
}

void showMoistureLed(float moisture) {
  // 서버 연결 전에 바로 보여주는 로컬 표시. 기준은 factory 펌웨어의 23% / 58% 구간.
  int pin = moisture < 23 ? PIN_LED_RED : (moisture < 58 ? PIN_LED_YELLOW : PIN_LED_GREEN);
  blink(pin, 1, 800, 100);
}

void loadCalibration() {
  prefs.begin("soil", true);
  dryV = prefs.getFloat("dry", DEFAULT_DRY_V);
  wetV = prefs.getFloat("wet", DEFAULT_WET_V);
  prefs.end();
  Serial.printf("[cal] dry=%.3fV wet=%.3fV\n", dryV, wetV);
}

// 빨강 LED 가 깜빡이는 10초 동안 센서를 마른 흙(또는 공기 중)에 두고,
// 초록 LED 가 깜빡이는 10초 동안 물을 충분히 준 흙(또는 물컵)에 꽂는다.
void calibrate() {
  Serial.println("[cal] start");
  sensorPower(true);

  blink(PIN_LED_RED, 10, 500, 500);
  float dry = readVolts(PIN_SOIL, 30);
  Serial.printf("[cal] dry=%.3fV\n", dry);
  delay(1000);

  blink(PIN_LED_GREEN, 10, 500, 500);
  float wet = readVolts(PIN_SOIL, 30);
  Serial.printf("[cal] wet=%.3fV\n", wet);

  sensorPower(false);

  if (dry - wet > 0.2f) {
    prefs.begin("soil", false);
    prefs.putFloat("dry", dry);
    prefs.putFloat("wet", wet);
    prefs.end();
    dryV = dry;
    wetV = wet;
    blink(PIN_LED_GREEN, 5, 150, 150);
    Serial.println("[cal] saved");
  } else {
    blink(PIN_LED_RED, 5, 150, 150);
    Serial.println("[cal] failed: dry 와 wet 전압 차이가 너무 작음");
  }
}

// 버튼으로 깨어났을 때 연속으로 몇 번 눌렸는지 센다 (깨운 첫 번째 누름 포함).
int countButtonPresses() {
  int presses = 1;
  bool wasDown = digitalRead(PIN_BUTTON) == LOW;
  uint32_t lastEdge = millis();
  while (millis() - lastEdge < 1200) {
    bool down = digitalRead(PIN_BUTTON) == LOW;
    if (down && !wasDown) {
      presses++;
      lastEdge = millis();
    }
    if (!down && wasDown) lastEdge = millis();
    wasDown = down;
    delay(10);
  }
  return presses;
}

bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_TIMEOUT_MS) return false;
    delay(100);
  }
  Serial.printf("[wifi] connected, rssi=%d\n", WiFi.RSSI());
  return true;
}

const char* wakeReasonName(esp_sleep_wakeup_cause_t cause) {
  switch (cause) {
    case ESP_SLEEP_WAKEUP_TIMER: return "timer";
    case ESP_SLEEP_WAKEUP_EXT1: return "button";
    default: return "boot";
  }
}

// 성공하면 서버가 정한 다음 sleep 시간(초)을, 실패하면 0 을 돌려준다.
uint32_t upload(const Reading& r, const char* wakeReason) {
  JsonDocument body;
  body["deviceId"] = DEVICE_ID;
  body["moisture"] = roundf(r.moisture * 10) / 10;
  body["soilVoltage"] = r.soilV;
  body["battery"] = roundf(r.battery);
  body["batteryVoltage"] = r.batteryV;
  body["rssi"] = WiFi.RSSI();
  body["wakeReason"] = wakeReason;
  body["bootCount"] = bootCount;
  body["firmware"] = FW_VERSION;
  String payload;
  serializeJson(body, payload);

  String url = String(SERVER_URL) + "/api/readings";
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  if (url.startsWith("https://")) {
    secure.setInsecure();  // 인증서 고정이 필요하면 setCACert 로 교체
    http.begin(secure, url);
  } else {
    http.begin(plain, url);
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.setTimeout(10000);

  int code = http.POST(payload);
  uint32_t sleepSec = 0;
  if (code == 200) {
    JsonDocument res;
    if (!deserializeJson(res, http.getString())) {
      sleepSec = res["sleepSeconds"] | DEFAULT_SLEEP_SEC;
    } else {
      sleepSec = DEFAULT_SLEEP_SEC;
    }
  }
  Serial.printf("[http] POST %s -> %d\n", url.c_str(), code);
  http.end();
  return sleepSec;
}

void goToSleep(uint32_t seconds) {
  if (seconds < MIN_SLEEP_SEC) seconds = MIN_SLEEP_SEC;
  if (seconds > MAX_SLEEP_SEC) seconds = MAX_SLEEP_SEC;
  Serial.printf("[sleep] %lu s\n", (unsigned long)seconds);
  Serial.flush();

  allLedsOff();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  rtc_gpio_pullup_en((gpio_num_t)PIN_BUTTON);
  rtc_gpio_pulldown_dis((gpio_num_t)PIN_BUTTON);
  esp_sleep_enable_ext1_wakeup_io(1ULL << PIN_BUTTON, ESP_EXT1_WAKEUP_ANY_LOW);
  esp_deep_sleep_start();
}

void setup() {
  Serial.begin(115200);
  bootCount++;

  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_SENSOR_POWER, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  allLedsOff();
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  loadCalibration();

  if (cause == ESP_SLEEP_WAKEUP_EXT1 && countButtonPresses() >= 3) {
    calibrate();
  }

  sensorPower(true);
  Reading r = measure();
  sensorPower(false);
  Serial.printf("[soil] %.3fV -> %.1f%%  battery %.3fV (%.0f%%)\n", r.soilV, r.moisture,
                r.batteryV, r.battery);
  showMoistureLed(r.moisture);

  uint32_t sleepSec = 0;
  if (connectWifi()) {
    sleepSec = upload(r, wakeReasonName(cause));
  } else {
    Serial.println("[wifi] connect timeout");
  }
  if (sleepSec == 0) {
    blink(PIN_LED_RED, 3, 100, 100);  // 전송 실패 표시
    sleepSec = OFFLINE_SLEEP_SEC;
  }
  goToSleep(sleepSec);
}

void loop() {}
