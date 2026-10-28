// PlantTalk 펌웨어 - Seeed XIAO Soil Moisture Sensor (XIAO ESP32-C6)
//
// 한 번 깨어날 때마다: 센서 측정 -> LED 로 상태 표시 -> Wi-Fi 로 서버에 전송 -> deep sleep.
// 서버가 응답으로 다음 측정까지의 sleep 시간을 내려준다.
// Wi-Fi 가 안 되면 BLE 모드로 들어간다. 근처 맥의 서버(BLE_ENABLED=1)가 연결하면
// BLE_INTERVAL_SEC 마다 측정값을 notify 한다. 이 모드에서는 deep sleep 하지 않는다(배터리 소모 큼).
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

#if __has_include("config.h")
#include "config.h"
#else
#error "include/config.example.h 를 include/config.h 로 복사하고 값을 채우세요"
#endif

// 예전 config.h 에는 없는 값이라 기본값을 둔다.
#ifndef USE_WIFI
#define USE_WIFI 1
#endif
#ifndef USE_BLE
#define USE_BLE 1
#endif
#ifndef BLE_INTERVAL_SEC
#define BLE_INTERVAL_SEC 5
#endif

#include <Arduino.h>
#include <Preferences.h>
#include "driver/rtc_io.h"
#include "esp_sleep.h"
#if USE_WIFI
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#endif
#if USE_BLE
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
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
// C6 의 LEDC 는 40MHz 클럭이라 200kHz 에서는 7비트(128단계)까지만 된다. 8비트면 설정이 실패한다.
constexpr uint8_t PWM_BITS = 7;
constexpr uint32_t PWM_DUTY = 87;  // 87/128 = 68% (factory 펌웨어와 동일)

// factory 펌웨어 기본 보정값 (V). 실제 화분에서 보정하면 NVS 에 저장된다.
constexpr float DEFAULT_DRY_V = 2.75f;
constexpr float DEFAULT_WET_V = 1.20f;

constexpr uint32_t WIFI_TIMEOUT_MS = 15000;
constexpr uint32_t DEFAULT_SLEEP_SEC = 30 * 60;
constexpr uint32_t OFFLINE_SLEEP_SEC = 15 * 60;
constexpr uint32_t MIN_SLEEP_SEC = 60;
constexpr uint32_t MAX_SLEEP_SEC = 12 * 60 * 60;
// server/src/ble.js 의 UUID 와 같아야 한다
#define BLE_SERVICE_UUID "7a1e0001-b5a3-4f2c-9a1d-6c0f3e8b2d41"
#define BLE_READING_UUID "7a1e0002-b5a3-4f2c-9a1d-6c0f3e8b2d41"

RTC_DATA_ATTR uint32_t bootCount = 0;

Preferences prefs;
float dryV = DEFAULT_DRY_V;
float wetV = DEFAULT_WET_V;

struct Reading {
  float soilV;
  float moisture;  // 0~100 %
  float batteryV;
  float battery;   // 0~100 %
  float chipTemp;  // ESP32-C6 내장 온도 센서 (°C). 칩 온도라 실내 기온보다 높게 나온다
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
  r.chipTemp = temperatureRead();
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

#if USE_WIFI
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
#endif

#if USE_BLE
volatile bool bleConnected = false;
volatile bool bleJustConnected = false;

class BleCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    bleConnected = true;
    bleJustConnected = true;
  }
  void onDisconnect(BLEServer*) override {
    bleConnected = false;
    BLEDevice::startAdvertising();  // 다시 연결을 기다린다
  }
};

