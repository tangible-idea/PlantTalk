# 터미널이 아닌 곳(예: Claude Code 의 `!` 명령)에서 시리얼 로그를 읽는다.
# pio device monitor 는 키보드 입력이 필요해서 이런 곳에서는 실행되지 않는다.
#   python monitor.py <port> [seconds]   seconds 를 생략하면 Ctrl+C 까지
import sys, time
import serial

port = sys.argv[1]
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else None
end = time.time() + seconds if seconds else None
with serial.Serial(port, 115200, timeout=0.5) as s:
    while end is None or time.time() < end:
        line = s.readline()
        if line:
            print(line.decode(errors="replace").rstrip(), flush=True)
