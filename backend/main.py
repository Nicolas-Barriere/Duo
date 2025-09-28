from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict

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
