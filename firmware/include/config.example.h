// config.h 로 복사한 뒤 값을 채운다. config.h 는 git 에 올라가지 않는다.
#pragma once

// 전송 방식. Wi-Fi 가 실패하면 BLE 모드로 들어가, 근처 맥의 서버(BLE_ENABLED=1)가 연결하면
// BLE_INTERVAL_SEC 마다 측정값을 보낸다. BLE 모드는 deep sleep 하지 않아 건전지가 며칠 못 간다.
// Wi-Fi 가 없는 곳이면 USE_WIFI 0 으로 두어 연결 대기(최대 15초)를 건너뛴다.
#define USE_WIFI 1
#define USE_BLE 1
#define BLE_INTERVAL_SEC 5

#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-password"

// PlantTalk 서버 주소 (같은 네트워크의 PC IP 또는 배포한 서버)
#define SERVER_URL "http://192.168.0.10:8787"
#define DEVICE_TOKEN "change-me"  // 서버 .env 의 DEVICE_TOKEN 과 같아야 함

// 서버 대시보드의 식물 설정에서 이 ID 를 식물에 연결한다. BLE 이름으로도 쓰므로 20자 이내
#define DEVICE_ID "soil-basil"
