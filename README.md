# PlantTalk 🌱

식물이 직접 말을 거는 스마트 화분 시스템. 토양 센서 값을 서버가 해석하고, Claude가 식물마다 정한 성격대로 대사를 만들어 단체 채팅방(Discord 또는 웹 대시보드)에 보낸다.

"ESP32-Based Messaging Plant" 기획을 바탕으로 하되, 센서는 DHT22 + AS7341 + OLED 대신 **Seeed Studio XIAO Soil Moisture Sensor**(XIAO ESP32-C6 내장, AA 건전지 1개) 하나로 구성했다.

```
[XIAO Soil Sensor] --Wi-Fi/HTTP 또는 BLE--> [PlantTalk 서버] --Claude--> 식물 대사 --> [Discord 채널 / 웹 대시보드]
  측정 → LED 표시 → 전송 → deep sleep      상태 해석, 이벤트 감지              주인이 말 걸면 식물들이 답장
```

## 원래 기획과 달라진 점

| 기획 (인포그래픽) | 이 프로젝트 |
|---|---|
| ESP32 + DHT22(온습도) + AS7341(광 스펙트럼) | XIAO Soil Sensor: **토양 수분** + 배터리 |
| OLED 상태 표시 | 3색 LED (빨강: 마름 / 노랑: 목마름 / 초록: 적당) |
| 상시 전원 | AA 건전지 + deep sleep. 마를수록 자주(15분), 적당하면 1시간마다 측정 |
| Discord / KakaoTalk | Discord + 웹 대시보드 채팅. 메신저 어댑터 구조라 추가 가능 |

센서가 측정하지 않는 값(온도, 햇빛 등)은 식물이 지어내지 않도록 프롬프트에서 막아 두었다.

## 구성

```
firmware/   PlatformIO (Arduino core 3.x, pioarduino) 펌웨어
server/     Node 20+ 서버: API, 상태 해석, Claude 대사 생성, Discord 연동, 대시보드
```

### 서버 흐름

1. 기기가 `POST /api/readings`로 측정값을 보낸다. Wi-Fi가 없으면 서버를 실행 중인 맥이 BLE로 기기에 연결해 값을 계속 받는다(아래 "BLE 수신").
2. `status.js`가 식물별 기준치로 상태를 정한다: `dry` / `thirsty` / `ok` / `soggy`. 상태가 바뀌었는지, 물을 줬는지(수분 +15%p 이상), 배터리가 부족한지도 감지한다.
3. 알릴 일이 생기면 `brain.js`가 Claude(`claude-opus-5-5`)를 한 번 호출한다. 식물들의 페르소나, 센서 값, 최근 채팅을 넘기면 "누가, 무슨 말을 할지"가 JSON으로 돌아온다.
4. `hub.js`가 답장을 채팅 기록에 남기고, 연결된 모든 메신저로 보낸다.
5. 주인이 채팅방에 쓴 메시지도 같은 흐름을 거쳐, 관련 있는 식물들이 답한다.

## 서버 실행

```bash
cd server
cp .env.example .env   # DEVICE_TOKEN, Claude 인증, (선택) Discord 값 채우기
npm install
npm start              # http://localhost:8787
```

- Claude 인증에는 `.env`의 `ANTHROPIC_API_KEY`를 쓰거나, `ant auth login` 프로필을 그대로 쓸 수 있다.
- 대시보드(`/`)에서 할 수 있는 일:
  - 식물을 추가하고 캐릭터(성격, 말투, 예시 대사, 수분 기준치, 센서 기기 ID)를 수정한다.
  - 슬라이더로 센서 값을 시뮬레이션한다. 하드웨어 없이도 대화를 테스트할 수 있다.
  - 단체 채팅방에서 식물들과 대화한다.
- 서버를 외부에 공개한다면 `ADMIN_TOKEN`을 반드시 설정한다. 설정하지 않으면 누구나 페르소나를 바꾸고 Claude 호출(비용)을 일으킬 수 있다.
- 데이터는 `server/data/db.json`에 저장된다. 처음 실행하면 `plants.example.json`의 Basil과 Moni가 들어간다.
- 테스트: `npm test`

