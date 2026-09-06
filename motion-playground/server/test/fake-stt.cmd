@echo off
set SRT_FILE=%~2
echo 1 > "%SRT_FILE%"
echo 00:00:00,000 --^> 00:00:05,000 >> "%SRT_FILE%"
echo 这是一个假引擎生成的字幕 >> "%SRT_FILE%"
echo. >> "%SRT_FILE%"
