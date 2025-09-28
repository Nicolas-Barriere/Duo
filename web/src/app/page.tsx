"use client";
import { useState } from "react";
import { v4 as uuid } from "uuid";
import { useRouter } from "next/navigation";

export default function Home() {
  const [roomId, setRoomId] = useState("");
  const router = useRouter();

  return (
    <main className="max-w-xl mx-auto p-6 space-y-4">
      <h1 className="text-3xl font-bold">Duo 🎬</h1>
      <div className="space-y-2">
        <button
          onClick={() => router.push(`/room/${uuid()}`)}
          className="px-4 py-2 rounded-xl bg-white text-black"
        >
          Créer une salle
        </button>
      </div>
      <div className="space-y-2">
        <input
          value={roomId}
          onChange={e => setRoomId(e.target.value)}
          placeholder="ID de salle"
          className="w-full px-3 py-2 rounded-xl"
        />
        <button
          onClick={() => roomId && router.push(`/room/${roomId}`)}
          className="px-4 py-2 rounded-xl bg-neutral-200 text-black"
        >
          Rejoindre
        </button>
      </div>
    </main>
  );
}
