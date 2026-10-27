// config.h 로 복사한 뒤 값을 채운다. config.h 는 git 에 올라가지 않는다.
#pragma once

#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-password"

// PlantTalk 서버 주소 (같은 네트워크의 PC IP 또는 배포한 서버)
#define SERVER_URL "http://192.168.0.10:8787"
#define DEVICE_TOKEN "change-me"  // 서버 .env 의 DEVICE_TOKEN 과 같아야 함

// 서버 대시보드의 식물 설정에서 이 ID 를 식물에 연결한다
#define DEVICE_ID "soil-basil"