// 값 배치는 server/src/ble.js 주석과 같다.
void notifyReading(BLECharacteristic* ch, const Reading& r, uint8_t wake) {
  uint8_t pkt[15];
  auto put16 = [&](int at, uint32_t v) {
    pkt[at] = v & 0xFF;
    pkt[at + 1] = (v >> 8) & 0xFF;
  };
  pkt[0] = 2;  // 버전
  put16(1, (uint32_t)lroundf(r.moisture * 10));
  put16(3, (uint32_t)lroundf(r.soilV * 1000));
  put16(5, (uint32_t)lroundf(r.batteryV * 1000));
  pkt[7] = (uint8_t)lroundf(r.battery);
  pkt[8] = wake;
  put16(9, (uint16_t)(int16_t)lroundf(r.chipTemp * 10));
  uint32_t uptime = millis() / 1000;
  put16(11, uptime & 0xFFFF);
  put16(13, uptime >> 16);
  ch->setValue(pkt, sizeof(pkt));
  if (bleConnected) ch->notify();
}

Reading measureNow() {
  sensorPower(true);
  Reading r = measure();
  sensorPower(false);
  Serial.printf("[soil] %.3fV -> %.1f%%  battery %.3fV (%.0f%%)  chip %.1fC\n", r.soilV, r.moisture,
                r.batteryV, r.battery, r.chipTemp);
  return r;
}

// 돌아오지 않는다. 연결돼 있는 동안 BLE_INTERVAL_SEC 마다, 버튼을 누르면 바로 보낸다.
[[noreturn]] void bleStream(Reading first, esp_sleep_wakeup_cause_t cause) {
  BLEDevice::init(DEVICE_ID);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new BleCallbacks());
  BLEService* svc = server->createService(BLE_SERVICE_UUID);
  BLECharacteristic* ch = svc->createCharacteristic(
      BLE_READING_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  ch->addDescriptor(new BLE2902());
  svc->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->setScanResponse(true);  // 이름(DEVICE_ID)은 scan response 에 들어간다
  BLEDevice::startAdvertising();
  Serial.println("[ble] advertising, waiting for connection");

  Reading r = first;
  uint8_t wake = cause == ESP_SLEEP_WAKEUP_TIMER ? 1 : (cause == ESP_SLEEP_WAKEUP_EXT1 ? 2 : 0);
  notifyReading(ch, r, wake);
  uint32_t lastSent = millis();
  bool wasDown = digitalRead(PIN_BUTTON) == LOW;  // 깨울 때 누른 버튼은 무시

  while (true) {
    bool down = digitalRead(PIN_BUTTON) == LOW;
    bool pressed = down && !wasDown;
    wasDown = down;

    if (bleJustConnected) {
      bleJustConnected = false;
      Serial.println("[ble] connected");
      blink(PIN_LED_GREEN, 2, 100, 100);
      delay(1000);  // 맥이 notify 구독을 마칠 시간
      notifyReading(ch, r, wake);  // 연결되자마자 최신 값을 보낸다
      lastSent = millis();
    }
    if (pressed || millis() - lastSent >= BLE_INTERVAL_SEC * 1000UL) {
      r = measureNow();
      if (pressed) showMoistureLed(r.moisture);
      notifyReading(ch, r, pressed ? 2 : 1);
      lastSent = millis();
    }
    delay(20);
  }
}
#endif

void goToSleep(uint32_t seconds) {
  if (seconds < MIN_SLEEP_SEC) seconds = MIN_SLEEP_SEC;
  if (seconds > MAX_SLEEP_SEC) seconds = MAX_SLEEP_SEC;
  Serial.printf("[sleep] %lu s\n", (unsigned long)seconds);
  Serial.flush();

  allLedsOff();
#if USE_WIFI
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
#endif

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
#if USE_WIFI
  if (connectWifi()) {
    sleepSec = upload(r, wakeReasonName(cause));
  } else {
    Serial.println("[wifi] connect timeout");
  }
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);  // BLE 와 동시에 켜 두지 않는다
#endif
#if USE_BLE
  if (sleepSec == 0) bleStream(r, cause);
#endif
  if (sleepSec == 0) {
    blink(PIN_LED_RED, 3, 100, 100);  // 전송 실패 표시
    sleepSec = OFFLINE_SLEEP_SEC;
  }
  goToSleep(sleepSec);
}

void loop() {}
