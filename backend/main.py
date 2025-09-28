from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from typing import Dict
import uuid, os, subprocess, threading, time, shutil, traceback, logging
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cinema")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Simple rooms for 2 people max
rooms: Dict[str, list[WebSocket]] = {}

SESSIONS: Dict[str, dict] = {}
SESSIONS_ROOT = Path("/tmp/cinema_sessions")
SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
SESSION_TTL = 60 * 60  # 1h

CLEANUP_RUNNING = False

def _cleanup_loop():
    global CLEANUP_RUNNING
    CLEANUP_RUNNING = True
    while True:
        now = time.time()
        for sid, meta in list(SESSIONS.items()):
            if now - meta.get("created_at", now) > SESSION_TTL:
                proc = meta.get("proc")
                if proc and proc.poll() is None:
                    try: proc.terminate()
                    except: pass
                try:
                    shutil.rmtree(meta.get("path"), ignore_errors=True)
                except: pass
                SESSIONS.pop(sid, None)
        time.sleep(30)

if not CLEANUP_RUNNING:
    threading.Thread(target=_cleanup_loop, daemon=True).start()

@app.websocket("/ws/{room_id}")
async def ws_room(ws: WebSocket, room_id: str):
    await ws.accept()
    
    # Initialize room
    if room_id not in rooms:
        rooms[room_id] = []
    
    room = rooms[room_id]
    
    # Max 2 people
    if len(room) >= 2:
        await ws.close(code=1013, reason="Room full")
        return
    
    room.append(ws)
    
    if len(room) == 2:
        for client in room:
            try:
                await client.send_json({"type": "system", "data": {"event": "start_call"}})
            except:
                pass
    
    try:
        while True:
            data = await ws.receive_json()
            # Relay to other person
            for other_ws in room:
                if other_ws != ws:
                    try:
                        await other_ws.send_json(data)
                    except:
                        if other_ws in room:
                            room.remove(other_ws)
    except WebSocketDisconnect:
        pass
    finally:
        if ws in room:
            room.remove(ws)
        for other_ws in room:
            try:
                await other_ws.send_json({"type": "system", "data": {"event": "peer_left"}})
            except:
                pass