### BLE 수신 (Wi-Fi 없을 때, 선택)

센서가 Wi-Fi에 연결하지 못하면 BLE 모드로 들어가 PlantTalk 서비스를 광고한다. 서버를 센서 근처(약 10m)의 맥에서 돌리면 서버가 센서에 연결하고, 연결이 유지되는 동안 센서가 `BLE_INTERVAL_SEC`(기본 30초)마다 측정값을 보낸다. 받은 값은 Wi-Fi로 받은 것과 똑같이 처리된다.

1. `server/.env`에 `BLE_ENABLED=1`을 넣고 `npm install`로 `@stoprocent/noble`을 설치한다(optional 의존성).
2. `npm start`. 처음 실행할 때 macOS가 터미널의 블루투스 접근을 물어보면 허용한다. 로그에 `[ble] scanning`이 보이면 연결을 기다리는 중이다.
3. 연결되면 센서의 초록 LED가 2번 깜빡이고 서버 로그에 `[ble] <DEVICE_ID> connected`가 찍힌다. 연결이 끊기면 센서가 다시 광고하고 서버가 다시 붙는다.

- 아직 인증이 없다. 근처의 누구나 같은 서비스로 값을 보낼 수 있다.
- BLE 모드에서는 deep sleep을 하지 않아 AA 건전지가 며칠 만에 닳는다. 테스트할 때는 USB 전원을 쓴다.
- 패킷 구조는 `server/src/ble.js` 주석에 있다.

### Discord 단체 채팅 연결 (선택)

기본 채팅방은 대시보드 오른쪽의 웹 채팅이다. 메신저처럼 아바타, 시간, 입력 중 표시가 있고 Enter로 보낸다. Discord는 `.env`에 값을 넣을 때만 켜지는 부가 기능이다.

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 봇을 만들고 **Message Content Intent**를 켠다. 그다음 서버에 초대한다(권한: 채널 보기, 메시지 읽기).
2. 식물들이 대화할 채널에서 **설정 → 연동 → 웹후크**를 만들고 URL을 복사한다.
3. `.env`에 `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_WEBHOOK_URL`을 채운다.

봇은 채널의 사람 메시지를 읽기만 한다. 식물들은 webhook을 통해 각자의 이름과 아바타(`avatarUrl`)로 말한다. 웹 대시보드에서 보낸 메시지도 Discord 채널에 함께 표시된다.

> KakaoTalk 단체방에는 공식 봇 API가 없어서 기본 어댑터에 넣지 않았다. 다른 메신저를 붙이려면 `server/src/messengers/`에 `start` / `sendAsPlant` / `relayOwner`를 구현하고 `index.js`의 `messengers`에 추가하면 된다.

## 펌웨어

### 하드웨어 (Seeed 공식 factory 펌웨어 기준 핀)

| XIAO 핀 | GPIO | 용도 |
|---|---|---|
| D0 | 0 | 배터리 전압 ADC |
| D1 | 1 | 토양 센서 ADC (건조할수록 전압 ↑) |
| D2 | 2 | 버튼 (deep sleep 깨우기) |
| D3 | 21 | 정전용량 센서 구동 PWM 200kHz, 68% |
| D8 / D9 / D10 | 19 / 20 / 18 | 초록 / 빨강 / 노랑 LED |
| - | 14 | 센서 전원 enable |

### 빌드와 업로드

저장소 루트에서 `make esp` 한 번으로 설정 파일 생성, 빌드, 업로드, 시리얼 로그까지 끝난다. `config.h`가 없으면 BLE 전용(`USE_WIFI 0`, `DEVICE_ID=soil-basil`)으로 만든다. 서버는 `make server`(BLE 수신 켬)로 띄운다. 직접 하려면:

```bash
cd firmware
cp include/config.example.h include/config.h   # Wi-Fi, 서버 주소, DEVICE_TOKEN, DEVICE_ID
pio run -t upload
pio device monitor
```

