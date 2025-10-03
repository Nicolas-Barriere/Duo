from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from typing import Dict, List
import uuid, subprocess, threading, time, shutil, logging, os, traceback
from pathlib import Path

# Logging simple
logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
log = logging.getLogger("cinema")

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],)

# --- Rooms (max 2) ---
rooms: Dict[str, List[WebSocket]] = {}

# --- Sessions HLS ---
SESSIONS: Dict[str, dict] = {}
ROOT = Path(os.getenv("CINEMA_SESSIONS_ROOT", "/tmp/cinema_sessions"))
ROOT.mkdir(parents=True, exist_ok=True)
SESSION_TTL = 60 * 60  # 1h

# --- Cleanup background ---
def _cleanup_loop():
    while True:
        now = time.time()
        for sid, meta in list(SESSIONS.items()):
            if now - meta.get("created_at", now) > SESSION_TTL:
                proc = meta.get("proc")
                if proc and proc.poll() is None:
                    try: proc.terminate()
                    except: pass
                try: shutil.rmtree(meta.get("path"), ignore_errors=True)
                except: pass
                SESSIONS.pop(sid, None)
        time.sleep(30)

threading.Thread(target=_cleanup_loop, daemon=True).start()

# --- WebSocket simple sync (2 clients) ---
@app.websocket("/ws/{room_id}")
async def ws_room(ws: WebSocket, room_id: str):
    await ws.accept()
    room = rooms.setdefault(room_id, [])
    if len(room) >= 2:
        await ws.close(code=1013, reason="Room full")
        return
    room.append(ws)
    if len(room) == 2:
        for c in room:
            try: await c.send_json({"type": "system", "data": {"event": "start_call"}})
            except: pass
    try:
        while True:
            data = await ws.receive_json()
            for other in room:
                if other != ws:
                    try: await other.send_json(data)
                    except: pass
    except WebSocketDisconnect:
        pass
    finally:
        if ws in room:
            room.remove(ws)
        for c in room:
            try: await c.send_json({"type": "system", "data": {"event": "peer_left"}})
            except: pass

