@echo off
chcp 65001 >nul
title 光伏储能数据采集云平台

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║     ☀️  光伏储能数据采集云平台  v2.0    ║
echo  ╚══════════════════════════════════════════╝
echo.
echo   正在启动服务器...
echo.

set "NODE=runtime\nodejs\node.exe"

:: 启动后端服务器（静默窗口）
start "PV-Cloud-Server" /MIN %NODE% server.js
timeout /t 3 /nobreak >nul

:: 启动公网隧道
echo   ════════════════════════════════════════════
echo    生成公网访问地址中，请稍候...
echo   ════════════════════════════════════════════
echo.
echo   💡 看到下面的 https://xxx.trycloudflare.com
echo      就是评委访问的网址！
echo.

cloudflared.exe tunnel --url http://localhost:3000
