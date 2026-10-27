# PlantTalk 🌱

식물이 직접 말을 거는 스마트 화분 시스템. 토양 센서 값을 서버가 해석하고, Claude가 식물마다 정한 성격대로 대사를 만들어 단체 채팅방(Discord 또는 웹 대시보드)에 보낸다.

"ESP32-Based Messaging Plant" 기획을 바탕으로 하되, 센서는 DHT22 + AS7341 + OLED 대신 **Seeed Studio XIAO Soil Moisture Sensor**(XIAO ESP32-C6 내장, AA 건전지 1개) 하나로 구성했다.

```
[XIAO Soil Sensor] --Wi-Fi/HTTP--> [PlantTalk 서버] --Claude--> 식물 대사 --> [Discord 채널 / 웹 대시보드]
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

1. 기기가 `POST /api/readings`로 측정값을 보낸다.
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

### Discord 단체 채팅 연결 (선택)

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

```bash
cd firmware
cp include/config.example.h include/config.h   # Wi-Fi, 서버 주소, DEVICE_TOKEN, DEVICE_ID
pio run -t upload
pio device monitor
```

- `DEVICE_ID`는 대시보드에서 식물의 "센서 기기 ID"에 입력한다. 아직 연결하지 않은 기기가 데이터를 보내면 대시보드에 표시된다.
- ESP32-C6는 Arduino core 3.x가 필요해서 `platformio.ini`에서 [pioarduino](https://github.com/pioarduino/platform-espressif32) 플랫폼을 쓴다.
- 이 펌웨어를 올리면 Seeed factory 펌웨어(ESPHome / Home Assistant 연동)는 지워진다. 되돌리려면 [Seeed 위키](https://wiki.seeedstudio.com/xiao_soil_moisture_sensor/)의 factory 펌웨어를 다시 올린다.

### 동작

- 깨어날 때마다 측정 → LED 1회 표시 → 서버 전송 → 서버가 정한 시간만큼 deep sleep. 전송에 실패하면 빨강 LED가 3번 깜빡이고 15분 뒤 다시 시도한다.
- **버튼 1번**: 바로 측정하고 전송한다. 서버는 이걸 "주인이 직접 확인했다"는 이벤트로 받아 식물이 한마디 한다.
- **버튼 3번 연속**: 보정(calibration).
  1. 빨강 LED가 깜빡이는 10초 동안 센서를 마른 흙(또는 공기 중)에 둔다.
  2. 초록 LED가 깜빡이는 10초 동안 물을 충분히 준 흙에 꽂는다.
  3. 성공하면 초록 LED가 빠르게 5번 깜빡이고, 값이 NVS에 저장된다.

## 확장 아이디어

- 온도와 빛 정보: 지역 날씨 API(예: Open-Meteo)를 서버에서 붙이면 센서 없이도 "오늘 덥다" 같은 맥락을 줄 수 있다.
- 물 주기 알림: `dry` 상태가 일정 시간 이상 계속되면 식물이 다시 조른다.
- 일일 요약: 하루 한 번 식물들이 그날의 상태를 수다처럼 정리한다.
