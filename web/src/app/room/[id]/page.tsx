"use client";

// Room page: WebRTC + WebSocket signaling + YouTube sync + Cinema (HLS) projection
// Objectif: même fonctionnalités que la version longue, code condensé & structuré.

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { CinemaScene } from "../../../components/CinemaScene";
import Hls from "hls.js";

/* Temporary minimal YT type to satisfy TS */
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace YT {
  interface Player {
    getCurrentTime(): number;
    getDuration(): number;
    getPlaybackRate(): number;
    setPlaybackRate(r: number): void;
    loadVideoById(id: string, startSeconds?: number): void;
    playVideo(): void;
    pauseVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    setSize(width: number, height: number): void;
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace PlayerState {
    const PLAYING: number;
    const PAUSED: number;
    const BUFFERING: number;
    const CUED: number;
  }
}

/* ============================ Types ============================ */
type YTAction =
  | { action: "load"; videoId: string }
  | { action: "play" | "pause" | "seek"; time: number }
  | { action: "rate"; rate: number };

type CinemaMsg = { action: 'play' | 'pause' | 'start' | 'stop'; t?: number; id?: string; playlist?: string; origin: string; seq?: number };

type Msg =
  | { type: "system"; data: { event: "start_call" | "peer_left" } }
  | { type: "sdp"; data: RTCSessionDescriptionInit }
  | { type: "ice"; data: RTCIceCandidateInit }
  | { type: "yt"; data: YTAction & { origin: string } }
  | { type: "cinema"; data: CinemaMsg }
  | { type: "chat"; data: { id: string; text: string; ts: number } };

declare global { interface Window { YT: any; onYouTubeIframeAPIReady: () => void; } }

/* ============================ Utils ============================ */
const parseYouTubeId = (raw: string): string | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Direct 11-char id heuristic
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0] || null;
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    // /embed/ID
    const m = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/); if (m) return m[1];
  } catch {}
  return null;
};

