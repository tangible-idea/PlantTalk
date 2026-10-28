# PlantTalk 작업용 단축 명령
#   make esp          펌웨어 빌드 + 업로드 + 시리얼 로그 (Ctrl+C 로 종료)
#   make esp-build    빌드만
#   make esp-upload   빌드 + 업로드
#   make esp-monitor  시리얼 로그만
#   make server       서버 실행 (BLE 수신 켬)
#   make test         서버 테스트
#
# 포트는 자동으로 찾는다. 여러 개 꽂혀 있으면 직접 지정: make esp PORT=/dev/cu.usbmodem2101

PIO ?= $(HOME)/.platformio/penv/bin/pio
FW := firmware
CONFIG := $(FW)/include/config.h
PORT ?= $(firstword $(wildcard /dev/cu.usbmodem*))

.PHONY: esp esp-build esp-upload esp-monitor esp-port server test

esp: esp-upload esp-monitor

# config.h 가 없으면 예제에서 만든다. Wi-Fi 정보가 없으니 BLE 전용(USE_WIFI 0)으로 둔다.
$(CONFIG):
	cp $(FW)/include/config.example.h $@
	sed -i '' 's/#define USE_WIFI 1/#define USE_WIFI 0/' $@
	@echo ">> $@ 를 만들었습니다 (BLE 전용, DEVICE_ID=soil-basil). Wi-Fi 를 쓰려면 이 파일을 고치세요."

esp-build: $(CONFIG)
	cd $(FW) && $(PIO) run

esp-port:
	@if [ -z "$(PORT)" ]; then \
		echo ">> 센서 USB 포트를 찾지 못했습니다 (/dev/cu.usbmodem*)."; \
		echo "   - 데이터 전송이 되는 USB-C 케이블인지 확인"; \
		echo "   - 안 되면 BOOT 버튼을 누른 채 USB 를 꽂고 다시 make esp"; \
		exit 1; \
	fi
	@echo ">> 포트: $(PORT)"

esp-upload: $(CONFIG) esp-port
	cd $(FW) && $(PIO) run -t upload --upload-port $(PORT) || { \
		echo ">> 업로드 실패. BOOT 버튼을 누른 채 USB 를 다시 꽂고 make esp 를 다시 실행하세요."; \
		echo "   (부트로더 모드로 올렸다면 업로드 후 USB 를 뺐다 꽂거나 RESET 을 눌러야 실행됩니다)"; \
		exit 1; }

# 터미널이면 pio monitor, 아니면(Claude Code 의 ! 등) MONITOR_SECS 초 동안 로그만 읽는다.
MONITOR_SECS ?= 40
esp-monitor: esp-port
	@sleep 2  # 업로드 직후 리셋되며 포트가 다시 잡힐 때까지 기다린다
	@if [ -t 0 ]; then \
		cd $(FW) && $(PIO) device monitor --port $(PORT); \
	else \
		echo ">> $(MONITOR_SECS)초 동안 시리얼 로그를 읽습니다"; \
		$(dir $(PIO))python $(FW)/monitor.py $(PORT) $(MONITOR_SECS); \
	fi

server:
	cd server && { [ -d node_modules ] || npm install; } && BLE_ENABLED=1 npm start

test:
	cd server && npm test
