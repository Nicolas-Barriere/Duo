"use client";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Environment, Html } from '@react-three/drei';

interface CinemaProps {
  videoEl: HTMLVideoElement | null; // backward compat (main video)
  enabled?: boolean;
  mainVideoEl?: HTMLVideoElement | null;
  localVideoEl?: HTMLVideoElement | null;
  remoteVideoEl?: HTMLVideoElement | null;
  showPlayOverlay?: boolean; // new
  onPlayClick?: () => void;   // new
}

// Reusable hook to build a video texture when ready
function useVideoTexture(videoEl: HTMLVideoElement | null) {
  const readyRef = useRef(false);
  useEffect(() => {
    readyRef.current = false;
    if (videoEl) {
      const handler = () => { readyRef.current = true; };
      videoEl.addEventListener('loadeddata', handler, { once: true });
      if (videoEl.readyState >= 2) readyRef.current = true;
      return () => { videoEl.removeEventListener('loadeddata', handler); };
    }
  }, [videoEl]);
  const texture = useMemo(() => {
    if (!videoEl) return null;
    if (!readyRef.current && videoEl.readyState < 2) return null;
    const tex = new THREE.VideoTexture(videoEl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }, [videoEl, readyRef.current]);
  useFrame(() => {
    if (texture && videoEl && videoEl.readyState >= 2 && videoEl.videoWidth) texture.needsUpdate = true;
  });
  return texture;
}

function MainScreen({ videoEl, showPlayOverlay, onPlayClick }: { videoEl: HTMLVideoElement | null; showPlayOverlay?: boolean; onPlayClick?: () => void }) {
  const texture = useVideoTexture(videoEl);
  return (
    <mesh position={[0, 1.5, -4]}>
      <planeGeometry args={[3.2, 1.8]} />
      {texture ? (
        <meshBasicMaterial map={texture} toneMapped={false} />
      ) : (
        <meshBasicMaterial color="#050505" />
      )}
      {showPlayOverlay && (
        <Html center transform zIndexRange={[10, 20]}>
          <button
            onClick={(e) => { e.stopPropagation(); onPlayClick && onPlayClick(); }}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 border border-white/30 backdrop-blur text-white text-base flex items-center justify-center shadow-xl transition"
            style={{ cursor: 'pointer' }}
          >▶</button>
        </Html>
      )}
    </mesh>
  );
}

function VideoPanel({ videoEl, position, rotation, label }: { videoEl: HTMLVideoElement | null; position: [number, number, number]; rotation: [number, number, number]; label: string }) {
  const texture = useVideoTexture(videoEl);
  return (
    <group position={position} rotation={rotation}>
      <mesh>
        <planeGeometry args={[1.3, 0.75]} />
        {texture ? (
          <meshBasicMaterial map={texture} toneMapped={false} />
        ) : (
          <meshBasicMaterial color="#111" />
        )}
      </mesh>
      <mesh position={[0, -0.5, 0]}>
        <planeGeometry args={[1.3, 0.18]} />
        <meshBasicMaterial color="#000" />
      </mesh>
      {/* Simple text sprite replacement (could add Text from drei if installed) */}
    </group>
  );
}

function Seats() {
  const seats: React.ReactNode[] = [];
  const rows = 3;
  const cols = 6;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c - (cols - 1) / 2) * 0.8;
      const z = r * 0.9;
      seats.push(
        <mesh key={`${r}-${c}`} position={[x, 0.45, z]} castShadow>
          <boxGeometry args={[0.6, 0.5, 0.6]} />
          <meshStandardMaterial color={r === 0 ? '#222' : '#333'} metalness={0.1} roughness={0.8} />
        </mesh>
      );
    }
  }
  return <group position={[0, 0, -1]}>{seats}</group>;
}

function RoomDeco() {
  return (
    <group>
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#111" />
      </mesh>
      {/* Back wall behind screen */}
      <mesh position={[0, 1.5, -4.05]}>
        <planeGeometry args={[3.4, 2]} />
        <meshStandardMaterial color="#050505" />
      </mesh>
      {/* Side walls */}
      <mesh position={[ -5, 2.5, -1]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[8, 5]} />
        <meshStandardMaterial color="#101010" />
      </mesh>
      <mesh position={[ 5, 2.5, -1]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[8, 5]} />
        <meshStandardMaterial color="#101010" />
      </mesh>
      {/* Ceiling */}
      <mesh position={[0, 5, -1]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#0d0d0d" />
      </mesh>
    </group>
  );
}

function CameraRig() {
  // Slight floating effect
  const ref = useRef<THREE.Group>(null!);
  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    ref.current.position.y = 0.1 * Math.sin(t / 2) + 1.2;
  });
  return <group ref={ref} />;
}