@app.post("/cinema/start")
async def start_cinema(data: dict):
    """Démarre un pipeline ffmpeg HLS depuis une vidéo YouTube (videoId ou url)."""
    video_id = data.get("videoId")
    url = data.get("url")
    debug = bool(data.get("debug"))
    if not video_id and not url:
        raise HTTPException(status_code=400, detail="videoId ou url requis")
    if video_id:
        target = f"https://www.youtube.com/watch?v={video_id}"
    else:
        target = url
    logger.info(f"[cinema] start request target={target}")

    if not shutil.which("ffmpeg"):
        raise HTTPException(status_code=500, detail="ffmpeg introuvable (installez-le)")

    try:
        from yt_dlp import YoutubeDL  # type: ignore
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"yt_dlp manquant: {e}")

    # Extraction fine d'un format progressif (audio+video) pour éviter manifest HLS direct
    ydl_opts = {
        'quiet': True,
        'skip_download': True,
        # Préférer directement un progressif mp4 h264+aac
        'format': 'best[ext=mp4][vcodec^=avc1][acodec=aac]/bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[acodec=aac]/best'
    }
    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(target, download=False)
            direct_url = None
            chosen_format = None
            for f in info.get('formats', []) or []:
                # Limiter aux mp4 pour éviter webm (vp9/opus) incompatible TS copy
                if f.get('ext') == 'mp4' and f.get('vcodec') != 'none' and f.get('acodec') != 'none' and 'm3u8' not in (f.get('protocol') or ''):
                    chosen_format = f; direct_url = f.get('url'); break
            if not direct_url:
                # fallback: info.url
                direct_url = info.get('url')
            if not direct_url:
                raise RuntimeError('URL directe introuvable')
            logger.info(f"[cinema] format choisi: {chosen_format.get('format_id') if chosen_format else 'info.url'} vcodec={chosen_format.get('vcodec') if chosen_format else '?'} acodec={chosen_format.get('acodec') if chosen_format else '?'}")
    except Exception as e:
        logger.error("Extraction échec: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Extraction échec: {e}")

    session_id = uuid.uuid4().hex[:10]
    out_dir = SESSIONS_ROOT / session_id
    out_dir.mkdir(parents=True, exist_ok=True)
    playlist = out_dir / "index.m3u8"

    # Déterminer si copy possible (h264/aac) sinon transcodage
    vcodec = (chosen_format or {}).get('vcodec') or ''
    acodec = (chosen_format or {}).get('acodec') or ''
    # mp4a.40.* est de l'AAC, donc élargir la détection
    aac_like = ('aac' in acodec.lower()) or acodec.lower().startswith('mp4a')
    copy_ok = vcodec.startswith('avc1') and aac_like

    is_hls_input = 'm3u8' in (direct_url or '')
    if copy_ok and not is_hls_input:
        # Mode copy (vidéo MP4 déjà en h264 + aac)
        # NOTE: Impossible de forcer des keyframes supplémentaires en copy; si fragParsingError persiste
        # passer en transcode (copy_ok False) pour garantir une keyframe à chaque segment.
        cmd = [
            'ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y','-i', direct_url,
            '-analyzeduration','100M','-probesize','50M',
            '-fflags','+genpts','-avoid_negative_ts','make_zero','-flush_packets','1',
            '-c:v','copy','-c:a','copy','-bsf:v','h264_mp4toannexb',
            '-f','hls','-hls_time','3','-hls_list_size','50','-hls_flags','independent_segments+program_date_time+append_list',
            '-hls_segment_filename', str(out_dir / 'seg_%05d.ts'), str(playlist)
        ]
    elif copy_ok and is_hls_input:
        # Source déjà HLS: on re-segmente / recopie pour uniformiser naming
        cmd = [
            'ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y','-i', direct_url,
            '-analyzeduration','50M','-probesize','25M',
            '-fflags','+genpts','-avoid_negative_ts','make_zero','-flush_packets','1',
            '-c:v','copy','-c:a','copy',
            '-f','hls','-hls_time','3','-hls_list_size','50','-hls_flags','independent_segments+program_date_time+append_list',
            '-hls_segment_filename', str(out_dir / 'seg_%05d.ts'), str(playlist)
        ]
    else:
        logger.info('[cinema] transcodage (ou input HLS) – pas de copy direct possible')
        # Transcodage: force keyframe toutes les 3s (hls_time=3) pour segments indépendants.
        cmd = [
            'ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y','-i', direct_url,
            '-analyzeduration','50M','-probesize','25M',
            '-fflags','+genpts','-avoid_negative_ts','make_zero','-flush_packets','1',
            '-vf','scale=-2:1080','-c:v','libx264','-preset','veryfast','-crf','22',
            '-g','90','-keyint_min','90','-sc_threshold','0',
            '-force_key_frames','expr:gte(t,n_forced*3)',
            '-c:a','aac','-b:a','128k','-ac','2',
            '-f','hls','-hls_time','3','-hls_list_size','50','-hls_flags','independent_segments+program_date_time+append_list',
            '-hls_segment_filename', str(out_dir / 'seg_%05d.ts'), str(playlist)
        ]
    logger.info(f"[cinema] launching ffmpeg: {' '.join(cmd)} (copy_ok={copy_ok} hls_in={is_hls_input})")
    try:
        proc = subprocess.Popen(cmd, stdout=None if debug else subprocess.DEVNULL, stderr=None if debug else subprocess.DEVNULL)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail='ffmpeg introuvable sur le serveur')
    except Exception as e:
        logger.error("Lancement ffmpeg échec: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"ffmpeg start échec: {e}")

    SESSIONS[session_id] = {
        'path': str(out_dir),
        'proc': proc,
        'created_at': time.time(),
        'source_url': target,
        'debug': debug,
    }

    # Attendre que la playlist apparaisse ou échec rapide si ffmpeg meurt
    import asyncio
    for i in range(200):  # ~20s max (certaines vidéos plus lentes)
        if playlist.exists():
            break
        ret = proc.poll()
        if ret is not None:
            logger.error(f"[cinema] ffmpeg exited early (code={ret}) sans playlist")
            try: shutil.rmtree(out_dir, ignore_errors=True)
            except: pass
            SESSIONS.pop(session_id, None)
            raise HTTPException(status_code=500, detail='ffmpeg terminé avant génération playlist')
        await asyncio.sleep(0.1)
    if not playlist.exists():
        logger.error('[cinema] playlist non créée après timeout étendu')
        try: proc.terminate()
        except: pass
        SESSIONS.pop(session_id, None)
        raise HTTPException(status_code=500, detail='Timeout création playlist (extended)')
    return { 'sessionId': session_id, 'playlist': f"/cinema/{session_id}/index.m3u8" }

@app.get('/cinema/{session_id}/{file_path:path}')
async def serve_cinema(session_id: str, file_path: str):
    meta = SESSIONS.get(session_id)
    if not meta:
        raise HTTPException(status_code=404, detail='Session inconnue')
    base = Path(meta['path'])
    base_resolved = base.resolve()
    full = (base / file_path).resolve()
    try:
        from os.path import commonpath
        if commonpath([str(full), str(base_resolved)]) != str(base_resolved):
            raise HTTPException(status_code=400, detail='Chemin invalide')
    except ValueError:
        raise HTTPException(status_code=400, detail='Chemin invalide')

    if not full.exists() and full.name == 'index.m3u8':
        import asyncio
        for _ in range(50):  # attendre jusqu'à ~5s
            await asyncio.sleep(0.1)
            if full.exists():
                break
    # Attente courte pour segments .ts qui viennent juste d'être annoncés dans playlist
    if not full.exists() and full.suffix == '.ts':
        import asyncio
        for _ in range(20):  # ~1s
            await asyncio.sleep(0.05)
            if full.exists():
                break
    if not full.exists():
        raise HTTPException(status_code=404, detail='Fichier inexistant')

    from fastapi import Response
    data = full.read_bytes()
    media = 'application/vnd.apple.mpegurl' if full.suffix == '.m3u8' else 'video/MP2T'
    return Response(content=data, media_type=media, headers={
        'Access-Control-Allow-Origin':'*',
        'Cache-Control':'no-cache'
    })

@app.post('/cinema/stop/{session_id}')
async def stop_cinema(session_id: str):
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
