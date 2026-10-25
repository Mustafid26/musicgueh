# MusicGueh - Ad-Free Music Streaming Player

Aplikasi web pemutar musik gabungan arsitektur katalog **Spotify** & raw audio stream tanpa iklan dari **YouTube Music**.

## 📁 Struktur Direktori
- `client/`: Frontend React 19 + Tailwind CSS + Lucide Icons (Spotify-like Dark UI).
- `server/`: Backend resolver FastAPI + `yt-dlp` untuk scraping audio stream Opus/M4A langsung dari YouTube CDN.
- `run-server.bat`: Shortcut jalankan backend server otomatis.
- `run-client.bat`: Shortcut jalankan Vite React frontend.

## 🚀 Cara Menjalankan

### 1. Jalankan Backend (Port 8000)
Klik ganda `run-server.bat` atau jalankan manual:
```bash
cd D:\Kuliah\Coding\MusicGueh\server
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

### 2. Jalankan Frontend (Port 5173)
Klik ganda `run-client.bat` atau jalankan manual:
```bash
cd D:\Kuliah\Coding\MusicGueh\client
npm run dev
```

Buka browser di `http://localhost:5173`.
Semua pencarian musik langsung diekstrak ke raw audio stream tanpa iklan.
