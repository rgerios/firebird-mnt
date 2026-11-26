import asyncio
from collections import deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, List
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self, max_history: int = 400):
        self.active_connections: List[WebSocket] = []
        self.history: Deque[Dict[str, Any]] = deque(maxlen=max_history)
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
            # Send recent log history to newly connected client
            for item in list(self.history):
                try:
                    await websocket.send_json(item)
                except Exception:
                    break

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)

    async def clear_history(self) -> None:
        async with self._lock:
            self.history.clear()
        await self.broadcast(
            {
                "type": "clear",
                "timestamp": datetime.now(timezone.utc).astimezone().strftime("%H:%M:%S"),
            },
            store=False,
        )

    async def broadcast(self, message: Dict[str, Any], store: bool = True) -> None:
        if "timestamp" not in message:
            message["timestamp"] = (
                datetime.now(timezone.utc).astimezone().strftime("%H:%M:%S")
            )
        async with self._lock:
            if store:
                self.history.append(message)
            stale: List[WebSocket] = []
            for connection in self.active_connections:
                try:
                    await connection.send_json(message)
                except Exception:
                    stale.append(connection)
            for s in stale:
                if s in self.active_connections:
                    self.active_connections.remove(s)

    async def emit_log(
        self,
        execution_id: int,
        line: str,
        level: str = "info",
        host_name: str = "InfraMGNT",
        step: str = "",
    ) -> None:
        await self.broadcast(
            {
                "type": "log",
                "execution_id": execution_id,
                "host": host_name,
                "step": step,
                "level": level,
                "line": line,
            }
        )

    async def emit_status(
        self,
        execution_id: int,
        status: str,
        job_title: str = "",
        summary: str = "",
        duration_seconds: float = 0.0,
    ) -> None:
        await self.broadcast(
            {
                "type": "status",
                "execution_id": execution_id,
                "status": status,
                "job_title": job_title,
                "summary": summary,
                "duration_seconds": duration_seconds,
            },
            store=True,
        )


ws_manager = ConnectionManager()

