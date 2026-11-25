@echo off
rem BRASA local server. Close this window (or press Ctrl+C) to stop the server.
rem   start.bat        development server  -> http://localhost:5173
rem   start.bat prod   production build    -> http://localhost:4173
title BRASA server - close this window to stop
cd /d "%~dp0web"

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist node_modules goto run
echo Installing dependencies, first run only...
call npm install
if errorlevel 1 goto fail

:run
if /i "%~1"=="prod" goto prod
echo BRASA: http://localhost:5173
call npx vite --port 5173 --open
goto end

:prod
echo Building production version...
call npm run build
if errorlevel 1 goto fail
echo BRASA production build: http://localhost:4173
call npx vite preview --port 4173 --open
goto end

:nonode
echo Node.js is not installed. Get it from https://nodejs.org and run again.
:fail
pause
:end
