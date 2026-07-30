@echo off
echo 📡 信差情报系统启动中...
echo   配置: .env  (WECHAT_SECRET: %WECHAT_SECRET:~0,4%...)
cd /d "%~dp0"
node src/index.js
pause
