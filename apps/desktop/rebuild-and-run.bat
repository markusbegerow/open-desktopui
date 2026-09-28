@echo off
setlocal

echo === Killing any process on port 1420 ===
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo === Killing any lingering opendesktopui.exe ===
taskkill /IM opendesktopui.exe /F >nul 2>&1

echo === Clearing Rust build cache ===
cd /d "%~dp0src-tauri"
call cargo clean

echo === Rebuilding and starting the app ===
cd /d "%~dp0"
call npm run tauri dev

endlocal