/* ============================ Component ============================ */
export default function Room() {
  /* -------- Basic refs & params -------- */
  const { id: roomId } = useParams<{ id: string }>();
  const selfIdRef = useRef<string>(Math.random().toString(36).slice(2));
  const wsRef = useRef<WebSocket | null>(null);
  const wsURL = `${process.env.NEXT_PUBLIC_BACKEND_WS || "ws://localhost:8001/ws"}/${roomId}`;
  const safeSend = useCallback((m: Msg) => wsRef.current?.readyState === 1 && wsRef.current.send(JSON.stringify(m)), []);

  /* -------- WebRTC -------- */
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const offerMadeRef = useRef(false);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const ensurePC = () => {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pcRef.current = pc;
    if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStreamRef.current;
    ["video", "audio"].forEach(k => { try { pc.addTransceiver(k as any, { direction: "sendrecv" }); } catch {} });
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => { try { pc.addTrack(t, localStreamRef.current!); } catch {} });
    pc.ontrack = ev => {
      const track = ev.track;
      if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
      remoteStreamRef.current.getTracks().filter(t => t.kind === track.kind && (t.readyState === "ended" || t.id === track.id)).forEach(t => remoteStreamRef.current!.removeTrack(t));
      if (track.readyState === "live") remoteStreamRef.current.addTrack(track);
      if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== remoteStreamRef.current) remoteVideoRef.current.srcObject = remoteStreamRef.current;
      remoteVideoRef.current?.play().catch(() => { const f = () => { remoteVideoRef.current?.play().catch(()=>{}); document.removeEventListener('click', f); }; document.addEventListener('click', f, { once:true }); });
    };
    pc.onicecandidate = e => e.candidate && safeSend({ type: "ice", data: e.candidate.toJSON() });
    return pc;
  };

  const ensureLocalStream = async () => {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    const pc = ensurePC();
    stream.getTracks().forEach(tr => { if (!pc.getSenders().some(s => s.track?.id === tr.id)) try { pc.addTrack(tr, stream); } catch {} });
    return stream;
  };

  const handleRemoteSDP = async (desc: RTCSessionDescriptionInit) => {
    const pc = ensurePC();
    try {
      await pc.setRemoteDescription(desc);
      while (pendingIce.current.length) { const c = pendingIce.current.shift(); if (c) try { await pc.addIceCandidate(c); } catch {} }
      if (desc.type === "offer") { const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); safeSend({ type: "sdp", data: answer }); }
    } catch {}
  };
  const handleRemoteICE = async (c: RTCIceCandidateInit) => { const pc = ensurePC(); if (!pc.remoteDescription) { pendingIce.current.push(c); return; } try { await pc.addIceCandidate(c); } catch {} };

  /* -------- Auto get local media -------- */
  useEffect(() => { ensureLocalStream().catch(()=>{}); return () => { localStreamRef.current?.getTracks().forEach(t => t.stop()); }; // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => { try { pcRef.current?.close(); } catch {}; pcRef.current = null; }, []);

  /* -------- WebSocket & signaling -------- */
  const [status, setStatus] = useState("Init");
  const [hasPeer, setHasPeer] = useState(false);
  useEffect(() => {
    const ws = new WebSocket(wsURL); wsRef.current = ws;
    ws.onopen = () => setStatus(s => s + " | WS");
    ws.onclose = () => setStatus(s => s + " | WS off");
    ws.onmessage = async ev => {
      let msg: Msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'sdp') return handleRemoteSDP(msg.data);
      if (msg.type === 'ice') return handleRemoteICE(msg.data);
      if (msg.type === 'system') {
        if (msg.data.event === 'peer_left') { setHasPeer(false); offerMadeRef.current = false; pcRef.current?.close(); pcRef.current = null; if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null; setStatus("En attente"); }
        if (msg.data.event === 'start_call') {
          setHasPeer(true); offerMadeRef.current = false; const createOffer = async () => { const pc = ensurePC(); try { offerMadeRef.current = true; const offer = await pc.createOffer(); await pc.setLocalDescription(offer); safeSend({ type:'sdp', data: offer }); } catch { offerMadeRef.current = false; } }; setTimeout(createOffer, Math.random()*400+120); }
        return;
      }
      if (msg.type === 'yt') return handleYTMessage(msg.data);
      if (msg.type === 'cinema') return handleCinemaMessage(msg.data);
      if (msg.type === 'chat') { setChatMessages(m => [...m.slice(-199), msg.data]); return; }
    };
    return () => { try { ws.close(); } catch {} };
  }, [wsURL]);

  /* -------- YouTube sync -------- */
  const youtubeContainerRef = useRef<HTMLDivElement | null>(null);
  const ytPlayerRef = useRef<YT.Player | null>(null);
  const ytReadyRef = useRef(false);
  const lastSentRef = useRef<{ action?: string; t?: number }>({});
  const primeFrameRef = useRef(false);
  const progressRef = useRef<HTMLInputElement | null>(null);
  const [ytState, setYtState] = useState({ current: 0, duration: 0, playing: false, rate: 1 });
  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null);
  const [showYTDebug, setShowYTDebug] = useState(false);

  const initYT = () => {
    if (ytPlayerRef.current || !youtubeContainerRef.current || !window.YT?.Player) return;
    ytPlayerRef.current = new window.YT.Player(youtubeContainerRef.current, {
      height: '1', width: '1', videoId: undefined, playerVars: { rel:0, playsinline:1, controls:0, modestbranding:1, disablekb:1, cc_load_policy:1 },
      events: {
        onReady: () => {
          ytReadyRef.current = true;
          setInterval(() => {
            const p = ytPlayerRef.current; if (!p) return;
            const c = p.getCurrentTime?.() || 0; const d = p.getDuration?.() || 0; const r = p.getPlaybackRate?.() || 1;
            setYtState(s => ({ ...s, current: c, duration: d || s.duration, rate: r }));
            if (progressRef.current && !progressRef.current.matches(':active')) progressRef.current.value = d ? String((c/d)*1000) : '0';
          }, 500);
        },
        onStateChange: (e: any) => {
          const state = e.data; const p = ytPlayerRef.current; if (!p) return;
            if (primeFrameRef.current) { if ([window.YT.PlayerState.PAUSED, window.YT.PlayerState.PLAYING, window.YT.PlayerState.CUED].includes(state)) primeFrameRef.current = false; return; }
            if (state === window.YT.PlayerState.BUFFERING) return;
            const t = p.getCurrentTime?.() || 0; const playing = state === window.YT.PlayerState.PLAYING; setYtState(s => ({ ...s, playing }));
            if (playing) { if (lastSentRef.current.action !== 'play' || Math.abs((lastSentRef.current.t||0)-t) > 0.5) { safeSend({ type:'yt', data:{ action:'play', time:t, origin:selfIdRef.current } }); lastSentRef.current = { action:'play', t }; } }
            else if (state === window.YT.PlayerState.PAUSED) { if (lastSentRef.current.action !== 'pause' || Math.abs((lastSentRef.current.t||0)-t) > 0.5) { safeSend({ type:'yt', data:{ action:'pause', time:t, origin:selfIdRef.current } }); lastSentRef.current = { action:'pause', t }; } }
        }
      }
    });
  };

  useEffect(() => { if (window.YT?.Player) initYT(); else { const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.async = true; document.body.appendChild(s); window.onYouTubeIframeAPIReady = initYT; } }, []);
  // (Resizing effect moved below after cinemaMode declaration to avoid TDZ)

  const ytSeek = (delta: number) => { const p = ytPlayerRef.current; if (!p) return; const nt = Math.max(0, p.getCurrentTime()+delta); p.seekTo(nt, true); safeSend({ type:'yt', data:{ action:'seek', time: nt, origin:selfIdRef.current } }); };
  const ytSetRate = (rate: number) => { const p = ytPlayerRef.current; if (!p) return; p.setPlaybackRate(rate); setYtState(s => ({ ...s, rate })); safeSend({ type:'yt', data:{ action:'rate', rate, origin:selfIdRef.current } }); };
  const ytLoad = (videoId: string) => { const p = ytPlayerRef.current; if (!p || !videoId) return; setCurrentVideoId(videoId); lastSentRef.current = {}; p.loadVideoById(videoId,0); primeFrameRef.current = true; setTimeout(()=>{ try { p.playVideo(); setTimeout(()=>{ p.pauseVideo(); p.seekTo(0,true); const d=p.getDuration?.()||0; setYtState(s=>({...s,current:0,duration:d,playing:false})); progressRef.current && (progressRef.current.value='0'); },350);} catch {} },60); safeSend({ type:'yt', data:{ action:'load', videoId, origin:selfIdRef.current } }); };
  const ytTogglePlay = () => { const p = ytPlayerRef.current; if (!p) return; ytState.playing ? p.pauseVideo() : p.playVideo(); };
  const handleYTMessage = (data: (YTAction & { origin: string })) => {
    if (data.origin === selfIdRef.current) return; const p = ytPlayerRef.current; if (!p) return;
    if (data.action === 'play') { p.seekTo(data.time, true); p.playVideo(); }
    else if (data.action === 'pause') { p.seekTo(data.time, true); p.pauseVideo(); }
    else if (data.action === 'seek') { p.seekTo(data.time, true); }
    else if (data.action === 'rate') { p.setPlaybackRate(data.rate); }
    else if (data.action === 'load') { setCurrentVideoId(data.videoId); p.loadVideoById(data.videoId,0); primeFrameRef.current = true; setTimeout(()=>{ try { p.playVideo(); setTimeout(()=>{ p.pauseVideo(); p.seekTo(0,true); const d=p.getDuration?.()||0; setYtState(s=>({...s,current:0,duration:d,playing:false})); progressRef.current && (progressRef.current.value='0'); },350);} catch {} },50); lastSentRef.current = {}; }
  };

  /* -------- Cinema / HLS -------- */
  const [cinemaMode, setCinemaMode] = useState(false); // now only toggles 3D view (does NOT stop session)
  // removed ambientEnabled state (always on)
  // NEW: chat visibility + draggable position
  const [showChat, setShowChat] = useState(false);
  const [chatPos, setChatPos] = useState({ x: 0, y: 0 });
  const chatDragRef = useRef({ dragging:false, offsetX:0, offsetY:0, w:288, h:0 });
  const chatInitRef = useRef(false);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const videoProxyRef = useRef<HTMLVideoElement | null>(null); // Restored hidden cinema playback video element ref
  // Drag logic for chat (missing previously)
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!chatDragRef.current.dragging) return;
      e.preventDefault();
      setChatPos(p => {
        let nx = e.clientX - chatDragRef.current.offsetX;
        let ny = e.clientY - chatDragRef.current.offsetY;
        const w = chatDragRef.current.w || 288;
        const h = chatDragRef.current.h || 400;
        const maxX = window.innerWidth - w - 8;
        const maxY = window.innerHeight - h - 8;
        if (nx < 0) nx = 0; if (ny < 0) ny = 0; if (nx > maxX) nx = maxX; if (ny > maxY) ny = maxY;
        return { x: nx, y: ny };
      });
    };
    const up = () => { chatDragRef.current.dragging = false; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);

  const [cinemaSession, setCinemaSession] = useState<{ id: string; playlist: string } | null>(null);
  // New landing UI states
  const [videoInput, setVideoInput] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string|null>(null);
  const [recentVideos, setRecentVideos] = useState<string[]>([]);
  const [cinemaAudioOn, setCinemaAudioOn] = useState(false);
  const [micMutedDuringCinema, setMicMutedDuringCinema] = useState(false);
  const [cinemaPaused, setCinemaPaused] = useState(false);
  const [cinemaUserStarted, setCinemaUserStarted] = useState(false);
  const cinemaUserStartedRef = useRef(false);
  const hlsRef = useRef<Hls | null>(null);
  const pendingCinemaCmdRef = useRef<{ action: 'play' | 'pause'; t: number } | null>(null);
  // Sync helpers
  const suppressBroadcastRef = useRef(false);
  const lastBroadcastRef = useRef<{ action: 'play' | 'pause' | null; t: number; baseAt?: number }>({ action:null, t:0 });
  const DRIFT_THRESHOLD = 0.6;
  const cinemaSeqRef = useRef(0);
  const lastRecvSeqRef = useRef(0);
  const lastRemoteActionRef = useRef<{action:'play'|'pause'; at:number} | null>(null);
  const attachInProgressRef = useRef(false);
  const bootstrappedSessionRef = useRef<string | null>(null);

  // Removed auto media event broadcast (was causing loops). We now only send play/pause via explicit user actions (buttons/click) not raw media events.
  // Optional drift monitor (logs only)
  useEffect(() => {
    const id = setInterval(() => {
      const el = videoProxyRef.current; if (!el || el.paused) return;
      // Only log; actual correction happens when commands received.
      if (lastBroadcastRef.current.action === 'play') {
        const drift = Math.abs(el.currentTime - lastBroadcastRef.current.t);
        if (drift > DRIFT_THRESHOLD + 0.3) console.debug('[cinema][drift-check] local drift vs last broadcast', drift.toFixed(2));
      }
    }, 5000);
    return () => clearInterval(id);
  }, [cinemaSession]);

  // Resizing effect (placed after cinemaMode declaration)
  useEffect(() => { const p = ytPlayerRef.current; if (!p) return; try { p.setSize((cinemaMode || showYTDebug) ? 320 : 1, (cinemaMode || showYTDebug) ? 270 : 1); } catch {}; }, [cinemaMode, showYTDebug]);

  const attachHLS = async (playlist: string, remote = false) => {
    if (attachInProgressRef.current) { return; }
    attachInProgressRef.current = true;
    const el = videoProxyRef.current; if (!el) { attachInProgressRef.current=false; return; }
    el.muted = true; el.volume = 1; setCinemaAudioOn(false); setMicMutedDuringCinema(false);
    const full = (process.env.NEXT_PUBLIC_BACKEND_HTTP || 'http://localhost:8001') + playlist;
    let firstManifest = true;
    const prime = () => {
      let kicked = false;
      const onPlaying = () => { if (kicked) return; kicked = true; setTimeout(()=>{ try { el.pause(); el.play().catch(()=>{}); } catch {} }, 120); el.removeEventListener('playing', onPlaying); };
      el.addEventListener('playing', onPlaying);
    };
    prime();
    const setup = (H: any) => {
      const done = () => { attachInProgressRef.current=false; };
      if (H && H.isSupported && H.isSupported()) {
        const hls = new H({ enableWorker: true, lowLatencyMode: false, liveSyncDurationCount: 3, maxBufferLength: 60, maxBufferSize: 120*1e6 });
        hlsRef.current = hls; hls.loadSource(full); hls.attachMedia(el);
        hls.on(H.Events.MANIFEST_PARSED, () => {
          if (firstManifest) { try { el.currentTime = 0; } catch {}; firstManifest=false; }
          if (pendingCinemaCmdRef.current) {
            const c = pendingCinemaCmdRef.current; pendingCinemaCmdRef.current=null;
            try { el.currentTime = c.t; } catch {};
            if (c.action==='play') { el.play().catch(()=>{}); setCinemaPaused(false);} else { el.pause(); setCinemaPaused(true); }
          }
          if (cinemaUserStartedRef.current && !cinemaPaused) el.play().catch(()=>{});
          done();
        });
        hls.on(H.Events.ERROR, (_e: any, data: any) => {
          if (data?.fatal) {
            if (data.type==='mediaError') { try { hls.recoverMediaError(); } catch {} }
            else if (data.type==='networkError') { try { hls.stopLoad(); hls.startLoad(el.currentTime); } catch {} }
          }
        });
      } else if (el.canPlayType('application/vnd.apple.mpegurl')) { el.src = full; attachInProgressRef.current=false; }
      else { el.src = full; attachInProgressRef.current=false; }
    };
    try { const mod = await import('hls.js'); setup(mod.default || mod); } catch { setup(Hls); }
  };

  // Prime remote video for 3D scene texture (ensures at least one frame decoded)
  useEffect(() => {
    const v = cinemaSession ? videoProxyRef.current : remoteVideoRef.current; if (!cinemaMode || !v) return;
    let done = false;
    const tryPrime = () => {
      if (!v || done) return;
      if (v.readyState >= 2 && v.videoWidth > 0) { done = true; return; }
      v.play().then(()=>{ setTimeout(()=>{ try { v.pause(); } catch {} }, 160); }).catch(()=>{});
      setTimeout(tryPrime, 600);
    };
    tryPrime();
  }, [cinemaMode, cinemaSession]);

  const startCinemaFor = async (videoId: string) => {
    if (!videoId || launching) return;
    setLaunchError(null); setLaunching(true);
    try {
      const r = await fetch((process.env.NEXT_PUBLIC_BACKEND_HTTP || 'http://localhost:8001') + '/cinema/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ videoId }) });
      if (r.status === 403) { setLaunchError('Vidéo nécessite authentification (cookies).'); setLaunching(false); return; }
      if (!r.ok) { setLaunchError('Erreur démarrage'); setLaunching(false); return; }
      const j = await r.json();
      setCinemaSession({ id:j.sessionId, playlist:j.playlist });
      safeSend({ type:'cinema', data:{ action:'start', id:j.sessionId, playlist:j.playlist, origin:selfIdRef.current } });
      setCinemaUserStarted(false); cinemaUserStartedRef.current=false; setCinemaPaused(false);
      setTimeout(()=>attachHLS(j.playlist), 300);
      setLaunching(false);
      setRecentVideos(v => [videoId, ...v.filter(x => x!==videoId)].slice(0,6));
    } catch { setLaunchError('Exception'); setLaunching(false); }
  };
  // Legacy prompt function removal (keep name compatibility)
  const startCinemaStream = async () => {
    const vid = parseYouTubeId(videoInput);
    if (!vid) { setLaunchError('ID/URL invalide'); return; }
    await startCinemaFor(vid);
  };
  const stopCinemaStream = async () => { /* modified: does not alter cinemaMode */
    if (!cinemaSession) return; const old = cinemaSession;
    try { await fetch((process.env.NEXT_PUBLIC_BACKEND_HTTP || 'http://localhost:8001') + '/cinema/stop/' + old.id, { method:'POST' }); } catch {}
    safeSend({ type:'cinema', data:{ action:'stop', id: old.id, origin:selfIdRef.current } });
    const el = videoProxyRef.current; if (el) { el.pause(); el.muted = true; el.removeAttribute('src'); el.load(); }
    if (micMutedDuringCinema) localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = true);
    setCinemaAudioOn(false); setMicMutedDuringCinema(false); setCinemaPaused(false); setCinemaUserStarted(false); cinemaUserStartedRef.current=false; hlsRef.current=null; setCinemaSession(null);
  };
  const playCinema = () => { const el = videoProxyRef.current; if (!el) return; console.debug('[cinema][local] playCinema()'); hlsRef.current?.startLoad?.(); suppressBroadcastRef.current = true; el.play().catch(()=>{}).finally(()=>{ setTimeout(()=>{ suppressBroadcastRef.current=false; },180); }); if (!cinemaUserStartedRef.current){ cinemaUserStartedRef.current=true; setCinemaUserStarted(true);} setCinemaPaused(false); const t = el.currentTime; lastBroadcastRef.current={action:'play', t, baseAt: performance.now()}; const seq=++cinemaSeqRef.current; console.debug('[cinema][broadcast] play (button)', t, 'seq', seq); safeSend({ type:'cinema', data:{ action:'play', t, origin:selfIdRef.current, id:cinemaSession?.id, playlist:cinemaSession?.playlist, seq } }); };
  const pauseCinema = () => { const el = videoProxyRef.current; if (!el) return; console.debug('[cinema][local] pauseCinema()'); suppressBroadcastRef.current = true; el.pause(); setTimeout(()=>{ suppressBroadcastRef.current=false; },180); setCinemaPaused(true); const t = el.currentTime; lastBroadcastRef.current={action:'pause', t}; const seq=++cinemaSeqRef.current; console.debug('[cinema][broadcast] pause (button)', t, 'seq', seq); safeSend({ type:'cinema', data:{ action:'pause', t, origin:selfIdRef.current, id:cinemaSession?.id, playlist:cinemaSession?.playlist, seq } }); };
  const enableCinemaAudio = () => { const el = videoProxyRef.current; if (!el) return; el.muted=false; el.play().catch(()=>{}); setCinemaAudioOn(true); };

  const handleCinemaMessage = async (data: CinemaMsg) => {
    if (data.origin === selfIdRef.current) return; let el = videoProxyRef.current;
    if (data.seq && data.seq <= lastRecvSeqRef.current) { console.debug('[cinema][recv][stale]', data.seq, '<=', lastRecvSeqRef.current); return; }
    if (data.seq) lastRecvSeqRef.current = data.seq;
    const now = performance.now();
    if (lastRemoteActionRef.current && lastRemoteActionRef.current.action === data.action && (now - lastRemoteActionRef.current.at) < 180) {
      return; // tighter debounce
    }
    lastRemoteActionRef.current = { action: data.action as 'play'|'pause', at: now };
    console.debug('[cinema][recv]', data);
    if (data.action === 'start') {
      if (cinemaSession && cinemaSession.id === data.id) return; if (cinemaSession && cinemaSession.id !== data.id) await stopCinemaStream();
      if (!data.id || !data.playlist) return; setCinemaSession({ id:data.id, playlist:data.playlist }); bootstrappedSessionRef.current=data.id; setCinemaUserStarted(false); cinemaUserStartedRef.current=false; setTimeout(()=>attachHLS(data.playlist!, true), 300); return;
    }
    if (data.action === 'stop') { if (cinemaSession && cinemaSession.id === data.id) await stopCinemaStream(); return; }

    // Bootstrap session if absent
    if (!cinemaSession && data.id && data.playlist) {
      if (bootstrappedSessionRef.current === data.id) {
        // already queued a bootstrap; skip duplicate
      } else {
        console.debug('[cinema][bootstrap from play/pause]');
        bootstrappedSessionRef.current = data.id;
        setCinemaSession({ id: data.id, playlist: data.playlist });
        setTimeout(()=>attachHLS(data.playlist!, true), 200);
      }
    }

    if (!el) {
      const v = document.createElement('video'); v.playsInline=true; v.muted=true; v.style.display='none'; document.body.appendChild(v); videoProxyRef.current=v; el=v;
      if ((cinemaSession || data.playlist) && !hlsRef.current && (data.playlist || cinemaSession?.playlist)) attachHLS(data.playlist || cinemaSession!.playlist, true);
    }

    if (!cinemaSession && !(data.id && data.playlist)) {
      if ((data.action==='play'||data.action==='pause') && typeof data.t==='number') pendingCinemaCmdRef.current={ action:data.action, t:data.t };
      return;
    }

    if (el && el.readyState < 1 && !hlsRef.current && (cinemaSession?.playlist || data.playlist)) attachHLS(data.playlist || cinemaSession!.playlist, true);

    if (el.readyState < 1) {
      if ((data.action==='play'||data.action==='pause') && typeof data.t==='number') pendingCinemaCmdRef.current={ action:data.action, t:data.t };
      return;
    }

    // Drift logic: only correct on play if >1.2s, on pause if >0.8s
    if (typeof data.t === 'number') {
      const cur = el.currentTime;
      const drift = cur - data.t;
      const limit = data.action==='play' ? 1.2 : 0.8;
      if (Math.abs(drift) > limit) { try { el.currentTime = data.action==='pause'? data.t : (data.t + 0.06); } catch {} }
    }

    suppressBroadcastRef.current = true;
    if (!cinemaUserStartedRef.current) { cinemaUserStartedRef.current=true; setCinemaUserStarted(true); }
    if (data.action==='play') {
      if (!el.paused) { /* already playing */ }
      else { el.play().catch(()=>{}); }
      setCinemaPaused(false);
    } else if (data.action==='pause') {
      if (el.paused) { /* already paused */ }
      else { el.pause(); }
      setCinemaPaused(true);
    }
    setTimeout(()=>{ suppressBroadcastRef.current=false; }, 140);
  };

  /* -------- Draggable / Resizable local+remote videos -------- */
  const [box, setBox] = useState({ x:40, y:40, w:640, h:360 });
  const dragRef = useRef({ dragging:false, resizing:false, offsetX:0, offsetY:0, startW:0, startH:0, startX:0, startY:0 });
  const startDrag = (e: React.PointerEvent) => { if ((e.target as HTMLElement).dataset.rs==='true') return; dragRef.current.dragging=true; dragRef.current.offsetX=e.clientX-box.x; dragRef.current.offsetY=e.clientY-box.y; };
  const startResize = (e: React.PointerEvent) => { e.stopPropagation(); dragRef.current.resizing=true; dragRef.current.startW=box.w; dragRef.current.startH=box.h; dragRef.current.startX=e.clientX; dragRef.current.startY=e.clientY; };
  useEffect(() => { const onMove = (e: PointerEvent) => { const d=dragRef.current; if(!d.dragging && !d.resizing) return; e.preventDefault(); if(d.dragging){ setBox(b=>({...b, x:Math.max(0,e.clientX-d.offsetX), y:Math.max(0,e.clientY-d.offsetY)})); } else if (d.resizing) { setBox(b=>({...b, w:Math.max(260,d.startW+(e.clientX-d.startX)), h:Math.max(160,d.startH+(e.clientY-d.startY))})); } }; const end = () => { dragRef.current.dragging=false; dragRef.current.resizing=false; }; window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', end); return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', end); }; }, []);

  /* -------- Chat -------- */
  const [chatMessages, setChatMessages] = useState<{ id: string; text: string; ts: number }[]>([]);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const chatFocusRef = useRef(false);
  const sendChat = () => {
    const v = chatInputRef.current?.value;
    if (!v) return;
    const text = v.trim();
    if (!text) {
      if (chatInputRef.current) chatInputRef.current.value = '';
      return;
    }
    const msg = { id: selfIdRef.current, text, ts: Date.now() };
    setChatMessages(m => [...m.slice(-199), msg]);
    safeSend({ type: 'chat', data: msg });
    if (chatInputRef.current) chatInputRef.current.value = '';
  };
  // Block global shortcuts while typing (c, p, space, etc.)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!chatFocusRef.current) return;
      // stop propagation so higher-level listeners (cinema shortcuts) don't fire
      e.stopPropagation();
      // Enter without Shift submits
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  /* ============================ Render ============================ */
  return (
    <main className="w-full h-screen overflow-hidden relative select-none">
      {/* 3D immersive view */}
      {cinemaMode && cinemaSession && (
        <div className="absolute inset-0 z-0 bg-black">
          <CinemaScene
            mainVideoEl={videoProxyRef.current || remoteVideoRef.current}
            localVideoEl={localVideoRef.current}
            remoteVideoEl={remoteVideoRef.current}
            videoEl={videoProxyRef.current || remoteVideoRef.current}
            enabled
            ambientEnabled={true}
            showPlayOverlay={!!cinemaSession && !cinemaUserStarted}
            onPlayClick={() => { const el = videoProxyRef.current; if (!el) return; cinemaUserStartedRef.current=true; setCinemaUserStarted(true); el.muted=false; el.play().then(()=>{ setCinemaAudioOn(true); setCinemaPaused(false); safeSend({ type:'cinema', data:{ action:'play', t: el.currentTime, origin:selfIdRef.current } }); }).catch(()=>{ setTimeout(()=> el.play().catch(()=>{}), 250); }); }}
            onPlayPauseHotkey={() => { const el = videoProxyRef.current; if (!el) return; el.paused? playCinema(): pauseCinema(); }}
          />
        </div>
      )}
      {/* 2D video surface (when session active and not in 3D) */}
      {cinemaSession && !cinemaMode && (
        <div className="absolute inset-0 flex items-center justify-center px-6 pt-20 pb-28 pointer-events-none">
          <div className="relative w-full max-w-4xl aspect-video rounded-2xl overflow-hidden bg-black border border-neutral-800 shadow-lg pointer-events-auto">
            <video ref={videoProxyRef} playsInline onClick={()=>{ const v=videoProxyRef.current; if(!v) return; v.paused? playCinema(): pauseCinema(); }} className="w-full h-full object-cover" muted={!cinemaAudioOn} />
            {!cinemaUserStarted && (
              <button
                onClick={()=>{ const el=videoProxyRef.current; if(!el) return; cinemaUserStartedRef.current=true; setCinemaUserStarted(true); el.muted=true; suppressBroadcastRef.current=true; el.play().then(()=>{ setCinemaPaused(false); const t=el.currentTime; lastBroadcastRef.current={action:'play', t}; suppressBroadcastRef.current=false; const seq=++cinemaSeqRef.current; safeSend({ type:'cinema', data:{ action:'play', t, origin:selfIdRef.current, id:cinemaSession?.id, playlist:cinemaSession?.playlist, seq } }); }).catch(()=>{ suppressBroadcastRef.current=false; }); }}
                className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-sm text-white text-sm font-medium"
              >Démarrer (lecture muette synchronisée)</button>
            )}
            {cinemaUserStarted && cinemaPaused && (
              <button onClick={()=>playCinema()} className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-sm font-medium">Lecture</button>
            )}
            {/* Hint to enable audio */}
            {cinemaUserStarted && !cinemaAudioOn && !cinemaPaused && (
              <div className="absolute bottom-2 right-2 px-2 py-1 rounded-md bg-neutral-900/70 text-[11px] text-neutral-300">Activer audio via 🔊</div>
            )}
          </div>
        </div>
      )}
      {/* Landing input card (no active session) */}
      {!cinemaSession && (
        <div className="absolute inset-0 flex items-center justify-center px-6 pt-24 pb-32">
          <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-950/70 backdrop-blur-xl p-6 flex flex-col gap-4 shadow-[0_0_0_1px_rgba(255,255,255,0.05),0_30px_80px_-30px_rgba(0,0,0,0.6)]">
            <div>
              <h2 className="text-sm font-semibold tracking-wide text-neutral-200">Projeter une vidéo</h2>
              <p className="text-xs text-neutral-500 mt-1 leading-relaxed">Collez un lien YouTube ou un ID. La vidéo sera prête, puis vous pourrez basculer entre vue 2D et cinéma 3D.</p>
            </div>
            <form onSubmit={e=>{ e.preventDefault(); const vid=parseYouTubeId(videoInput); if(!vid){ setLaunchError('ID/URL invalide'); return;} startCinemaFor(vid); }} className="flex gap-2 items-center">
              <input value={videoInput} onChange={e=>{ setVideoInput(e.target.value); setLaunchError(null); }} placeholder="Lien ou ID YouTube" className="flex-1 h-10 rounded-lg px-3 bg-neutral-900/70 border border-neutral-700 focus:border-neutral-500 outline-none text-sm text-neutral-200 placeholder-neutral-500" />
              <button type="submit" disabled={launching} className="h-10 px-4 rounded-lg bg-white text-neutral-900 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-neutral-200 transition">{launching? '...' : 'Lancer'}</button>
            </form>
            {launchError && <div className="text-xs text-red-400 font-medium">{launchError}</div>}
            {recentVideos.length>0 && (
              <div className="flex flex-wrap gap-2 mt-1">
                {recentVideos.map(v => <button key={v} onClick={()=>startCinemaFor(v)} className="px-2.5 py-1.5 text-[11px] rounded-md bg-neutral-800/70 hover:bg-neutral-700 text-neutral-300 font-mono tracking-wide">{v}</button>)}
              </div>
            )}
            <div className="pt-1 border-t border-neutral-800 flex items-center justify-between text-[10px] text-neutral-500">
              <span>Salle {roomId}</span>
              <span>{status}</span>
            </div>
          </div>
        </div>
      )}
      {/* Status small badge (keep) */}
      <div className="absolute top-2 left-2 text-[11px] text-neutral-400 font-mono pointer-events-none z-30">Salle {roomId} | {status}</div>
      {/* Local/remote draggable composite stays above landing & 2D surfaces (hidden in 3D) */}
      <div
        onPointerDown={startDrag}
        style={{ transform:`translate(${box.x}px, ${box.y}px)`, width:box.w, height:box.h }}
        className={`fixed z-40 rounded-xl overflow-hidden shadow-lg cursor-grab active:cursor-grabbing transition-all duration-300 ${cinemaMode ? 'opacity-0 pointer-events-none scale-95' : ''}`}
        aria-hidden={cinemaMode}
      >
        <div className="w-full h-full flex bg-black">
          <video ref={localVideoRef} autoPlay playsInline muted className="w-1/2 h-full object-cover" />
          <video ref={remoteVideoRef} autoPlay playsInline className={`w-1/2 h-full object-cover transition-opacity duration-300 ${cinemaMode ? 'opacity-0 pointer-events-none' : ''}`} />
        </div>
        <div data-rs="true" onPointerDown={startResize} className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize" style={{ touchAction:'none' }} />
      </div>

      {/* Control Panel - minimal vercel-like */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center z-50">
        <div className="pointer-events-auto flex items-center gap-3 rounded-full px-4 py-2 bg-neutral-950/70 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/55 border border-neutral-800 shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_8px_24px_-6px_rgba(0,0,0,0.6)]">
          {cinemaSession && (
            <button title={cinemaMode? 'Vue 2D' : 'Vue 3D'} onClick={()=> setCinemaMode(m=>!m)} className="h-8 w-8 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-neutral-800/70 active:bg-neutral-700 transition">{cinemaMode? '🗗':'🎬'}</button>
          )}
          {!cinemaSession && (
            <button disabled className="h-8 w-8 rounded-full flex items-center justify-center text-neutral-600 border border-neutral-800">🎬</button>
          )}
          {cinemaSession && (
            <>
              {cinemaUserStarted && !cinemaPaused && <button title="Pause" onClick={pauseCinema} className="h-8 w-8 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-neutral-800/60 active:bg-neutral-700 transition">❚❚</button>}
              {cinemaUserStarted && cinemaPaused && <button title="Lecture" onClick={playCinema} className="h-8 w-8 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-neutral-800/60 active:bg-neutral-700 transition">▶</button>}
              {!cinemaAudioOn && cinemaUserStarted && <button title="Activer audio" onClick={enableCinemaAudio} className="h-8 w-8 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-neutral-800/60 active:bg-neutral-700 transition">🔊</button>}
              <button title="Arrêter" onClick={stopCinemaStream} className="h-8 w-8 rounded-full flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800/60 active:bg-neutral-700 transition">✕</button>
            </>
          )}
          <div className="w-px h-6 bg-neutral-800" />
          <button title={showChat? 'Masquer chat':'Afficher chat'} onClick={() => setShowChat(c=>!c)} className={`h-8 w-8 rounded-full flex items-center justify-center transition ${showChat? 'text-neutral-300 bg-neutral-800/60 hover:bg-neutral-700 active:bg-neutral-600':'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50'}`}>💬</button>
        </div>
      </div>

      {/* Chat Panel */}
      {showChat && (
        <div
          ref={chatRef}
          className="fixed z-50 flex flex-col w-72 h-[65vh] rounded-xl bg-neutral-950/80 backdrop-blur-md border border-neutral-800 shadow-[0_0_0_1px_rgba(255,255,255,0.05),0_20px_40px_-10px_rgba(0,0,0,0.55)] overflow-hidden"
          style={{ transform: `translate(${chatPos.x}px, ${chatPos.y}px)` }}
        >
          <div
            onPointerDown={(e) => {
              if (document.pointerLockElement) document.exitPointerLock?.();
              chatDragRef.current.dragging = true;
              const rect = chatRef.current?.getBoundingClientRect();
              chatDragRef.current.w = rect?.width || 288; chatDragRef.current.h = rect?.height || 400;
              chatDragRef.current.offsetX = e.clientX - chatPos.x;
              chatDragRef.current.offsetY = e.clientY - chatPos.y;
            }}
            className="h-9 px-3 flex items-center justify-between text-[11px] font-medium text-neutral-300 bg-neutral-900/60 border-b border-neutral-800 cursor-move select-none"
            title="Glisser pour déplacer"
          >
            <span className="tracking-wide uppercase">Chat</span>
            <span className="text-[10px] text-neutral-500 font-mono">{chatMessages.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 scrollbar-thin scrollbar-thumb-neutral-800/70 scrollbar-track-transparent" role="log" aria-live="polite">
            {chatMessages.map(m => {
              const own = m.id === selfIdRef.current;
              return (
                <div key={m.ts + m.id} className={`group px-3 py-2 rounded-lg border text-[12px] leading-snug break-words max-w-full ${own? 'bg-neutral-800/70 border-neutral-700 text-neutral-50 ml-6':'bg-neutral-900/60 border-neutral-800 text-neutral-300 mr-6'} shadow-sm`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] font-mono ${own? 'text-neutral-400':'text-neutral-500'}`}>{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <span className={`text-[10px] font-semibold ${own? 'text-neutral-200':'text-neutral-400'}`}>{m.id.slice(0,4)}</span>
                  </div>
                  <span>{m.text}</span>
                </div>
              );
            })}
          </div>
          <form onSubmit={e => { e.preventDefault(); sendChat(); }} className="p-2 flex gap-2 border-t border-neutral-800 bg-neutral-900/60">
            <input
              ref={chatInputRef}
              onFocus={() => { chatFocusRef.current = true; }}
              onBlur={() => { chatFocusRef.current = false; }}
              className="flex-1 bg-neutral-800/70 focus:bg-neutral-800 text-[12px] rounded-md px-3 py-2 outline-none border border-neutral-700 focus:border-neutral-500 text-neutral-200 placeholder-neutral-500 transition"
              placeholder="Message..."
              maxLength={240}
              autoComplete="off"
              spellCheck={false}
              aria-label="Message"
            />
            <button type="submit" className="px-3 py-2 rounded-md bg-neutral-100 text-neutral-900 hover:bg-white active:bg-neutral-200 text-[12px] font-medium shadow-md">Env</button>
          </form>
        </div>
      )}
    </main>
  );
}
