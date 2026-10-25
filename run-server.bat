@echo off
echo ==============================================
echo [MusicGueh] Menjalankan Server Backend (FastAPI)...
echo ==============================================
cd /d D:\Kuliah\Coding\MusicGueh\server
if not exist venv (
    echo Membuat virtual environment...
    python -m venv venv
)
call venv\Scripts\activate
pip install -r requirements.txt
python app.py
pause
