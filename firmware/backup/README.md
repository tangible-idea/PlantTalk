# Seeed factory 펌웨어 백업

XIAO Soil Moisture Sensor(XIAO ESP32-C6FH4, 4MB flash)에 출고 시 들어 있던 펌웨어(ESPHome `soil-moisture-monitor`)의 전체 플래시 덤프.
2026-10-28, `esptool read_flash 0 0x400000` 로 읽고 `verify_flash` 로 일치를 확인했다.

| 파일 | 설명 |
|---|---|
| `factory_4MB_nvs-erased.bin` | 전체 4MB 이미지에서 NVS 영역(0x390000, 0x6D000)만 0xFF 로 비운 사본. 저장돼 있던 Wi-Fi SSID/비밀번호가 빠져 있다. |

원본(`factory_full_4MB.bin`)에는 Wi-Fi 정보가 들어 있어 git 에 넣지 않고 로컬에만 둔다.

## 파티션

| 이름 | 오프셋 | 크기 |
|---|---|---|
| otadata | 0x009000 | 0x2000 |
| phy_init | 0x00B000 | 0x1000 |
| app0 | 0x010000 | 0x1C0000 |
| app1 | 0x1D0000 | 0x1C0000 |
| nvs | 0x390000 | 0x6D000 |

## 복원

BOOT 버튼을 누른 채 USB 를 연결해 부트로더 모드로 만든 뒤:

```bash
~/.platformio/penv/bin/python ~/.platformio/packages/tool-esptoolpy/esptool.py \
  --chip esp32c6 -p /dev/cu.usbmodem2101 -b 921600 write_flash 0 factory_4MB_nvs-erased.bin
```

복원 후에는 출고 상태처럼 `Xiao-Soil-Moisture-Monitor` AP 또는 Improv 로 Wi-Fi 를 다시 설정한다.
