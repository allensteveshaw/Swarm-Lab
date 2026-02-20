@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0backend"
set "HOST=127.0.0.1"
set "PORT=3017"
set "URL=http://%HOST%:%PORT%/lab"

echo ============================================================
echo  Swarm Lab Launcher
 echo ============================================================

if not exist "%ROOT%\package.json" (
  echo [ERROR] backend path not found: %ROOT%
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo Install Node.js LTS first: https://nodejs.org/
  pause
  exit /b 1
)

cd /d "%ROOT%"

echo [1/6] Optional: start docker services...
where docker >nul 2>&1
if errorlevel 1 (
  echo [WARN] Docker CLI not found. Skip docker compose.
) else (
  docker compose up -d >nul 2>&1
  if errorlevel 1 (
    echo [WARN] Docker not running or compose failed. Continue without docker.
  ) else (
    echo [OK] docker compose started.
  )
)

echo [2/6] Ensure dependencies...
if not exist "%ROOT%\node_modules" (
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [3/6] Check backend process on %HOST%:%PORT% ...
set "PIDS="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  set "PIDS=!PIDS! %%p"
)

if defined PIDS (
  echo [OK] Port %PORT% already listening. Reusing existing server.
) else (
  echo [4/6] Start backend in new window...
  start "Swarm Lab Backend" cmd /k "cd /d %ROOT% && npm run dev:win"
)

echo [5/6] Wait server ready...
set /a RETRY=0
:wait_loop
set /a RETRY+=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://%HOST%:%PORT%/api/health' -TimeoutSec 2; if($r.StatusCode -ge 200){ exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto ready
if %RETRY% GEQ 90 (
  echo [WARN] server health check timeout. You can still open: %URL%
  goto open_url
)
timeout /t 1 >nul
goto wait_loop

:ready
echo [OK] Server is ready.

echo [6/6] Init DB (safe to retry)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Method POST -Uri 'http://%HOST%:%PORT%/api/admin/init-db' ^| Out-Null; Write-Host '[OK] DB initialized.' } catch { Write-Host '[WARN] init-db failed (can ignore if DB already ready).' }"

:open_url
start "" "%URL%"
echo Opened: %URL%
exit /b 0