# --- Utility: extract direct URL with yt_dlp ---
def extract_direct_url(target: str):
    from yt_dlp import YoutubeDL  # type: ignore
    opts = {
        'quiet': True,
        'skip_download': True,
        'format': 'best[ext=mp4][vcodec^=avc1][acodec=aac]/best[ext=mp4]/best'
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(target, download=False)
        # Essayer d'abord formats listés
        for f in info.get('formats', []) or []:
            if f.get('ext') == 'mp4' and f.get('vcodec') != 'none' and f.get('acodec') != 'none' and 'm3u8' not in (f.get('protocol') or ''):
                return f.get('url'), f
        # fallback
        return info.get('url'), info

# --- Démarrage cinéma ---
@app.post("/cinema/start")
async def cinema_start(data: dict):
    vid = data.get("videoId")
    url = data.get("url")
    debug = bool(data.get("debug"))
    force_copy = bool(data.get("copy"))  # option pour bypass transcodage vidéo
    if not vid and not url:
        raise HTTPException(400, "videoId ou url requis")
    target = url or f"https://www.youtube.com/watch?v={vid}"
    log.info(f"[start] {target}")
    if not shutil.which("ffmpeg"):
        raise HTTPException(500, "ffmpeg manquant")
    try:
        direct_url, fmt = extract_direct_url(target)
        if not direct_url:
            raise RuntimeError("URL directe introuvable")
    except Exception as e:
        log.error(f"extract fail: {e}\n{traceback.format_exc()}")
        raise HTTPException(500, f"Extraction échec: {e}")

    sid = uuid.uuid4().hex[:10]
    out_dir = ROOT / sid
    out_dir.mkdir(parents=True, exist_ok=True)
    playlist = out_dir / "index.m3u8"
    err_log_path = out_dir / "ffmpeg.stderr.log"
    err_file = open(err_log_path, "wb")

    # Construction commande ffmpeg
    # Objectif: démarrer plus vite (supprime gros analyzeduration/probesize), robustesse réseau (reconnect), logs capturés.
    base_input = [
        'ffmpeg','-nostdin','-hide_banner','-y',
        '-i', direct_url,
        '-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','6',
        '-fflags','+genpts','-avoid_negative_ts','make_zero','-flush_packets','1'
    ]

    if force_copy:
        # Pas de ré-encodage vidéo; on copie (si codec compatible HLS). Audio converti AAC si nécessaire.
        cmd = base_input + [
            '-c:v','copy',
            '-c:a','aac','-ac','2','-b:a','128k',
            '-f','hls','-hls_time','3','-hls_list_size','0','-hls_flags','independent_segments',
            '-hls_segment_filename', str(out_dir / 'seg_%05d.ts'), str(playlist)
        ]
    else:
        cmd = base_input + [
            '-vf','scale=-2:1080',
            '-c:v','libx264','-preset','veryfast','-crf','22',
            '-g','90','-keyint_min','90','-sc_threshold','0',
            '-force_key_frames','expr:gte(t,n_forced*3)',
            '-c:a','aac','-b:a','128k','-ac','2',
            '-f','hls','-hls_time','3','-hls_list_size','0','-hls_flags','independent_segments',
            '-hls_segment_filename', str(out_dir / 'seg_%05d.ts'), str(playlist)
        ]

    log.info("ffmpeg " + ' '.join(cmd[1:12]) + " ...")
    try:
        # Toujours capturer stderr dans fichier pour debug; si debug demander aussi niveau plus verbeux.
        if debug:
            # relance avec niveau warning pour plus de signal
            if '-loglevel' not in cmd:
                cmd.insert(2, 'error')  # placeholder si absent (rare)
            # (on laisse -hide_banner)
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=err_file)
    except Exception as e:
        err_file.close()
        raise HTTPException(500, f"ffmpeg start: {e}")

    SESSIONS[sid] = {'path': str(out_dir), 'proc': proc, 'created_at': time.time(), 'source_url': target, 'stderr': str(err_log_path)}

    import asyncio
    # Attente playlist prolongée (30s max)
    for _ in range(300):  # 300 * 0.1s = 30s
        if playlist.exists():
            break
        if proc.poll() is not None:
            # Process mort, lire logs
            try:
                err_file.flush()
                err_file.close()
                tail = b''
                if err_log_path.exists():
                    data = err_log_path.read_bytes()
                    tail = data[-4000:]
                log.error(f"ffmpeg ended early (rc={proc.returncode}) tail:\n{tail.decode(errors='ignore')}")
            except: pass
            SESSIONS.pop(sid, None)
            try: shutil.rmtree(out_dir, ignore_errors=True)
            except: pass
            raise HTTPException(500, 'ffmpeg terminé prématurément')
        await asyncio.sleep(0.1)
    if not playlist.exists():
        try:
            proc.terminate()
        except: pass
        try:
            err_file.flush(); err_file.close()
            tail = b''
            if err_log_path.exists():
                data = err_log_path.read_bytes()
                tail = data[-4000:]
            log.error(f"Timeout playlist tail:\n{tail.decode(errors='ignore')}")
        except: pass
        SESSIONS.pop(sid, None)
        raise HTTPException(500, 'Timeout création playlist')

    # Fermer le handle local (process garde fd ouvert)
    try: err_file.close()
    except: pass
    return { 'sessionId': sid, 'playlist': f"/cinema/{sid}/index.m3u8", 'copy': force_copy }

# --- Service fichiers HLS ---
@app.get('/cinema/{session_id}/{file_path:path}')
async def cinema_file(session_id: str, file_path: str):
    meta = SESSIONS.get(session_id)
    if not meta:
        raise HTTPException(404, 'Session inconnue')
    base = Path(meta['path']).resolve()
    full = (base / file_path).resolve()
    try:
        from os.path import commonpath
        if commonpath([str(full), str(base)]) != str(base):
            raise HTTPException(400, 'Chemin invalide')
    except ValueError:
        raise HTTPException(400, 'Chemin invalide')

    # Attente brève si segment nouvellement annoncé
    if not full.exists():
        import asyncio
        if full.name == 'index.m3u8':
            for _ in range(40):
                await asyncio.sleep(0.1)
                if full.exists(): break
        elif full.suffix == '.ts':
            for _ in range(20):
                await asyncio.sleep(0.05)
                if full.exists(): break
    if not full.exists():
        raise HTTPException(404, 'Fichier inexistant')

    data = full.read_bytes()
    media = 'application/vnd.apple.mpegurl' if full.suffix == '.m3u8' else 'video/MP2T'
    return Response(content=data, media_type=media, headers={'Access-Control-Allow-Origin':'*','Cache-Control':'no-cache'})

# --- Arrêt session ---
@app.post('/cinema/stop/{session_id}')
async def cinema_stop(session_id: str):
    meta = SESSIONS.pop(session_id, None)
    if not meta:
        return JSONResponse({'stopped': False})
    proc = meta.get('proc')
    if proc and proc.poll() is None:
        try: proc.terminate()
        except: pass
    try: shutil.rmtree(meta.get('path'), ignore_errors=True)
    except: pass
    return {'stopped': True}
