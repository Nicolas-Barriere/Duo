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
  onPlayPauseHotkey?: () => void; // new hotkey callback
  ambientEnabled?: boolean; // NEW
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
    <mesh position={[0, 2.2, -4]}> {/* raised center (was 1.5) so bottom now above floor */}
      <planeGeometry args={[6.4, 3.6]} />
      {texture ? <meshBasicMaterial map={texture} toneMapped={false} /> : <meshBasicMaterial color="#050505" />}
      {showPlayOverlay && (
        <Html center transform zIndexRange={[10, 20]}>
          <button
            onClick={(e) => { e.stopPropagation(); onPlayClick && onPlayClick(); }}
            className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 border border-white/30 backdrop-blur text-white text-xl flex items-center justify-center shadow-xl transition"
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
      {/* Floor unchanged */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#111" />
      </mesh>
      {/* Back wall behind raised screen */}
      <mesh position={[0, 2.2, -4.05]}> {/* was y=1.5 */}
        <planeGeometry args={[6.8, 3.9]} />
        <meshStandardMaterial color="#050505" />
      </mesh>
      {/* Ceiling raised */}
      <mesh position={[0, 5.8, -1]} rotation={[Math.PI / 2, 0, 0]}>
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

function CameraMover({ primaryVideo, onPlayPauseHotkey }: { primaryVideo?: HTMLVideoElement | null; onPlayPauseHotkey?: () => void }) {
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
        if (onPlayPauseHotkey) onPlayPauseHotkey(); else {
          const v = primaryVideo; if (v) { if (v.paused) v.play().catch(()=>{}); else v.pause(); }
        }
        return; // ne pas marquer comme mouvement
      }
      if (e.code === 'KeyC') {
        e.preventDefault();
        camera.position.set(0, 1.9, -0.8); // slightly higher to face raised screen
        yawRef.current = 0; pitchRef.current = 0;
        camera.rotation.set(0,0,0,'YXZ');
        camera.lookAt(0,2.2,-4); // new screen center
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

// Hook: sample average video color (downscaled) with smoothing
function useAmbientVideoLight(videoEl: HTMLVideoElement | null, enabled: boolean, fps: number = 10) {
  const [col, setCol] = useState<[number, number, number]>([0.35, 0.35, 0.38]);
  const lastRef = useRef(col);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const blockedRef = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = 48; // small sample size
      canvasRef.current.height = 27;
    }
    let raf: number; let lastTs = 0; const interval = 1000 / fps;
    const sample = (ts: number) => {
      raf = requestAnimationFrame(sample);
      if (ts - lastTs < interval) return; lastTs = ts;
      const v = videoEl;
      if (!v || v.readyState < 2 || blockedRef.current) return;
      const cvs = canvasRef.current!; const ctx = cvs.getContext('2d', { willReadFrequently: true }); if (!ctx) return;
      try {
        ctx.drawImage(v, 0, 0, cvs.width, cvs.height);
        const data = ctx.getImageData(0, 0, cvs.width, cvs.height).data;
        let rl=0, gl=0, bl=0, count=0;
        // stride 2 pixels -> skip every other pixel
        for (let i=0; i<data.length; i+=4*2) {
          const r = data[i]/255, g = data[i+1]/255, b = data[i+2]/255;
          // convert to linear
            const lin = (c:number)=> c<=0.04045? c/12.92: Math.pow((c+0.055)/1.055,2.4);
          rl += lin(r); gl += lin(g); bl += lin(b); count++;
        }
        if (!count) return;
        rl/=count; gl/=count; bl/=count;
        // back to sRGB
        const toSRGB = (c:number)=> c<=0.0031308? c*12.92: 1.055*Math.pow(c,1/2.4)-0.055;
        let r = toSRGB(rl), g = toSRGB(gl), b = toSRGB(bl);
        // normalize mild brightness (avoid too dark)
        const luma = 0.2126*r+0.7152*g+0.0722*b;
        const targetLuma = 0.22; // baseline
        if (luma < targetLuma && luma>0) {
          const gain = targetLuma / luma * 0.6 + 0.4; // compress
          r = Math.min(1, r*gain); g = Math.min(1, g*gain); b = Math.min(1, b*gain);
        }
        const last = lastRef.current; const alpha = 0.18;
        const nr: [number, number, number] = [
          last[0] + (r-last[0])*alpha,
          last[1] + (g-last[1])*alpha,
          last[2] + (b-last[2])*alpha,
        ];
        lastRef.current = nr;
        setCol(nr);
      } catch {
        // Likely CORS; disable further attempts
        blockedRef.current = true;
      }
    };
    raf = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(raf);
  }, [videoEl, enabled, fps]);
  return col;
}

export function CinemaScene({ videoEl, enabled = true, mainVideoEl, localVideoEl, remoteVideoEl, showPlayOverlay, onPlayClick, onPlayPauseHotkey, ambientEnabled = true }: CinemaProps) {
  if (!enabled) return null;
  const primary = mainVideoEl !== undefined ? mainVideoEl : videoEl; // fallback
  const avg = useAmbientVideoLight(primary || null, ambientEnabled, 9);
  const ambientRef = useRef<THREE.AmbientLight>(null!);
  const dirRef = useRef<THREE.DirectionalLight>(null!);
  const hemiRef = useRef<THREE.HemisphereLight>(null!); // NEW ceiling ambience
  // NEW vivid color derivation (boost saturation & controlled lightness)
  const vivid = useMemo(() => {
    const base = new THREE.Color(avg[0], avg[1], avg[2]);
    const hsl = { h: 0, s: 0, l: 0 } as THREE.HSL;
    base.getHSL(hsl);
    hsl.s = Math.min(1, hsl.s * 1.7 + 0.05);
    hsl.l = Math.min(0.62, hsl.l * 1.05 + 0.015);
    return new THREE.Color().setHSL(hsl.h, hsl.s, hsl.l);
  }, [avg[0], avg[1], avg[2]]);
  const bg = useMemo(() => vivid.clone().multiplyScalar(0.20), [vivid]);
  useEffect(() => {
    if (ambientRef.current) ambientRef.current.color.lerp(vivid, 0.5);
    if (dirRef.current) {
      const mix = vivid.clone().lerp(new THREE.Color('#ffffff'), 0.15);
      dirRef.current.color.lerp(mix, 0.35);
      dirRef.current.intensity = 1.15;
    }
    if (hemiRef.current) {
      // sky gets vivid, ground a dim desaturated version
      const ground = vivid.clone().lerp(new THREE.Color('#050505'), 0.85).multiplyScalar(0.35);
      hemiRef.current.color.lerp(vivid, 0.4);
      hemiRef.current.groundColor?.lerp(ground, 0.5);
    }
  }, [vivid]);
  return (
    <div className="absolute inset-0 pointer-events-auto select-none" style={{ zIndex: 5 }}>
      <Canvas shadows camera={{ position: [0, 1.8, 4.8], fov: 60 }}> {/* camera slightly higher */}
        <color attach="background" args={[bg]} />
        <fog attach="fog" args={[bg.getStyle(), 5, 22]} />
        <ambientLight ref={ambientRef} intensity={0.75} color={vivid} />
        <hemisphereLight ref={hemiRef} args={[vivid, vivid.clone().multiplyScalar(0.15), 0.9]} position={[0,5.8,-1]} />
        <directionalLight ref={dirRef} position={[4, 6.5, 4]} intensity={1.15} castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} />
        {/* Glow behind raised screen */}
        <mesh position={[0,2.2,-4.22]}> <planeGeometry args={[7.9,4.5]} /> <meshBasicMaterial color={vivid.clone().multiplyScalar(0.55)} /> </mesh>
        {/* Emissive ceiling panel raised with ceiling */}
        <mesh position={[0,5.77,-1]} rotation={[Math.PI/2,0,0]}> <planeGeometry args={[14,14]} /> <meshBasicMaterial color={vivid.clone().multiplyScalar(0.4)} transparent opacity={0.33} /> </mesh>
        <MainScreen videoEl={primary} showPlayOverlay={showPlayOverlay} onPlayClick={onPlayClick} />
        {/* Participant panels lifted proportionally */}
        <VideoPanel videoEl={localVideoEl || null} position={[-2.1, 4.3, -4]} rotation={[0, 0, 0]} label="Moi" />
        <VideoPanel videoEl={remoteVideoEl || null} position={[2.1, 4.3, -4]} rotation={[0, 0, 0]} label="Remote" />
        <Seats />
        <RoomDeco />
        <CameraRig />
        <CameraMover primaryVideo={primary} onPlayPauseHotkey={onPlayPauseHotkey} />
      </Canvas>
      <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[10px] text-neutral-300/90 bg-black/45 px-2 py-1 rounded pointer-events-none">
        Clique pour FPV • WASD / Flèches • P: Play/Pause • C: Center • Esc: Quit • Ambilight {ambientEnabled? 'ON':'OFF'}
      </div>
    </div>
  );
}
