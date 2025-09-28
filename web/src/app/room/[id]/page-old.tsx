"use client";
import { useState, useRef, useEffect } from "react";
import { useParams } from "next/navigation";

export default function Room() {
    const [status, setStatus] = useState("Initialisation...");
    const localVideoRef = useRef<HTMLVideoElement | null>(null);
    const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const [box, setBox] = useState({ x: 40, y: 40, w: 640, h: 360 });
    const { id: roomId } = useParams<{ id: string }>();
    const wsBase = process.env.NEXT_PUBLIC_BACKEND_WS || "ws://localhost:8001/ws";
    const wsURL = `${wsBase}/${roomId}`;

    const startDrag = (e: React.PointerEvent) => {
        // Logique pour déplacer la boîte
    };

    const startResize = (e: React.PointerEvent) => {
        // Logique pour redimensionner la boîte
    };

    useEffect(() => {
        startLocalStream();
        connectWebSocket();

        return () => {
            pcRef.current?.close();
            wsRef.current?.close();
            console.log("Resources cleaned up");
        };
    }, []);

    const createPeerConnection = () => {
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pcRef.current = pc;

        // transceivers pour stabiliser l'ordre des m-lines
        ["audio", "video"].forEach((kind) => {
            pc.addTransceiver(kind, { direction: "sendrecv" });
        });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                wsRef.current?.send(JSON.stringify({ type: "ice", data: event.candidate }));
                console.log("ICE candidate sent:", event.candidate);
            }
        };

        pc.ontrack = (event) => {
            console.log("Received remote track:", event.track.kind);
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = event.streams[0];
                remoteVideoRef.current.play().catch((e) => {
                    console.warn("Autoplay failed:", e);
                    const playVideo = () => {
                        remoteVideoRef.current?.play().catch(() => {});
                        document.removeEventListener("click", playVideo);
                    };
                    document.addEventListener("click", playVideo, { once: true });
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.log("Connection state:", pc.connectionState);
            if (pc.connectionState === "connected") {
                setStatus("Connexion établie ✅");
            }
        };

        return pc;
    };

    const startLocalStream = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            console.log("Local stream obtained:", stream);

            if (localVideoRef.current) {
                localVideoRef.current.srcObject = stream;
            }

            const pc = pcRef.current || createPeerConnection();
            stream.getTracks().forEach((track) => pc.addTrack(track, stream));
            setStatus("Flux local prêt");
        } catch (error) {
            console.error("Erreur accès caméra:", error);
            setStatus("Erreur accès caméra");
        }
    };

    const connectWebSocket = () => {
        const ws = new WebSocket(wsURL);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log("WebSocket connected");
            setStatus("WebSocket connecté");
        };

        ws.onmessage = async (event) => {
            const message = JSON.parse(event.data);
            console.log("Message reçu:", message);

            const pc = pcRef.current || createPeerConnection();

            if (message.type === "sdp") {
                console.log("SDP reçu:", message.data);

                if (message.data.type === "offer") {
                    console.log("Processing remote offer...");
                    await pc.setRemoteDescription(new RTCSessionDescription(message.data));
                    console.log("Remote offer set:", message.data);

                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    ws.send(JSON.stringify({ type: "sdp", data: answer }));
                    console.log("Answer sent:", answer);
                } else if (pc.signalingState === "stable" && message.data.type === "answer") {
                    console.log("Processing remote answer...");
                    await pc.setRemoteDescription(new RTCSessionDescription(message.data));
                    console.log("Remote answer set:", message.data);
                } else if (pc.signalingState === "have-local-offer" && message.data.type === "offer") {
                    console.warn("Received an offer while already having a local offer. Ignoring...");
                } else {
                    console.warn("Unexpected signaling state:", pc.signalingState);
                }
            } else if (message.type === "ice") {
                console.log("ICE reçu:", message.data);
                await pc.addIceCandidate(new RTCIceCandidate(message.data));
                console.log("ICE candidate added:", message.data);
            } else if (message.type === "peer_joined") {
                console.log("Peer joined, creating offer...");
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({ type: "sdp", data: offer }));
                console.log("Offer sent:", offer);
            } else if (message.type === "system" && message.data.event === "start_call") {
                console.log("Start call - creating offer...");
                const pc = pcRef.current || createPeerConnection();
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({ type: "sdp", data: offer }));
                console.log("Offer sent:", offer);
            }
        };

        ws.onclose = (event) => {
            console.log("WebSocket fermé", event);
            console.log("Code de fermeture:", event.code);
            console.log("Raison:", event.reason);
        };
    };

    return (
        <div
            style={{
                position: "absolute",
                background: "none",
                left: box.x,
                top: box.y,
                width: box.w,
                height: box.h,
            }}
            onPointerDown={startDrag}
        >
            <video ref={localVideoRef} autoPlay playsInline muted />
            <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
    );
}