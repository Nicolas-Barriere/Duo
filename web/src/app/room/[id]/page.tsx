"use client";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

// Messages échangés via WebSocket
type Msg =
  | { type: "system"; data: { event: "start_call" | "peer_left" } }
  | { type: "sdp"; data: RTCSessionDescriptionInit }
  | { type: "ice"; data: RTCIceCandidateInit };

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
      console.log("WS TX:", m.type, m.data);
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
      let msg: Msg; 
      try { msg = JSON.parse(ev.data); } catch { return; }
      console.log("WS RX:", msg.type, msg.data);
      
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
    };

    return () => { try { ws.close(); } catch {} };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsURL]);

  // ---- Cleanup PC ----
  useEffect(() => () => {
    try { pcRef.current?.close(); } catch {};
    pcRef.current = null;
  }, []);

  return (
    <main className="w-full h-screen overflow-hidden relative select-none">
      <div className="absolute top-2 left-2 text-xs text-neutral-400 font-mono pointer-events-none">
        Salle {roomId} | {status}
      </div>
      <div
        ref={containerRef}
        onPointerDown={startDrag}
        style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }}
        className="fixed z-20 rounded-xl overflow-hidden shadow-lg cursor-grab active:cursor-grabbing"
      >
        <div className="w-full h-full flex bg-black">
          <video ref={localVideoRef} autoPlay playsInline muted className="w-1/2 h-full object-cover" />
          <video 
            ref={remoteVideoRef} 
            autoPlay 
            playsInline 
            className="w-1/2 h-full object-cover"
            onClick={() => {
              // Clic manuel pour forcer la lecture si autoplay échoue
              if (remoteVideoRef.current) {
                console.log("Manual click - trying to play remote video");
                remoteVideoRef.current.play().catch(e => console.warn("Manual play failed:", e));
              }
            }}
          />
        </div>
        {/* Resize handle invisible but active */}
        <div
          data-rs="true"
          onPointerDown={startResize}
          className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize"
          style={{ touchAction: 'none' }}
        />
      </div>
    </main>
  );
}
