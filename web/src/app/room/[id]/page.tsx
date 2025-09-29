"use client";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { CinemaScene } from "../../../components/CinemaScene";
import Hls from 'hls.js';

// Messages échangés via WebSocket
// Ajout d'un nouveau type pour la synchronisation YouTube
type YTAction = { action: "load"; videoId: string } | { action: "play"; time: number } | { action: "pause"; time: number } | { action: "seek"; time: number } | { action: "rate"; rate: number };

type Msg =
  | { type: "system"; data: { event: "start_call" | "peer_left" } }
  | { type: "sdp"; data: RTCSessionDescriptionInit }
  | { type: "ice"; data: RTCIceCandidateInit }
  | { type: "yt"; data: YTAction & { origin: string } }
  | { type: "cinema"; data: { action: 'play' | 'pause' | 'start' | 'stop'; t?: number; id?: string; playlist?: string; origin: string } }; // new cinema sync

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

export default function Room() {
  const { id: roomId } = useParams<{ id: string }>();
  const wsBase = process.env.NEXT_PUBLIC_BACKEND_WS || "ws://localhost:8001/ws";
  const wsURL = `${wsBase}/${roomId}`;

  // WebSocket
  const wsRef = useRef<WebSocket | null>(null);
  const [wsReady, setWsReady] = useState(false);

  // WebRTC
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);

  // UI refs
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const youtubeContainerRef = useRef<HTMLDivElement | null>(null);
  const ytPlayerRef = useRef<any>(null);
  const ytReadyRef = useRef(false);
  const selfIdRef = useRef<string>(Math.random().toString(36).slice(2)); // stable id
  const lastSentRef = useRef<{ action?: string; t?: number }>({});
  const primeFrameRef = useRef(false); // ignorer événements de sync pendant priming
  const [ytState, setYtState] = useState({ current: 0, duration: 0, playing: false, rate: 1 });
  const progressRef = useRef<HTMLInputElement | null>(null);

  // État de connexion simple
  const [hasPeer, setHasPeer] = useState(false);
  const offerMadeRef = useRef(false);

  // Statut
  const [status, setStatus] = useState("Initialisation...");

  // Draggable & resizable box
  const [box, setBox] = useState({ x: 40, y: 40, w: 640, h: 360 });
  const dragRef = useRef<{ dragging: boolean; resizing: boolean; offsetX: number; offsetY: number; startW: number; startH: number; startX: number; startY: number }>({ dragging: false, resizing: false, offsetX: 0, offsetY: 0, startW: 0, startH: 0, startX: 0, startY: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d.dragging && !d.resizing) return;
    e.preventDefault();
    if (d.dragging) {
      const nx = e.clientX - d.offsetX;
      const ny = e.clientY - d.offsetY;
      setBox(b => ({ ...b, x: Math.max(0, nx), y: Math.max(0, ny) }));
    } else if (d.resizing) {
      const dw = e.clientX - d.startX;
      const dh = e.clientY - d.startY;
      setBox(b => ({ ...b, w: Math.max(260, d.startW + dw), h: Math.max(160, d.startH + dh) }));
    }
  };
  const endInteractions = () => { dragRef.current.dragging = false; dragRef.current.resizing = false; };

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove as any);
    window.addEventListener('pointerup', endInteractions);
    return () => {
      window.removeEventListener('pointermove', onPointerMove as any);
      window.removeEventListener('pointerup', endInteractions);
    };
  }, []);

  const startDrag = (e: React.PointerEvent) => {
    // Ignore if started on resize handle
    const target = e.target as HTMLElement;
    if (target.dataset.rs === 'true') return;
    dragRef.current.dragging = true;
    dragRef.current.offsetX = e.clientX - box.x;
    dragRef.current.offsetY = e.clientY - box.y;
  };
  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    dragRef.current.resizing = true;
    dragRef.current.startW = box.w;
    dragRef.current.startH = box.h;
    dragRef.current.startX = e.clientX;
    dragRef.current.startY = e.clientY;
  };

  // ---- Helpers ----
  const safeSend = (m: Msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(m));
    }
  };

  const ensurePC = () => {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] });
    pcRef.current = pc;

    // Préparer un MediaStream dédié pour regrouper les pistes distantes
    if (!remoteStreamRef.current) {
      remoteStreamRef.current = new MediaStream();
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }

    // Créer des transceivers bidirectionnels pour stabiliser l'offre même si les pistes locales ne sont pas encore prêtes
    try {
      const kinds = ["video", "audio"] as const;
      kinds.forEach(kind => {
        // Éviter doublons si déjà présent
        if (!pc.getTransceivers().some(t => t.receiver.track && t.receiver.track.kind === kind)) {
          pc.addTransceiver(kind, { direction: "sendrecv" });
        }
      });
    } catch {}

    // Ajout pistes locales si déjà dispo
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => {
        try { pc.addTrack(t, localStreamRef.current!); } catch {}
      });
    }

    pc.ontrack = (ev) => {
      console.log("Received remote track:", ev.track.kind, "ready state:", ev.track.readyState);
      const track = ev.track;
      
      // Mettre à jour le statut quand on reçoit de la vidéo
      if (track.kind === "video") {
        setStatus(s => s.includes("Vidéo reçue") ? s : s + " | Vidéo reçue");
      }
      if (!remoteStreamRef.current) {
        remoteStreamRef.current = new MediaStream();
      }
      // Nettoyer les anciennes pistes "ended" du même type avant d'ajouter la nouvelle
      const existingTracks = remoteStreamRef.current.getTracks().filter(t => 
        t.kind === track.kind && (t.readyState === "ended" || t.id === track.id)
      );
      existingTracks.forEach(t => {
        remoteStreamRef.current!.removeTrack(t);
      });
      
      // Ajouter la nouvelle piste live
      if (track.readyState === "live") {
        remoteStreamRef.current.addTrack(track);
        console.log(`Added ${track.kind} track:`, track.id, "state:", track.readyState);
      }
      
      // Mettre à jour le srcObject de la vidéo
      if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== remoteStreamRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
        console.log("Remote video source updated");
      }
      
      // Forcer lecture de la vidéo distante
      if (remoteVideoRef.current) {
        console.log("Forcing remote video play...");
        remoteVideoRef.current.play().catch((e) => {
          console.warn("Autoplay failed:", e);
          // Essayer de déclencher la lecture avec un clic utilisateur simulé
          const playVideo = () => {
            if (remoteVideoRef.current) {
              remoteVideoRef.current.play().catch(() => {});
              document.removeEventListener('click', playVideo);
            }
          };
          document.addEventListener('click', playVideo, { once: true });
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection state:", pc.connectionState);
      if (pc.connectionState === "connected") {
        setStatus("Connexion établie ✅");
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) safeSend({ type: "ice", data: ev.candidate.toJSON() });
    };

    return pc;
  };





  const handleRemoteSDP = async (desc: RTCSessionDescriptionInit) => {
    const pc = ensurePC();
    try {
      console.log("Received SDP:", desc.type);
      await pc.setRemoteDescription(desc);
      setStatus(desc.type === "offer" ? "Offre reçue" : "Réponse reçue");
      
      // Process pending ICE candidates
      while (pendingIce.current.length) {
        const c = pendingIce.current.shift();
        if (c) {
          try { await pc.addIceCandidate(c); } catch {}
        }
      }

      // If it's an offer, create answer
      if (desc.type === "offer") {
        console.log("Creating answer...");
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        safeSend({ type: "sdp", data: answer });
        console.log("Answer sent");
        setStatus("Réponse envoyée");
      } else if (desc.type === "answer") {
        console.log("Answer received, connection should be established");
        setStatus("Connexion établie");
      }
    } catch (e) {
      console.warn("Erreur SDP", e);
    }
  };

  const handleRemoteICE = async (cand: RTCIceCandidateInit) => {
    const pc = ensurePC();
    if (!pc.remoteDescription) { 
      pendingIce.current.push(cand); 
      return; 
    }
    try { 
      await pc.addIceCandidate(cand); 
    } catch (e) { 
      console.warn("ICE", e); 
    }
  };

  // Assure d'avoir le flux local (utile si on reçoit une offre avant d'avoir accepté la caméra)
  const ensureLocalStream = async () => {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      const pc = ensurePC();
      stream.getTracks().forEach(track => {
        if (!pc.getSenders().some(s => s.track && s.track.id === track.id)) {
          try { pc.addTrack(track, stream); } catch {}
        }
      });
      setStatus(s => s.includes("Caméra prête") ? s : "Caméra prête");
      return stream;
    } catch (e) {
      setStatus("Accès caméra refusé");
      throw e;
    }
  };

  // ---- Récupération média locale immédiate ----
  useEffect(() => {
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        const pc = ensurePC();
        // Ajouter les pistes si transceivers créés avant
        stream.getTracks().forEach(track => {
          if (!pc.getSenders().some(s => s.track && s.track.id === track.id)) {
            try { pc.addTrack(track, stream); } catch {}
          }
        });
        setStatus("Caméra prête");
      } catch {
        setStatus("Accès caméra refusé");
      }
    })();
    return () => { localStreamRef.current?.getTracks().forEach(t => t.stop()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- WebSocket ----
  useEffect(() => {
    const ws = new WebSocket(wsURL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsReady(true);
      setStatus(s => s + " | WS connecté");
    };
    ws.onclose = () => { setWsReady(false); };
    ws.onerror = () => {};
    ws.onmessage = async (ev) => {
      let msg: Msg; try { msg = JSON.parse(ev.data); } catch { return; }
      // console.log("WS RX:", msg.type, msg.data);
      if (msg.type === "yt") {
        if (msg.data.origin === selfIdRef.current) return; // ignore self
        const p = ytPlayerRef.current; if (!p) return;
        if (msg.data.action === 'play') { p.seekTo(msg.data.time, true); p.playVideo(); }
        else if (msg.data.action === 'pause') { p.seekTo(msg.data.time, true); p.pauseVideo(); }
        else if (msg.data.action === 'seek') { p.seekTo(msg.data.time, true); }
        else if (msg.data.action === 'rate') { p.setPlaybackRate(msg.data.rate); }
        else if (msg.data.action === 'load') {
          setCurrentVideoId(msg.data.videoId);
          p.loadVideoById(msg.data.videoId, 0);
          primeFrameRef.current = true;
          // Priming: play quelques ms puis pause pour afficher première frame
          setTimeout(() => {
            try { p.playVideo(); } catch {}
            setTimeout(() => {
              try { p.pauseVideo(); } catch {}
              try { p.seekTo(0, true); } catch {}
              const d = p.getDuration?.() || 0;
              setYtState(s => ({ ...s, current: 0, duration: d, playing: false }));
              if (progressRef.current) progressRef.current.value = '0';
              // primeFrameRef sera relâché par onStateChange une fois PAUSED reçu
            }, 350);
          }, 50);
          lastSentRef.current = {}; // reset events
          return;
        }
        return;
      }
      if (msg.type === "system") {
        const { event } = msg.data;
        
        if (event === "peer_left") {
          console.log("Peer left - resetting");
          setHasPeer(false);
          offerMadeRef.current = false;
          if (pcRef.current) {
            pcRef.current.close();
            pcRef.current = null;
          }
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
          }
          setStatus("En attente d'un autre participant...");
        }
        
        if (event === "start_call") {
          console.log("Start call - both clients ready");
          setHasPeer(true);
          offerMadeRef.current = false;
          setStatus(s => s.split(" | ")[0] + " | Démarrage de l'appel...");
          
          // Create offer directly without setTimeout to avoid state issues
          const createOfferNow = async () => {
            const pc = ensurePC();
            try {
              console.log("Creating offer immediately...");
              offerMadeRef.current = true;
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              safeSend({ type: "sdp", data: offer });
              console.log("Offer sent:", offer.type);
              setStatus("Offre envoyée");
            } catch (e) {
              console.warn("Erreur création offre", e);
              offerMadeRef.current = false;
            }
          };
          
          // Use a small random delay to avoid collision
          const delay = Math.random() * 500 + 100;
          setTimeout(createOfferNow, delay);
        }
        return;
      }
      
      if (msg.type === "sdp") { 
        await handleRemoteSDP(msg.data); 
        return; 
      }
      
      if (msg.type === "ice") {
        await handleRemoteICE(msg.data);
        return;
      }
      if (msg.type === 'cinema') {
        if (msg.data.origin === selfIdRef.current) return; // ignore self
        const el = videoProxyRef.current;
        if (msg.data.action === 'start') {
          // Remote started a cinema session: attach HLS without prompting
            if (cinemaSession && cinemaSession.id === msg.data.id) return; // already same
            // If different existing session, stop it first
            if (cinemaSession && cinemaSession.id !== msg.data.id) {
              await stopCinemaStream();
            }
            if (!msg.data.id || !msg.data.playlist) return;
            setCinemaSession({ id: msg.data.id, playlist: msg.data.playlist });
            setCinemaUserStarted(false); cinemaUserStartedRef.current = false;
            // Prepare HLS attach similar to startCinemaStream (remote)
            setTimeout(async () => {
              if (!videoProxyRef.current) return;
              const vEl = videoProxyRef.current;
              vEl.muted = true; // keep muted until user decides
              vEl.volume = 1;
              setCinemaAudioOn(false);
              setMicMutedDuringCinema(false);
              let firstPlayKick = true;
              const onFirstPlaying = () => {
                if (!firstPlayKick) return; firstPlayKick = false;
                setTimeout(() => { try { vEl.pause(); vEl.play().catch(()=>{}); } catch {} }, 120);
                vEl.removeEventListener('playing', onFirstPlaying);
              };
              vEl.addEventListener('playing', onFirstPlaying);
              const full = (process.env.NEXT_PUBLIC_BACKEND_HTTP || 'http://localhost:8001') + msg.data.playlist;
              let HlsDyn: any = null;
              try { const mod = await import('hls.js'); HlsDyn = mod.default || mod; } catch {}
              const H = HlsDyn;
              if (H && H.isSupported && H.isSupported()) {
                const hls = new H({ enableWorker: true, lowLatencyMode: false, liveSyncDurationCount: 3, maxBufferLength: 60, maxBufferSize: 120*1000*1000, maxLiveSyncPlaybackRate: 1.0, fragLoadingTimeOut: 20000, manifestLoadingTimeOut: 20000, autoStartLoad: true });
                hlsRef.current = hls; hls.loadSource(full); hls.attachMedia(vEl);
                let firstManifest = true;
                hls.on(H.Events.MANIFEST_PARSED, () => {
                  try { if (firstManifest) { vEl.currentTime = 0; firstManifest = false; } } catch {}
                  // Apply any pending play/pause received earlier
                  if (pendingCinemaCmdRef.current) {
                    const cmd = pendingCinemaCmdRef.current; pendingCinemaCmdRef.current = null;
                    try { vEl.currentTime = cmd.t; } catch {}
                    if (cmd.action === 'play') { vEl.play().catch(()=>{}); setCinemaPaused(false); }
                    else { vEl.pause(); setCinemaPaused(true); }
                  }
                });
              } else if (vEl.canPlayType('application/vnd.apple.mpegurl')) {
                vEl.src = full;
              } else { vEl.src = full; }
            }, 300);
          return;
        }
        if (msg.data.action === 'stop') {
          if (cinemaSession && cinemaSession.id === msg.data.id) {
            await stopCinemaStream();
          }
          return;
        }
        if (!el || !cinemaSession) {
          if ((msg.data.action === 'play' || msg.data.action === 'pause') && typeof msg.data.t === 'number') {
            pendingCinemaCmdRef.current = { action: msg.data.action, t: msg.data.t };
          }
          return;
        }
        if (msg.data.action === 'play' && typeof msg.data.t === 'number') {
          try { el.currentTime = msg.data.t; } catch {}
          // Marquer comme démarré si déclenché à distance (cache overlay)
          if (!cinemaUserStartedRef.current) { cinemaUserStartedRef.current = true; setCinemaUserStarted(true); }
          el.play().catch(()=>{}); // restera muted tant que l'utilisateur n'active pas le son
          setCinemaPaused(false);
        } else if (msg.data.action === 'pause' && typeof msg.data.t === 'number') {
          try { el.currentTime = msg.data.t; } catch {}
          el.pause();
          setCinemaPaused(true);
        }
        return;
      }
    };

    return () => { try { ws.close(); } catch {} };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsURL]);

  // ---- Cleanup PC ----
  useEffect(() => () => {
    try { pcRef.current?.close(); } catch {};
    pcRef.current = null;
  }, []);

  // Chargement dynamique API YouTube + init lecteur
  useEffect(() => {
    if (window.YT && window.YT.Player) {
      initPlayer();
    } else {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      document.body.appendChild(tag);
      window.onYouTubeIframeAPIReady = () => initPlayer();
    }
    function initPlayer() {
      if (ytPlayerRef.current || !youtubeContainerRef.current) return;
      ytPlayerRef.current = new window.YT.Player(youtubeContainerRef.current, {
        height: "1",
        width: "1",
        videoId: undefined, // pas de vidéo hardcodée
        playerVars: { rel: 0, playsinline: 1, controls: 0, modestbranding: 1, disablekb: 1, cc_load_policy: 1 },
        events: {
          onReady: () => {
            ytReadyRef.current = true;
            setInterval(() => {
              const p = ytPlayerRef.current; if (!p) return;
              const c = p.getCurrentTime?.() || 0; const d = p.getDuration?.() || 0; const r = p.getPlaybackRate?.() || 1;
              setYtState(s => ({ ...s, current: c, duration: d || s.duration, rate: r }));
              if (progressRef.current && !progressRef.current.matches(':active')) {
                progressRef.current.value = d ? String((c / d) * 1000) : '0';
              }
            }, 500);
          },
          onStateChange: (e: any) => {
            const state = e.data;
            const p = ytPlayerRef.current;
            if (!p) return;
            // Mettre à jour duration/progress dès qu'on a CUED ou PLAYING
            if (state === window.YT.PlayerState.CUED || state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.PAUSED) {
              const d = p.getDuration?.() || 0;
              if (d && progressRef.current && !progressRef.current.matches(':active')) {
                progressRef.current.value = '0';
              }
              setYtState(s => ({ ...s, duration: d || s.duration }));
            }
            // Ignorer événements issus du priming silent (play->pause forcé)
            if (primeFrameRef.current) {
              if (state === window.YT.PlayerState.PAUSED || state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.CUED) {
                // Fin du priming, ne rien envoyer
                primeFrameRef.current = false;
              }
              return;
            }
            if (!wsRef.current || state === window.YT.PlayerState.BUFFERING) return;
            const t = p.getCurrentTime?.() || 0;
            const playing = state === window.YT.PlayerState.PLAYING;
            setYtState(s => ({ ...s, playing }));
            if (playing) {
              if (lastSentRef.current.action !== 'play' || Math.abs((lastSentRef.current.t || 0) - t) > 0.5) {
                safeSend({ type: 'yt', data: { action: 'play', time: t, origin: selfIdRef.current } });
                lastSentRef.current = { action: 'play', t };
              }
            } else if (state === window.YT.PlayerState.PAUSED) {
              if (lastSentRef.current.action !== 'pause' || Math.abs((lastSentRef.current.t || 0) - t) > 0.5) {
                safeSend({ type: 'yt', data: { action: 'pause', time: t, origin: selfIdRef.current } });
                lastSentRef.current = { action: 'pause', t };
              }
            }
          }
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ytSeek = (delta: number) => {
    const p = ytPlayerRef.current; if (!p) return;
    const nt = Math.max(0, p.getCurrentTime() + delta);
    p.seekTo(nt, true);
    safeSend({ type: "yt", data: { action: "seek", time: nt, origin: selfIdRef.current } });
  };
  const ytSetRate = (rate: number) => {
    const p = ytPlayerRef.current; if (!p) return;
    p.setPlaybackRate(rate);
    setYtState(s => ({ ...s, rate }));
    safeSend({ type: "yt", data: { action: "rate", rate, origin: selfIdRef.current } });
  };
  const ytLoad = (videoId: string) => {
    const p = ytPlayerRef.current; if (!p || !videoId) return;
    setCurrentVideoId(videoId);
    lastSentRef.current = {};
    p.loadVideoById(videoId, 0);
    primeFrameRef.current = true;
    setTimeout(() => {
      try { p.playVideo(); } catch {}
      setTimeout(() => {
        try { p.pauseVideo(); } catch {}
        try { p.seekTo(0, true); } catch {}
        const d = p.getDuration?.() || 0;
        setYtState(s => ({ ...s, current: 0, duration: d, playing: false }));
        if (progressRef.current) progressRef.current.value = '0';
      }, 350);
    }, 60);
    safeSend({ type: 'yt', data: { action: 'load', videoId, origin: selfIdRef.current } });
  };
  const ytTogglePlay = () => {
    const p = ytPlayerRef.current; if (!p) return;
    if (ytState.playing) p.pauseVideo(); else p.playVideo();
  };
  const fmt = (t: number) => {
    if (!isFinite(t)) return '0:00';
    const m = Math.floor(t/60); const s = Math.floor(t%60).toString().padStart(2,'0');
    return `${m}:${s}`;
  };

  const [cinemaMode, setCinemaMode] = useState(false);
  const videoProxyRef = useRef<HTMLVideoElement | null>(null);
  const [cinemaSession, setCinemaSession] = useState<{ id: string; playlist: string } | null>(null);
  const [cinemaAudioOn, setCinemaAudioOn] = useState(false);
  const [micMutedDuringCinema, setMicMutedDuringCinema] = useState(false);
  const [cinemaPaused, setCinemaPaused] = useState(false);
  const hlsRef = useRef<any>(null);
  // New refs for cinema sync
  const pendingCinemaCmdRef = useRef<{ action: 'play' | 'pause'; t: number } | null>(null);
  // New: user must click play (no autoplay)
  const [cinemaUserStarted, setCinemaUserStarted] = useState(false);
  const cinemaUserStartedRef = useRef(false);

  // Chargement paresseux hls.js si pas installé côté types
  let HlsLib: any = null;
  const startCinemaStream = async () => {
    if (cinemaSession) { await stopCinemaStream(); }
    const vid = prompt('ID YouTube à projeter (ex: dQw4w9WgXcQ)');
    if (!vid) return;
    try {
      const r = await fetch((process.env.NEXT_PUBLIC_BACKEND_HTTP || 'http://localhost:8001') + '/cinema/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: vid }) });
      if (!r.ok) { alert('Erreur création session'); return; }
      const j = await r.json();
      setCinemaSession({ id: j.sessionId, playlist: j.playlist });
      // Broadcast session start to peer
      safeSend({ type: 'cinema', data: { action: 'start', id: j.sessionId, playlist: j.playlist, origin: selfIdRef.current } });
      setCinemaUserStarted(false); cinemaUserStartedRef.current = false; // reset
      const full = (process.env.NEXT_PUBLIC_BACKEND_HTTP || 'http://localhost:8001') + j.playlist;
      setTimeout(async () => {
        if (!videoProxyRef.current) return;
        const el = videoProxyRef.current;
        el.muted = true; el.volume = 1;
        setCinemaAudioOn(false); setMicMutedDuringCinema(false);
        let firstPlayKick = true;
        const onFirstPlaying = () => { if (!firstPlayKick) return; firstPlayKick = false; setTimeout(()=>{ try { el.pause(); el.play().catch(()=>{}); } catch {} },120); el.removeEventListener('playing', onFirstPlaying); };
        el.addEventListener('playing', onFirstPlaying);
        // Préparation: rester PAUSED & MUTED jusqu'au clic Play utilisateur (policy ok car pas d'autoplay)
        let HlsLib: any = null;
        try { if (!HlsLib) { const mod = await import('hls.js'); HlsLib = mod.default || mod; } } catch {}
        const H = HlsLib;
        if (H && H.isSupported && H.isSupported()) {
          const hls = new H({
            enableWorker: true,
            lowLatencyMode: false,
            liveSyncDurationCount: 3,
            maxBufferLength: 60,
            maxBufferSize: 120 * 1000 * 1000,
            maxLiveSyncPlaybackRate: 1.0,
            fragLoadingTimeOut: 20000,
            manifestLoadingTimeOut: 20000,
            autoStartLoad: true
          });
          hlsRef.current = hls;
          hls.loadSource(full);
          hls.attachMedia(el);

          let lastAdvance = performance.now();
          let lastTime = 0;
          let stallTries = 0;
          let lastFragTs = performance.now();
          let hardRecoverTries = 0;
          let lastHardReload = 0;
          let firstManifest = true;

          const getBufferLen = () => {
            const v = videoProxyRef.current; if (!v) return 0;
            try {
              if (v.buffered && v.buffered.length) {
                for (let i = 0; i < v.buffered.length; i++) {
                  const start = v.buffered.start(i); const end = v.buffered.end(i);
                  if (v.currentTime >= start && v.currentTime <= end) return end - v.currentTime;
                }
                const end = v.buffered.end(v.buffered.length - 1);
                if (end < v.currentTime) return 0;
              }
            } catch {}
            return 0;
          };
          const nudgeForward = () => {
            const v = videoProxyRef.current; if (!v) return;
            try {
              if (v.buffered && v.buffered.length) {
                for (let i = 0; i < v.buffered.length; i++) {
                  const start = v.buffered.start(i); const end = v.buffered.end(i);
                  if (v.currentTime >= start - 0.05 && v.currentTime < end && end - v.currentTime > 0.4 && end - v.currentTime < 2.5) {
                    v.currentTime = Math.min(end - 0.3, v.currentTime + 0.25);
                    break;
                  }
                }
              }
            } catch {}
          };
          const forceRestartLoad = (pos?: number) => { try { hls.stopLoad(); } catch {}; setTimeout(() => { try { hls.startLoad(pos); } catch {}; }, 120); };
          const softRecover = () => { try { hls.recoverMediaError(); } catch {} };
          const hardReload = () => {
            const now = performance.now(); if (now - lastHardReload < 20000) return; lastHardReload = now;
            console.warn('[HLS] Hard reload source (cooldown)');
            const v = videoProxyRef.current; if (!v) return; const pos = v.currentTime;
            try { hls.destroy(); } catch {}
            const h2 = new H(hls.config); hlsRef.current = h2; h2.loadSource(full); h2.attachMedia(v);
            h2.on(H.Events.MANIFEST_PARSED, () => { try { if (!cinemaPaused && cinemaUserStartedRef.current) { v.currentTime = pos; v.play().catch(()=>{}); } } catch {} });
            stallTries = 0; hardRecoverTries = 0;
          };
          const watchdog = () => {
            const v = videoProxyRef.current; if (!v) return; const ct = v.currentTime; const bufferLen = getBufferLen();
            if (ct > lastTime + 0.05) { lastAdvance = performance.now(); lastTime = ct; stallTries = 0; hardRecoverTries = 0; }
            else {
              const since = performance.now() - lastAdvance;
              if (!v.paused && since > 2000) {
                if (bufferLen < 0.25) {
                  stallTries++;
                  if (stallTries === 1) { v.play().catch(()=>{}); }
                  else if (stallTries === 2) { forceRestartLoad(ct); }
                  else if (stallTries === 3) { nudgeForward(); }
                  else if (stallTries === 4) { softRecover(); }
                  else if (stallTries >= 5) {
                    const noNewFrags = (performance.now() - lastFragTs) > 8000; hardRecoverTries++;
                    if (noNewFrags && hardRecoverTries >= 2) { hardReload(); }
                    else { forceRestartLoad(ct); }
                    if (hardRecoverTries > 6) hardRecoverTries = 6; stallTries = 0;
                  }
                } else {
                  if (stallTries % 120 === 0) { v.play().catch(()=>{}); nudgeForward(); }
                }
              }
            }
            requestAnimationFrame(watchdog);
          }; requestAnimationFrame(watchdog);
          const interval = setInterval(() => { if (!videoProxyRef.current || videoProxyRef.current.paused) return; const bufferLen = getBufferLen(); if (performance.now() - lastFragTs > 7000 && bufferLen < 0.4) { forceRestartLoad(videoProxyRef.current.currentTime); } }, 4000);
          hls.on(H.Events.FRAG_LOADED, () => { lastFragTs = performance.now(); });
          hls.on(H.Events.MANIFEST_PARSED, () => {
            try {
              if (firstManifest) { el.currentTime = 0; firstManifest = false; }
              // Jouer seulement si l'utilisateur a cliqué Play (pas d'autoplay)
              if (cinemaUserStartedRef.current && !cinemaPaused) {
                const attemptPlay = () => { el.play().catch(err => { console.warn('[Cinéma] retry play', err?.name || err); setTimeout(() => { if (cinemaUserStartedRef.current) el.play().catch(()=>{}); }, 400); }); };
                attemptPlay();
              }
            } catch {}
          });
          hls.on(H.Events.ERROR, (_e: any, data: any) => {
            if (data?.response?.code === 404) {
              const isManifest = data.details?.includes('manifest') || data.details === 'levelLoadError';
              (hls as any)._notFoundCount = ((hls as any)._notFoundCount || 0) + 1; const nf = (hls as any)._notFoundCount;
              console.warn('[HLS] 404 détecté', data.details, 'count=', nf);
              if (isManifest) {
                if (nf <= 3) { setTimeout(() => { try { hls.loadSource(full); hls.startLoad(videoProxyRef.current?.currentTime); } catch {} }, 400 * nf); return; }
                else { console.warn('[HLS] Abandon session après 404 manifest répétés'); stopCinemaStream(); return; }
              } else { if (nf <= 5) { setTimeout(() => forceRestartLoad(videoProxyRef.current?.currentTime), 200); return; } }
            }
            if (data.details === 'fragParsingError') {
              (hls as any)._fragParseErrCount = ((hls as any)._fragParseErrCount || 0) + 1; const c = (hls as any)._fragParseErrCount;
              if (c === 2) forceRestartLoad(videoProxyRef.current?.currentTime);
              else if (c === 3) softRecover();
              else if (c >= 4 && c < 7) { nudgeForward(); forceRestartLoad(videoProxyRef.current?.currentTime); }
              else if (c >= 7) { hardReload(); (hls as any)._fragParseErrCount = 0; }
            }
            if (data.fatal) { if (data.type === 'mediaError') { try { hls.recoverMediaError(); } catch {} } else if (data.type === 'networkError') { forceRestartLoad(); } }
            console.warn('HLS error', data);
          });
          hls.on(H.Events.DESTROYING, () => { clearInterval(interval); });
        } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
          el.src = full; // Pas de play ici (attente clic)
        } else { el.src = full; }
      }, 1200);
    } catch (e) { console.warn(e); }
  };
  const stopCinemaStream = async () => {
    if (!cinemaSession) return;
    const old = cinemaSession;
    try { await fetch((process.env.NEXT_PUBLIC_BACKEND_HTTP || 'http://localhost:8001') + '/cinema/stop/' + cinemaSession.id, { method: 'POST' }); } catch {}
    safeSend({ type: 'cinema', data: { action: 'stop', id: old.id, origin: selfIdRef.current } });
    if (videoProxyRef.current) { videoProxyRef.current.pause(); videoProxyRef.current.muted = true; videoProxyRef.current.removeAttribute('src'); videoProxyRef.current.load(); }
    if (micMutedDuringCinema) { localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = true); }
    setCinemaAudioOn(false); setMicMutedDuringCinema(false); setCinemaPaused(false); setCinemaUserStarted(false); cinemaUserStartedRef.current = false; hlsRef.current = null; setCinemaSession(null);
  };
  const enableCinemaAudio = () => {
    const el = videoProxyRef.current; if (!el) return;
    el.muted = false;
    el.play().catch(()=>{});
    setCinemaAudioOn(true);
  };
  const toggleMicMuteCinema = () => {
    const mute = !micMutedDuringCinema;
    localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = !mute);
    setMicMutedDuringCinema(mute);
  };
  const pauseCinema = () => {
    if (!videoProxyRef.current) return;
    videoProxyRef.current.pause();
    try { hlsRef.current?.stopLoad?.(); } catch {}
    setCinemaPaused(true);
    // broadcast pause
    safeSend({ type: 'cinema', data: { action: 'pause', t: videoProxyRef.current.currentTime, origin: selfIdRef.current } });
  };
  const playCinema = () => {
    if (!videoProxyRef.current) return;
    try { hlsRef.current?.startLoad?.(); } catch {}
    videoProxyRef.current.play().catch(()=>{});
    setCinemaPaused(false);
    if (!cinemaUserStartedRef.current) { setCinemaUserStarted(true); cinemaUserStartedRef.current = true }
    // broadcast play
    safeSend({ type: 'cinema', data: { action: 'play', t: videoProxyRef.current.currentTime, origin: selfIdRef.current } });
  };

  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null);
  const [showYTDebug, setShowYTDebug] = useState(false);

  useEffect(() => {
    const p = ytPlayerRef.current;
    if (!p) return;
    if (cinemaMode || showYTDebug) {
      try { p.setSize(320, 270); } catch {}
    } else {
      try { p.setSize(1, 1); } catch {}
    }
  }, [cinemaMode, showYTDebug]);

  return (
    <main className="w-full h-screen overflow-hidden relative select-none">
      {/* Scène 3D cinéma en arrière-plan */}
      {cinemaMode && (
        <div className="absolute inset-0 z-0 bg-black">
          <CinemaScene
            mainVideoEl={cinemaSession ? videoProxyRef.current : remoteVideoRef.current}
            localVideoEl={localVideoRef.current}
            remoteVideoEl={remoteVideoRef.current}
            videoEl={(cinemaSession ? videoProxyRef.current : remoteVideoRef.current)}
            enabled
            showPlayOverlay={!!cinemaSession && !cinemaUserStarted}
            onPlayClick={() => {
              const el = videoProxyRef.current; if (!el) return;
              cinemaUserStartedRef.current = true; setCinemaUserStarted(true);
              el.muted = false;
              el.play().then(()=>{ setCinemaAudioOn(true); setCinemaPaused(false); safeSend({ type:'cinema', data:{ action:'play', t: el.currentTime, origin: selfIdRef.current } }); }).catch(()=>{ setTimeout(()=>{ el.play().catch(()=>{}); }, 250); });
            }}
            onPlayPauseHotkey={() => {
              const el = videoProxyRef.current; if (!el) return;
              if (el.paused) {
                playCinema();
              } else {
                pauseCinema();
              }
            }}
          />
        </div>
      )}
      {/* Overlay statut */}
      <div className="absolute top-2 left-2 text-xs text-neutral-400 font-mono pointer-events-none z-30">Salle {roomId} | {status}</div>
      {/* Boîte draggable vidéos locales/distantes (on masque la distante en mode cinéma) */}
      <div
        ref={containerRef}
        onPointerDown={startDrag}
        style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }}
        className={`fixed z-40 rounded-xl overflow-hidden shadow-lg cursor-grab active:cursor-grabbing transition-all duration-300 ${cinemaMode ? 'opacity-0 pointer-events-none scale-95' : ''}`}
        aria-hidden={cinemaMode}
      >
        <div className="w-full h-full flex bg-black">
          <video ref={localVideoRef} autoPlay playsInline muted className="w-1/2 h-full object-cover" />
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className={`w-1/2 h-full object-cover transition-opacity duration-300 ${cinemaMode ? 'opacity-0 pointer-events-none' : ''}`}
            onClick={() => {
              if (remoteVideoRef.current) {
                remoteVideoRef.current.play().catch(e => console.warn("Manual play failed:", e));
              }
            }}
          />
        </div>
        <div
          data-rs="true"
          onPointerDown={startResize}
          className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize"
          style={{ touchAction: 'none' }}
        />
      </div>
      {/* Lecteur YouTube + contrôles + toggle cinéma */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 bg-black/70 backdrop-blur rounded-md px-3 py-2 text-[11px] text-white flex flex-col gap-2 w-[680px] pointer-events-auto">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button onClick={() => setCinemaMode(m => !m)} className="px-2 py-1 rounded bg-purple-600 hover:bg-purple-500">{cinemaMode ? '2D' : 'Cinéma'}</button>
            {!cinemaSession && <button onClick={startCinemaStream} className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500">Projeter</button>}
            {cinemaSession && <button onClick={stopCinemaStream} className="px-2 py-1 rounded bg-red-600 hover:bg-red-500">Stop</button>}
            {cinemaSession && cinemaUserStarted && !cinemaPaused && <button onClick={pauseCinema} className="px-2 py-1 rounded bg-orange-600 hover:bg-orange-500">Pause</button>}
            {cinemaSession && cinemaUserStarted && cinemaPaused && <button onClick={playCinema} className="px-2 py-1 rounded bg-green-700 hover:bg-green-600">Lecture</button>}
            {cinemaSession && !cinemaAudioOn && <button onClick={enableCinemaAudio} className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500">Son</button>}
            {cinemaSession && cinemaAudioOn && <button onClick={toggleMicMuteCinema} className="px-2 py-1 rounded bg-slate-600 hover:bg-slate-500">{micMutedDuringCinema ? 'Mic On' : 'Mic Off'}</button>}
          </div>
          <div className="flex items-center gap-2 text-neutral-400 font-mono"><span>{fmt(ytState.current)}</span><span>/</span><span>{fmt(ytState.duration)}</span></div>
          <div className="flex items-center gap-2">
            <button onClick={() => ytSeek(-10)} className="px-2 py-1 bg-slate-700 rounded">-10s</button>
            <button onClick={() => ytSeek(10)} className="px-2 py-1 bg-slate-700 rounded">+10s</button>
            <button onClick={() => ytSetRate(Math.max(0.25, Math.min(ytState.rate - 0.25, 2))) } className="px-2 py-1 bg-slate-700 rounded">-0.25</button>
            <span className="w-10 text-center text-xs">{ytState.rate.toFixed(2)}x</span>
            <button onClick={() => ytSetRate(Math.max(0.25, Math.min(ytState.rate + 0.25, 2))) } className="px-2 py-1 bg-slate-700 rounded">+0.25</button>
            <button onClick={() => setShowYTDebug(d => !d)} className="px-2 py-1 bg-slate-800 rounded hover:bg-slate-700">{showYTDebug ? 'YT Hide' : 'YT Debug'}</button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={ytTogglePlay} className="px-2 py-1 rounded bg-green-600">{ytState.playing ? 'Pause' : 'Lecture'}</button>
          <input ref={progressRef} type="range" min={0} max={1000} defaultValue={0} className="flex-1" onChange={(e) => {
            const p = ytPlayerRef.current; if (!p) return;
            const d = p.getDuration?.() || ytState.duration || 0; if (!d) return;
            const ratio = parseFloat(e.target.value)/1000; const nt = d * ratio;
            if (!isFinite(nt)) return;
            p.seekTo(nt, true);
            safeSend({ type: 'yt', data: { action: 'seek', time: nt, origin: selfIdRef.current } });
          }} />
          <button onClick={() => ytLoad(prompt('ID YouTube:')?.trim() || '')} className="px-2 py-1 rounded bg-indigo-600">Load</button>
          {cinemaSession && cinemaAudioOn && (
            <div className="flex items-center gap-1 text-[10px]">
              <span>Vol</span>
              <input type="range" min={0} max={1} step={0.01} defaultValue={1} onChange={e => { if (videoProxyRef.current) videoProxyRef.current.volume = parseFloat(e.target.value); }} />
            </div>
          )}
        </div>
      </div>
      <video ref={videoProxyRef} playsInline /* pas d'autoplay ni muted attributs => contrôle manuel */ className="hidden" />
      <div ref={youtubeContainerRef} className={(cinemaMode || showYTDebug) ? "absolute bottom-24 right-4 w-80 h-48 bg-black/80 border border-purple-500 rounded overflow-hidden z-50" : "w-0 h-0 overflow-hidden"} />
    </main>
  );
}