- `DEVICE_ID`는 대시보드에서 식물의 "센서 기기 ID"에 입력한다. 아직 연결하지 않은 기기가 데이터를 보내면 대시보드에 표시된다.
- Wi-Fi와 BLE를 같이 넣으면 기본 앱 파티션(1.3MB)을 넘기 때문에 `huge_app.csv`(앱 3MB, OTA 없음)를 쓴다.
- ESP32-C6는 Arduino core 3.x가 필요해서 `platformio.ini`에서 [pioarduino](https://github.com/pioarduino/platform-espressif32) 플랫폼을 쓴다.
- 이 펌웨어를 올리면 Seeed factory 펌웨어(ESPHome / Home Assistant 연동)는 지워진다. 되돌리려면 [Seeed 위키](https://wiki.seeedstudio.com/xiao_soil_moisture_sensor/)의 factory 펌웨어를 다시 올린다.

### 동작

- 깨어날 때마다 측정 → LED 1회 표시 → 서버 전송 → 서버가 정한 시간만큼 deep sleep.
- Wi-Fi 전송에 실패하면 BLE 모드로 들어가 리셋할 때까지 머문다. 맥이 연결하면 30초마다, 버튼을 누르면 바로 측정값을 보낸다. BLE도 끈 상태(`USE_BLE 0`)에서 실패하면 빨강 LED가 3번 깜빡이고 15분 뒤 다시 시도한다.
- Wi-Fi가 없는 곳에서는 `config.h`의 `USE_WIFI`를 0으로 두면 바로 BLE 모드로 들어간다.
- **버튼 1번**: 바로 측정하고 전송한다. 서버는 이걸 "주인이 직접 확인했다"는 이벤트로 받아 식물이 한마디 한다.
- **버튼 3번 연속**: 보정(calibration).
  1. 빨강 LED가 깜빡이는 10초 동안 센서를 마른 흙(또는 공기 중)에 둔다.
  2. 초록 LED가 깜빡이는 10초 동안 물을 충분히 준 흙에 꽂는다.
  3. 성공하면 초록 LED가 빠르게 5번 깜빡이고, 값이 NVS에 저장된다.

### 날씨와 아침 인사

- 서버가 30분마다 [Open-Meteo](https://open-meteo.com/)에서 바깥 날씨(지금, 오늘, 내일)를 받아 Claude에게 함께 넘긴다. 식물은 필요할 때 날씨를 대화에 섞고, 주인이 날씨를 물으면 답한다. 화분 자리에서 잰 값이 아니라는 점은 프롬프트에 적어 두었다.
- 매일 7~9시 사이 무작위 시각에 식물이 날씨와 함께 먼저 아침 인사를 한다. 인사한 날짜를 저장해서 서버를 다시 켜도 하루 한 번만 한다.
- 위치는 `.env`의 `WEATHER_LAT` / `WEATHER_LON`. 비워 두면 서버 공인 IP로 도시 단위 위치를 찾는다(ipwho.is, 실패하면 서울). `WEATHER_ENABLED=0`, `MORNING_GREETING=0`으로 끌 수 있다.
- 대기질: 같은 Open-Meteo에서 PM10/PM2.5를 받아 환경부 등급(좋음/보통/나쁨/매우나쁨)으로 넘긴다.
- 기상청 단기예보(선택): `.env`에 `KMA_SERVICE_KEY`(공공데이터포털 "기상청_단기예보 조회서비스" Decoding 키)를 넣으면 동네 단위 예보(오늘·내일 최저/최고, 비 오는 시간, 앞으로 12시간)를 함께 넘긴다.
- 공휴일: date.nager.at(키 없음)에서 공휴일을 받아 오늘·내일이 쉬는 날인지, 다음 공휴일이 언제인지 넘긴다.

## 확장 아이디어

- 물 주기 알림: `dry` 상태가 일정 시간 이상 계속되면 식물이 다시 조른다.
- 일일 요약: 하루 한 번 식물들이 그날의 상태를 수다처럼 정리한다.
