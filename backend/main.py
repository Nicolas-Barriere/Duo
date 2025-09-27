from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, Set

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # remplace par ton domaine en prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class WSMessage(BaseModel):
    type: str  # "control" | "state" | "sdp" | "ice" | "join" | "leave" | "chat"
    data: dict

# Gestion simple en mémoire (MVP)
rooms: Dict[str, Set[WebSocket]] = {}

async def broadcast(room_id: str, msg: dict, sender: WebSocket | None = None):
    conns = rooms.get(room_id, set())
    dead = []
    for ws in conns:
        if ws is sender:
            continue
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for d in dead:
        conns.discard(d)

@app.websocket("/ws/{room_id}")
async def ws_room(ws: WebSocket, room_id: str):
    await ws.accept()
    if room_id not in rooms:
        rooms[room_id] = set()
    rooms[room_id].add(ws)
    try:
        await broadcast(room_id, {"type": "system", "data": {"event": "join"}}, sender=ws)
        while True:
            raw = await ws.receive_json()
            # Valider minimalement
            try:
                msg = WSMessage(**raw)
            except Exception:
                continue
            # Re-broadcast aux autres ET à l'expéditeur pour synchronisation complète
            await broadcast(room_id, raw, sender=None)  # sender=None pour inclure l'expéditeur
    except WebSocketDisconnect:
        pass
    finally:
        rooms[room_id].discard(ws)
        await broadcast(room_id, {"type": "system", "data": {"event": "leave"}}, sender=ws)
