@echo off
chcp 65001 >nul
title 云平台初始化设置（仅需运行一次）

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║      ☀️  云平台初始化（仅需一次）        ║
echo  ╚══════════════════════════════════════════╝
echo.

set "NODE=runtime\nodejs\node.exe"
set "NPM=runtime\nodejs\npm.cmd"

:: 安装 npm 依赖
echo  [1/2] 安装项目依赖...
%NODE% %NPM% install

:: 下载 cloudflared
echo.
echo  [2/2] 下载公网隧道工具...
if exist "cloudflared.exe" (
    echo  [√] cloudflared 已存在，跳过
) else (
    echo  正在下载 cloudflared...
    curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
    if %errorlevel% neq 0 (
        echo  [X] 下载失败，请检查网络
    ) else (
        echo  [√] 下载完成
    )
)

echo.
echo  ════════════════════════════════════════════
echo    ✅ 初始化完成！双击 start.bat 启动云平台
echo  ════════════════════════════════════════════
echo.
pause
