@echo off
setlocal
cd /d "%~dp0"
title RuangTemu - Video call & berbagi layar
python "%~dp0server.py" --host 0.0.0.0 --port 8000 --max-peers 8
endlocal
