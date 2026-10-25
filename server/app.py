import os
import urllib.parse
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
import yt_dlp
import requests

app = FastAPI(title="MusicGueh Engine", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

YDL_OPTS_SEARCH = {
    'format': 'bestaudio[ext=m4a]/bestaudio/best',
    'noplaylist': True,
    'quiet': True,
    'extract_flat': True,
    'skip_download': True,
    'extractor_args': {'youtube': {'player_client': ['ios', 'android', 'web']}},
}

YDL_OPTS_EXTRACT = {
    'format': 'bestaudio[ext=m4a]/bestaudio/best',
    'noplaylist': True,
    'quiet': True,
    'extract_flat': False,
    'skip_download': True,
    'extractor_args': {'youtube': {'player_client': ['ios', 'android', 'web']}},
}

# In-memory simple cache
STREAM_CACHE = {}

@app.get("/api/health")
def health_check():
    return {"status": "ok", "app": "MusicGueh Backend", "ad_free": True}

@app.get("/api/search")
def search_tracks(
    q: str = Query(..., min_length=1, description="Kata kunci pencarian musik"),
    limit: int = Query(50, ge=1, le=100, description="Jumlah hasil lagu yang diambil")
):
    """
    Cari lagu di YouTube Music / YouTube Audio via yt-dlp.
    Mengembalikan daftar hasil metadata mirip Spotify/YT Music dengan pool luas untuk shuffle.
    """
    search_query = f"ytsearch{limit}:{q} audio"
    try:
        with yt_dlp.YoutubeDL(YDL_OPTS_SEARCH) as ydl:
            res = ydl.extract_info(search_query, download=False)
            tracks = []
            if res and 'entries' in res:
                for entry in res['entries']:
                    if not entry:
                        continue
                    tracks.append({
                        "id": entry.get("id"),
                        "title": entry.get("title"),
                        "uploader": entry.get("uploader") or entry.get("channel"),
                        "duration": entry.get("duration"),
                        "thumbnail": entry.get("thumbnail") or f"https://i.ytimg.com/vi/{entry.get('id')}/hqdefault.jpg",
                        "url": entry.get("url")
                    })
            return {"query": q, "results": tracks, "total": len(tracks)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gagal mencari track: {str(e)}")

@app.get("/api/resolve")
def resolve_track(id: str = Query(..., description="ID video YouTube")):
    """
    Ambil direct stream link raw audio (M4A/Opus) tanpa iklan.
    """
    if id in STREAM_CACHE:
        return STREAM_CACHE[id]

    video_url = f"https://www.youtube.com/watch?v={id}"
    try:
        with yt_dlp.YoutubeDL(YDL_OPTS_EXTRACT) as ydl:
            info = ydl.extract_info(video_url, download=False)
            if not info:
                raise HTTPException(status_code=404, detail="Track tidak ditemukan")

            stream_url = info.get("url")
            # Fallback ke formats audio terbaik jika top-level url kosong
            if not stream_url and info.get("formats"):
                formats_list = info.get("formats") or []
                # 1. Cari direct audio stream (m4a / opus)
                audio_formats = [f for f in formats_list if f.get("acodec") != "none" and f.get("vcodec") == "none" and f.get("url")]
                if audio_formats:
                    audio_formats.sort(key=lambda x: x.get("abr") or 0, reverse=True)
                    stream_url = audio_formats[0].get("url")
                else:
                    # 2. Fallback ke progressive video container (audio+video) yang memiliki audio
                    progressive = [f for f in formats_list if f.get("acodec") != "none" and f.get("url")]
                    if progressive:
                        progressive.sort(key=lambda x: x.get("abr") or x.get("tbr") or 0, reverse=True)
                        stream_url = progressive[0].get("url")

            if not stream_url:
                raise HTTPException(status_code=404, detail="Tidak ada audio stream yang dapat diekstrak")

            payload = {
                "id": info.get("id"),
                "title": info.get("title"),
                "uploader": info.get("uploader") or info.get("channel"),
                "duration": info.get("duration"),
                "thumbnail": info.get("thumbnail") or f"https://i.ytimg.com/vi/{id}/hqdefault.jpg",
                "stream_url": stream_url,
                "ad_free": True
            }
            STREAM_CACHE[id] = payload
            return payload
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gagal mengekstrak audio: {str(e)}")

@app.get("/api/related")
def get_related_tracks(id: str = Query(..., description="ID video YouTube")):
    """
    Ambil track rekomendasi / radio otomatis berbasis metadata video terkait.
    Digunakan untuk auto-discovery tanpa batas (Infinite Endless Radio / Autoplay).
    """
    try:
        # Cek info dari cache atau resolve
        track = STREAM_CACHE.get(id)
        if not track:
            try:
                track = resolve_track(id)
            except Exception:
                track = None

        if track and track.get("uploader"):
            artist = track.get("uploader").replace('"', '').replace("'", "")
            search_query = f"ytsearch15:{artist} songs audio"
        else:
            search_query = "ytsearch15:trending hits audio"

        with yt_dlp.YoutubeDL(YDL_OPTS_SEARCH) as ydl:
            res = ydl.extract_info(search_query, download=False)
            tracks = []
            if res and 'entries' in res:
                for entry in res['entries']:
                    if not entry or entry.get('id') == id:
                        continue
                    tracks.append({
                        "id": entry.get("id"),
                        "title": entry.get("title"),
                        "uploader": entry.get("uploader") or entry.get("channel"),
                        "duration": entry.get("duration"),
                        "thumbnail": entry.get("thumbnail") or f"https://i.ytimg.com/vi/{entry.get('id')}/hqdefault.jpg",
                        "url": entry.get("url")
                    })
            return {"source_id": id, "results": tracks}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gagal mengambil related tracks: {str(e)}")

@app.get("/api/stream/{id}")
def stream_proxy(id: str):
    """
    Proxy redirect langsung ke direct audio container YouTube CDN (No Ads).
    """
    track_info = resolve_track(id=id)
    return RedirectResponse(url=track_info["stream_url"])

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
