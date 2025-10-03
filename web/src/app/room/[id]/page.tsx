"use client";

// Room page: WebRTC + WebSocket signaling + YouTube sync + Cinema (HLS) projection
// Objectif: même fonctionnalités que la version longue, code condensé & structuré.

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { CinemaScene } from "../../../components/CinemaScene";
import Hls from "hls.js";

/* ============================ Types ============================ */
type YTAction =
  | { action: "load"; videoId: string }
  | { action: "play" | "pause" | "seek"; time: number }
  | { action: "rate"; rate: number };

type CinemaMsg = { action: 'play' | 'pause' | 'start' | 'stop'; t?: number; id?: string; playlist?: string; origin: string };

type Msg =
  | { type: "system"; data: { event: "start_call" | "peer_left" } }
  | { type: "sdp"; data: RTCSessionDescriptionInit }
  | { type: "ice"; data: RTCIceCandidateInit }
  | { type: "yt"; data: YTAction & { origin: string } }
  | { type: "cinema"; data: CinemaMsg }
  | { type: "chat"; data: { id: string; text: string; ts: number } };

declare global { interface Window { YT: any; onYouTubeIframeAPIReady: () => void; } }

/* ============================ Utils ============================ */
const fmtTime = (t: number) => !isFinite(t) ? "0:00" : `${Math.floor(t/60)}:${Math.floor(t%60).toString().padStart(2,'0')}`;

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
  const ytPlayerRef = useRef<any>(null);
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
  const [cinemaMode, setCinemaMode] = useState(false);
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
  const [cinemaAudioOn, setCinemaAudioOn] = useState(false);
  const [micMutedDuringCinema, setMicMutedDuringCinema] = useState(false);
  const [cinemaPaused, setCinemaPaused] = useState(false);
  const [cinemaUserStarted, setCinemaUserStarted] = useState(false);
  const cinemaUserStartedRef = useRef(false);
  const hlsRef = useRef<any>(null);
  const pendingCinemaCmdRef = useRef<{ action: 'play' | 'pause'; t: number } | null>(null);

  // Resizing effect (placed after cinemaMode declaration)
  useEffect(() => { const p = ytPlayerRef.current; if (!p) return; try { p.setSize((cinemaMode || showYTDebug) ? 320 : 1, (cinemaMode || showYTDebug) ? 270 : 1); } catch {}; }, [cinemaMode, showYTDebug]);

  const attachHLS = async (playlist: string, remote = false) => {
    const el = videoProxyRef.current; if (!el) return;
    el.muted = true; el.volume = 1; setCinemaAudioOn(false); setMicMutedDuringCinema(false);
    const full = (process.env.NEXT_PUBLIC_BACKEND_HTTP || 'http://localhost:8001') + playlist;
    let firstManifest = true;
    // Prime helper to ensure a first decoded frame for Three.js texture
    const prime = () => {
      let kicked = false;
      const onPlaying = () => {
        if (kicked) return; kicked = true;
        // quick pause/play cycle to force frame flush
        setTimeout(()=>{ try { el.pause(); el.play().catch(()=>{}); } catch {} }, 120);
        el.removeEventListener('playing', onPlaying);
      };
      el.addEventListener('playing', onPlaying);
    };
    prime();
    const setup = (H: any) => {
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
        });
        hls.on(H.Events.ERROR, (_e: any, data: any) => {
          if (data?.fatal) {
            if (data.type==='mediaError') { try { hls.recoverMediaError(); } catch {} }
            else if (data.type==='networkError') { try { hls.stopLoad(); hls.startLoad(el.currentTime); } catch {} }
          }
        });
      } else if (el.canPlayType('application/vnd.apple.mpegurl')) { el.src = full; }
      else { el.src = full; }
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

  const startCinemaStream = async () => {
    if (cinemaSession) await stopCinemaStream();
    const vid = prompt('ID YouTube à projeter'); if (!vid) return;
    try {
      const r = await fetch((process.env.NEXT_PUBLIC_BACKEND_HTTP || 'http://localhost:8001') + '/cinema/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ videoId: vid }) });
      if (!r.ok) return alert('Erreur');
      const j = await r.json();
      setCinemaSession({ id: j.sessionId, playlist: j.playlist });
      safeSend({ type:'cinema', data:{ action:'start', id:j.sessionId, playlist:j.playlist, origin:selfIdRef.current } });
      setCinemaUserStarted(false); cinemaUserStartedRef.current = false; setCinemaPaused(false);
      setTimeout(()=>attachHLS(j.playlist), 500);
    } catch {}
  };
  const stopCinemaStream = async () => {
    if (!cinemaSession) return; const old = cinemaSession;
    try { await fetch((process.env.NEXT_PUBLIC_BACKEND_HTTP || 'http://localhost:8001') + '/cinema/stop/' + old.id, { method:'POST' }); } catch {}
    safeSend({ type:'cinema', data:{ action:'stop', id: old.id, origin:selfIdRef.current } });
    const el = videoProxyRef.current; if (el) { el.pause(); el.muted = true; el.removeAttribute('src'); el.load(); }
    if (micMutedDuringCinema) localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = true);
    setCinemaAudioOn(false); setMicMutedDuringCinema(false); setCinemaPaused(false); setCinemaUserStarted(false); cinemaUserStartedRef.current=false; hlsRef.current=null; setCinemaSession(null);
  };
  const playCinema = () => { const el = videoProxyRef.current; if (!el) return; hlsRef.current?.startLoad?.(); el.play().catch(()=>{}); if (!cinemaUserStartedRef.current){ cinemaUserStartedRef.current=true; setCinemaUserStarted(true);} setCinemaPaused(false); safeSend({ type:'cinema', data:{ action:'play', t: el.currentTime, origin:selfIdRef.current } }); };
  const pauseCinema = () => { const el = videoProxyRef.current; if (!el) return; el.pause(); hlsRef.current?.stopLoad?.(); setCinemaPaused(true); safeSend({ type:'cinema', data:{ action:'pause', t: el.currentTime, origin:selfIdRef.current } }); };
  const enableCinemaAudio = () => { const el = videoProxyRef.current; if (!el) return; el.muted=false; el.play().catch(()=>{}); setCinemaAudioOn(true); };

  const handleCinemaMessage = async (data: CinemaMsg) => {
    if (data.origin === selfIdRef.current) return; const el = videoProxyRef.current;
    if (data.action === 'start') {
      if (cinemaSession && cinemaSession.id === data.id) return; if (cinemaSession && cinemaSession.id !== data.id) await stopCinemaStream();
      if (!data.id || !data.playlist) return; setCinemaSession({ id:data.id, playlist:data.playlist }); setCinemaUserStarted(false); cinemaUserStartedRef.current=false; setTimeout(()=>attachHLS(data.playlist!, true), 300); return;
    }
    if (data.action === 'stop') { if (cinemaSession && cinemaSession.id === data.id) await stopCinemaStream(); return; }
    if (!el || !cinemaSession) { if ((data.action==='play'||data.action==='pause') && typeof data.t==='number') pendingCinemaCmdRef.current = { action:data.action, t:data.t }; return; }
    if (data.action==='play' && typeof data.t==='number') { try { el.currentTime = data.t; } catch {}; if (!cinemaUserStartedRef.current){ cinemaUserStartedRef.current=true; setCinemaUserStarted(true);} el.play().catch(()=>{}); setCinemaPaused(false); }
    else if (data.action==='pause' && typeof data.t==='number') { try { el.currentTime = data.t; } catch {}; el.pause(); setCinemaPaused(true); }
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
      {cinemaMode && (
        <div className="absolute inset-0 z-0 bg-black">
          <CinemaScene
            mainVideoEl={cinemaSession ? videoProxyRef.current : remoteVideoRef.current}
            localVideoEl={localVideoRef.current}
            remoteVideoEl={remoteVideoRef.current}
            videoEl={cinemaSession ? videoProxyRef.current : remoteVideoRef.current}
            enabled
            ambientEnabled={true}
            showPlayOverlay={!!cinemaSession && !cinemaUserStarted}
            onPlayClick={() => { const el = videoProxyRef.current; if (!el) return; cinemaUserStartedRef.current=true; setCinemaUserStarted(true); el.muted=false; el.play().then(()=>{ setCinemaAudioOn(true); setCinemaPaused(false); safeSend({ type:'cinema', data:{ action:'play', t: el.currentTime, origin:selfIdRef.current } }); }).catch(()=>{ setTimeout(()=> el.play().catch(()=>{}), 250); }); }}
            onPlayPauseHotkey={() => { const el = videoProxyRef.current; if (!el) return; el.paused? playCinema(): pauseCinema(); }}
          />
        </div>
      )}

      <div className="absolute top-2 left-2 text-xs text-neutral-400 font-mono pointer-events-none z-30">Salle {roomId} | {status}</div>

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
          <button
            title={cinemaMode? 'Retour 2D (stop)': 'Mode cinéma'}
            onClick={() => {
              if (cinemaMode) {
                if (cinemaSession) stopCinemaStream();
                setCinemaMode(false);
              } else {
                setCinemaMode(true);
              }
            }}
            className="h-8 w-8 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-neutral-800/70 active:bg-neutral-700 transition"
          >
            {cinemaMode ? '🗗' : '🎬'}
          </button>
          {/* Removed ambient toggle (always on) */}
          {!cinemaSession && (
            <button title="Projeter une vidéo" onClick={startCinemaStream} className="h-8 px-3 rounded-full text-[12px] font-medium bg-neutral-100 text-neutral-900 hover:bg-white active:bg-neutral-200 transition">Projeter</button>
          )}
          {cinemaSession && (
            <>
              {/* Removed stop button (exit via retour 2D) */}
              {cinemaUserStarted && !cinemaPaused && <button title="Pause" onClick={pauseCinema} className="h-8 w-8 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-neutral-800/60 active:bg-neutral-700 transition">❚❚</button>}
              {cinemaUserStarted && cinemaPaused && <button title="Lecture" onClick={playCinema} className="h-8 w-8 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-neutral-800/60 active:bg-neutral-700 transition">▶</button>}
              {!cinemaAudioOn && <button title="Activer audio" onClick={enableCinemaAudio} className="h-8 w-8 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-neutral-800/60 active:bg-neutral-700 transition">🔊</button>}
            </>
          )}
          <div className="w-px h-6 bg-neutral-800" />
          {/* Removed YouTube play/pause button */}
          <div className="flex items-center gap-2 w-[480px] max-w-[60vw]">
            <input
              ref={progressRef}
              type="range" min={0} max={1000} defaultValue={0}
              className="flex-1 accent-neutral-300 h-2 rounded-full"
              onChange={e => { const p = ytPlayerRef.current; if (!p) return; const d = p.getDuration?.() || ytState.duration || 0; if (!d) return; const ratio=parseFloat(e.target.value)/1000; const nt=d*ratio; if(!isFinite(nt)) return; p.seekTo(nt,true); safeSend({ type:'yt', data:{ action:'seek', time:nt, origin:selfIdRef.current } }); }}
            />
            <span className="text-[11px] font-mono text-neutral-500 tabular-nums">{fmtTime(ytState.current)}</span>
          </div>
          {cinemaSession && cinemaAudioOn && (
            <div className="flex items-center gap-1 pl-1">
              <span className="text-[10px] text-neutral-500">Vol</span>
              <input type="range" min={0} max={1} step={0.01} defaultValue={1} className="w-24 accent-neutral-300 h-2" onChange={e => { if (videoProxyRef.current) videoProxyRef.current.volume = parseFloat(e.target.value); if (videoProxyRef.current && (videoProxyRef.current as any)._spatialGain) { (videoProxyRef.current as any)._spatialGain.gain.value = parseFloat(e.target.value); } }} />
            </div>
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

      <video ref={videoProxyRef} playsInline className="hidden" />
      <div ref={youtubeContainerRef} className={(cinemaMode || showYTDebug) ? "absolute bottom-24 right-4 w-80 h-48 bg-black/80 border border-purple-500 rounded overflow-hidden z-50" : "w-0 h-0 overflow-hidden"} />
    </main>
  );
}
