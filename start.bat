@echo off
chcp 65001 >nul
title 光伏储能数据采集云平台

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║     ☀️  光伏储能数据采集云平台  v1.0      ║
echo  ╚══════════════════════════════════════════╝
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [错误] 未找到 Node.js，请先安装: https://nodejs.org
    echo  安装后重新运行此脚本
    pause
    exit /b 1
)

node --version

:: 安装依赖（首次）
if not exist "node_modules\express" (
    echo  [首次运行] 安装依赖中...
    npm install
)

echo.
echo  [启动] 开启云平台服务...
start "PV-Cloud-Server" /MIN node server.js

:: 等待服务器启动
timeout /t 3 /nobreak >nul

echo  [启动] 开启公网隧道...
echo  ════════════════════════════════════════════
echo   正在生成公网访问地址，请稍候...
echo  ════════════════════════════════════════════
echo.

:: 启动 cloudflared 隧道
cloudflared.exe tunnel --url http://localhost:3000 2>&1

pause