function CameraMover({ primaryVideo }: { primaryVideo?: HTMLVideoElement | null }) {
  const { camera, gl } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const speedRef = useRef(3.2); // m/s
  const [locked, setLocked] = useState(false);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const sensitivity = 0.002; // mouse sensitivity

  useEffect(() => {
    // init yaw/pitch from current camera
    yawRef.current = camera.rotation.y;
    pitchRef.current = camera.rotation.x;

    const down = (e: KeyboardEvent) => {
      // Shortcuts before movement state
      if (e.code === 'KeyP') {
        e.preventDefault();
        const v = primaryVideo; if (v) { if (v.paused) v.play().catch(()=>{}); else v.pause(); }
        return; // ne pas marquer comme mouvement
      }
      if (e.code === 'KeyC') {
        e.preventDefault();
        // Position recentrée encore plus proche de l'écran (écran à z=-4)
        camera.position.set(0, 1.6, -0.8); // avant: 0.7
        yawRef.current = 0; pitchRef.current = 0;
        camera.rotation.set(0,0,0,'YXZ');
        camera.lookAt(0,1.5,-4);
        return;
      }
      keys.current[e.code] = true;
      if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => { keys.current[e.code] = false; };
    const onMouseMove = (e: MouseEvent) => {
      if (!locked) return;
      // Orientation yaw standard (mouvement souris droite => regarder droite)
      yawRef.current -= e.movementX * sensitivity;
      pitchRef.current -= e.movementY * sensitivity;
      const maxPitch = Math.PI / 2 - 0.05;
      if (pitchRef.current > maxPitch) pitchRef.current = maxPitch;
      if (pitchRef.current < -maxPitch) pitchRef.current = -maxPitch;
      camera.rotation.set(pitchRef.current, yawRef.current, 0, 'YXZ');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('mousemove', onMouseMove);

    const onLock = () => setLocked(true);
    const onUnlock = () => setLocked(false);
    const request = () => {
      if (!locked) {
        gl.domElement.requestPointerLock();
      } else {
        // Toggle off FPV on click when already locked
        document.exitPointerLock?.();
      }
    };
    gl.domElement.addEventListener('click', request);
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === gl.domElement) onLock(); else onUnlock();
    });
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('mousemove', onMouseMove);
      gl.domElement.removeEventListener('click', request);
    };
  }, [gl, locked, camera]);

  useFrame((_, dt) => {
    if (!locked) return; // Only move when pointer locked
    const k = keys.current;
    const forwardAxis = (k['KeyW'] || k['ArrowUp']) ? 1 : (k['KeyS'] || k['ArrowDown']) ? -1 : 0;
    const strafeAxis = (k['KeyD'] || k['ArrowRight']) ? 1 : (k['KeyA'] || k['ArrowLeft']) ? -1 : 0;
    if (forwardAxis === 0 && strafeAxis === 0) return;

    // Direction réellement locale (orientation actuelle de la caméra)
    const forwardDir = new THREE.Vector3();
    camera.getWorldDirection(forwardDir); // pointe vers l'avant
    forwardDir.y = 0; if (forwardDir.lengthSq() > 0) forwardDir.normalize();
    const rightDir = new THREE.Vector3().crossVectors(forwardDir, new THREE.Vector3(0,1,0)).normalize();

    const move = new THREE.Vector3();
    if (forwardAxis) move.addScaledVector(forwardDir, forwardAxis);
    if (strafeAxis) move.addScaledVector(rightDir, strafeAxis);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speedRef.current * dt);
    camera.position.add(move);
  });
  return null;
}

export function CinemaScene({ videoEl, enabled = true, mainVideoEl, localVideoEl, remoteVideoEl, showPlayOverlay, onPlayClick }: CinemaProps) {
  if (!enabled) return null;
  const primary = mainVideoEl !== undefined ? mainVideoEl : videoEl; // fallback
  return (
    <div className="absolute inset-0 pointer-events-auto select-none" style={{ zIndex: 5 }}>
      <Canvas shadows camera={{ position: [0, 1.6, 3.5], fov: 55 }}>
        <color attach="background" args={["#000"]} />
        <fog attach="fog" args={["#000", 4, 18]} />
        <ambientLight intensity={0.35} />
        <directionalLight position={[4, 6, 4]} intensity={1} castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} />
        <MainScreen videoEl={primary} showPlayOverlay={showPlayOverlay} onPlayClick={onPlayClick} />
        {/* Participant video panels au-dessus de l'écran */}
        <VideoPanel videoEl={localVideoEl || null} position={[-1, 2.95, -4]} rotation={[0, 0, 0]} label="Moi" />
        <VideoPanel videoEl={remoteVideoEl || null} position={[1, 2.95, -4]} rotation={[0, 0, 0]} label="Remote" />
        <Seats />
        <RoomDeco />
        <Environment preset="city" />
        <CameraRig />
        <CameraMover primaryVideo={primary} />
      </Canvas>
      <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[10px] text-neutral-500 bg-black/30 px-2 py-1 rounded pointer-events-none">Clique pour entrer/sortir FPV • WASD / Flèches pour bouger • Souris pour regarder • P: Play/Pause • C: Center • Esc aussi pour sortir.</div>
    </div>
  );
}
