# Seeed factory 펌웨어 분석

대상: `factory_full_4MB.bin` (2026-10-28 덤프). 바이너리 헤더, 문자열, 데이터 상수, RISC-V 역어셈블리, NVS 내용으로 분석했다.
비교 기준은 Seeed 위키에 공개된 Home Assistant YAML(`HomeAssistanceYaml.yaml`)이다.

## 1. 이미지 정보

| 항목 | 값 |
|---|---|
| 칩 | ESP32-C6FH4 (QFN32) rev v0.2, 4MB flash (DIO, 80MHz) |
| 프레임워크 | ESPHome `2025.3.0-dev`, ESP-IDF 5.2.1 |
| 빌드 시각 | 2025-05-28 17:17:16 |
| 프로젝트 | ESPHome name `xiao-soil-moisture`, project `xiao.soil-moisture-monitor` v1.0 |
| 호스트명 | `xiao-soil-moisture.local` (mDNS) |
| 실행 슬롯 | `app0` (otadata seq=1, state=VALID). `app1` 은 비어 있음, 즉 OTA 이력 없음 |
| 앱 무결성 | checksum, SHA-256 validation hash 모두 valid |

## 2. 공개 YAML 과의 일치 여부

다음 항목이 공개 YAML 과 그대로 일치한다. 실제 기기에 들어 있는 것도 같은 로직이다.

- 스크립트/ID: `check_moisture_once`, `do_calibration`, `red/green/yellow_led_blink*`, `fast_blink_*`, `my_button`
- 로그 문자열: `Starting calibration`, `Dry value: %f`, `Calibration success/failed`, `Moisture reading: %f`, `The device has been networked` 등
- 상수 (데이터 영역): dry 2.75, wet 1.2, ref_dry 0.23, ref_wet 0.58, PWM 200kHz, duty 0.68, 배터리 1.0~1.5V
- 상수 (코드 즉시값, 역어셈블리 `lui+addi`): 900000ms(15분), 3600000ms(1시간), 28800000ms(8시간), 10800000ms(180분)
- 엔티티: `Soil Moisture Status`, `Battery measurement`, `wifi singnal strength`(오타까지 동일), 내부 `200kHz PWM`

공개 YAML 과 다른 점은 이름 메타데이터뿐이다 (`soil-moisture-monitor` 대신 `xiao-soil-moisture`, project 메타데이터 추가, AP SSID 대문자 `XIAO-Soil-Moisture-Monitor`). 이는 GitHub `Seeed-Studio/xiao-esphome-projects` 버전으로 빌드했기 때문으로 보인다.

## 3. 동작 흐름

1. 부팅/깨어남: GPIO14 ON, GPIO21 에 200kHz/68% PWM 을 켠다(정전용량 센서 구동).
2. Wi-Fi 미설정 상태(`wifi_net_status == 0`)면 deep sleep 을 막고 설정을 기다린다.
   - 개방형 AP `XIAO-Soil-Moisture-Monitor` + captive portal(`/wifisave`, `/config.json`)
   - USB 시리얼 Improv
3. 1초 후 `check_moisture_once`: ADC(GPIO1) 10회 갱신 후 판정한다.
   - 전압 ≥ dry − Δ·0.23 → Dry, 빨강 LED, 15분 후 재측정
   - 그 사이 → Almost Dry, 노랑 LED, 1시간 후 재측정
   - 그 외 → Normal, 초록 LED, 8시간 후 재측정
   - (Δ = dry − wet)
4. 120초 동안 깨어 있으면서 Home Assistant API 로 값을 보고하고, 5초마다 상태를 다시 판정한다. 그 후 deep sleep 에 들어간다.
5. 버튼(GPIO2, active low)으로 깨울 수 있다. 1번 누르면 즉시 판정, 3번 누르면 보정 모드.

## 4. 네트워크 / 보안

| 항목 | 결과 |
|---|---|
| 클라우드/외부 서버 | 없음. URL·도메인 문자열 없음. 완전 로컬 동작 |
| BLE | 사용 안 함 (NimBLE/Bluedroid 없음) |
| ESPHome Native API (TCP 6053) | **암호화 없음**. `Using noise encryption: NO` 가 상수로 컴파일됨 |
| ESPHome OTA (TCP 3232) | **비밀번호 없음으로 추정**. `Password configured` 와 OTA 인증 로그 문자열이 없음. 공개 YAML 의 OTA 비밀번호 문자열도 없음 |
| 설정용 AP | 비밀번호 없는 개방형 AP (Wi-Fi 미설정일 때만) |
| 펌웨어 보호 | flash encryption / secure boot 미사용 (평문 덤프·읽기 가능) |

깨어 있는 120초 동안은 같은 LAN 의 누구나 API 로 접속하거나 OTA 로 펌웨어를 덮어쓸 수 있다. 집 네트워크라면 실질적인 위험은 낮다.

## 5. 이 기기의 저장 상태 (NVS)

ESPHome preferences 는 해시 키로 저장된다. 4바이트 값 해석 결과는 다음과 같다.

| 키 | 값 | 해석 |
|---|---|---|
| 1161281005 | 1 | `wifi_net_status` = 1 (Wi-Fi 설정 완료) |
| 1200410635 | 2.7832 (float) | 보정값 `dry_value` / `wet_value` 중 하나 |
| 555244828 | 2.7826 (float) | 보정값 `dry_value` / `wet_value` 중 하나 |
| 233825507 | 4 | 미확인 (ESPHome 내부 값) |
| 88491487 | 98B | Wi-Fi SSID/비밀번호 (git 사본에서는 삭제) |

**주의:** 보정값 두 개가 모두 약 2.78V 로 거의 같다. 기본값(2.75 / 1.2)이 아니므로 보정이 한 번 실행됐다. 다만 dry/wet 둘 다 공기 중(또는 마른 상태)에서 측정된 것으로 보인다.

공개 YAML 은 보정이 실패해도 측정값을 먼저 저장하므로, 이 상태에서는 Δ ≈ 0.0006V 다. 그래서 흙에 꽂아도 전압이 2.78V 보다 조금만 낮으면 항상 "Normal Moisture"(8시간 sleep)로 판정된다. 출고 펌웨어를 계속 쓸 생각이라면 버튼 3회로 다시 보정해야 한다. 마른 흙 → 젖은 흙 순서로 한다.

PlantTalk 펌웨어는 보정값을 별도 NVS 네임스페이스(`soil`)에 저장하므로 이 값의 영향을 받지 않는다.
