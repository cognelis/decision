@echo off
setlocal
set "bridge_directory=%~dp0"
set "ELECTRON_RUN_AS_NODE=1"
set "DECISION_BRIDGE_PATH=%bridge_directory%decision-island-bridge.cmd"
"%bridge_directory%..\..\Decision.exe" "%bridge_directory%decision-bridge.mjs" %*
exit /b %errorlevel%
