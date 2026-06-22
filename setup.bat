@echo off
chcp 65001 >nul
title 云平台初始化设置

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║      ☀️  云平台初始化（仅需运行一次）     ║
echo  ╚══════════════════════════════════════════╝
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [X] 未找到 Node.js
    echo  正在打开下载页面...
    start https://nodejs.org/zh-cn/download
    echo  请安装 Node.js LTS 版本后重新运行此脚本
    pause
    exit /b 1
)

echo  [√] Node.js 已安装
node --version
echo.

:: 安装 npm 依赖
echo  [1/2] 安装项目依赖...
call npm install

:: 下载 cloudflared
echo.
echo  [2/2] 下载公网隧道工具...
if exist "cloudflared.exe" (
    echo  [√] cloudflared 已存在，跳过下载
) else (
    echo  正在从 GitHub 下载 cloudflared...
    curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
    if %errorlevel% neq 0 (
        echo  [X] 下载失败，请检查网络或手动下载
        echo  手动下载地址: https://github.com/cloudflare/cloudflared/releases
        pause
        exit /b 1
    )
    echo  [√] cloudflared 下载完成
)

echo.
echo  ════════════════════════════════════════════
echo    ✅ 初始化完成！
echo  ════════════════════════════════════════════
echo.
echo   现在双击 start.bat 即可启动云平台
echo.
pause
