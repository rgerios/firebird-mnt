import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Request, WebSocket, status

SESSION_COOKIE_NAME = "inframgnt_session"
SESSION_TTL_SECONDS = 12 * 3600  # 12 hours

# Persistent or environment secret key for signing session tokens
_SECRET_KEY = os.environ.get(
    "INFRAMGNT_SECRET_KEY",
    "venosan-inframgnt-proxmox-critical-secret-key-2026-x99a",
).encode("utf-8")

# Brute-force protection: IP -> list of failed timestamps
_FAILED_LOGINS: Dict[str, List[float]] = {}
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_WINDOW_SECONDS = 300  # 5 minutes


def hash_password(password: str, salt: Optional[str] = None) -> str:
    if not salt:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        200_000,
    )
    return f"pbkdf2_sha256${salt}${dk.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algo, salt, hex_digest = stored_hash.split("$", 2)
        if algo != "pbkdf2_sha256":
            return False
        candidate = hash_password(password, salt)
        return hmac.compare_digest(candidate, stored_hash)
    except Exception:
        return False


def create_session_token(user: Dict[str, Any]) -> str:
    payload = {
        "uid": user["id"],
        "sub": user["username"],
        "name": user.get("full_name") or user["username"],
        "role": user.get("role", "admin"),
        "exp": int(time.time()) + SESSION_TTL_SECONDS,
    }
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    b64_payload = base64.urlsafe_b64encode(payload_bytes).decode("ascii").rstrip("=")
    sig = hmac.new(_SECRET_KEY, b64_payload.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{b64_payload}.{sig}"


def verify_session_token(token: Optional[str]) -> Optional[Dict[str, Any]]:
    if not token or "." not in token:
        return None
    try:
        b64_payload, sig = token.rsplit(".", 1)
        expected_sig = hmac.new(
            _SECRET_KEY, b64_payload.encode("ascii"), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        padding = "=" * (-len(b64_payload) % 4)
        raw = base64.urlsafe_b64decode(b64_payload + padding).decode("utf-8")
        data = json.loads(raw)
        if int(data.get("exp", 0)) < int(time.time()):
            return None
        return data
    except Exception:
        return None


def check_rate_limit(client_ip: str) -> Optional[int]:
    """
    Returns remaining lockout seconds if IP exceeded max failed attempts, else None.
    """
    now = time.time()
    attempts = [t for t in _FAILED_LOGINS.get(client_ip, []) if now - t < LOCKOUT_WINDOW_SECONDS]
    _FAILED_LOGINS[client_ip] = attempts
    if len(attempts) >= MAX_FAILED_ATTEMPTS:
        oldest = attempts[0]
        return max(1, int(LOCKOUT_WINDOW_SECONDS - (now - oldest)))
    return None


def record_failed_login(client_ip: str) -> None:
    now = time.time()
    attempts = [t for t in _FAILED_LOGINS.get(client_ip, []) if now - t < LOCKOUT_WINDOW_SECONDS]
    attempts.append(now)
    _FAILED_LOGINS[client_ip] = attempts


def clear_failed_logins(client_ip: str) -> None:
    _FAILED_LOGINS.pop(client_ip, None)


def get_token_from_request(request: Request) -> Optional[str]:
    cookie_token = request.cookies.get(SESSION_COOKIE_NAME)
    if cookie_token:
        return cookie_token
    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return None


def get_current_user_or_none(request: Request) -> Optional[Dict[str, Any]]:
    token = get_token_from_request(request)
    return verify_session_token(token)


def require_auth(request: Request) -> Dict[str, Any]:
    user = get_current_user_or_none(request)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Não autenticado. Faça login para acessar o InfraMGNT.",
        )
    return user


def verify_websocket_auth(websocket: WebSocket) -> Optional[Dict[str, Any]]:
    token = websocket.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        token = websocket.query_params.get("token")
    return verify_session_token(token)

