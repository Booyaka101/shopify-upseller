from __future__ import annotations

import json
import os
import sqlite3
import time
import hashlib
import secrets
import hmac
import base64
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional, Mapping

from fastapi import FastAPI, HTTPException, Request, Body, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBasic, HTTPBasicCredentials
import httpx

APP_TITLE = "BooPug Upsell Rules"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "boopug.db"
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# ---- Config (env) ----
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
ENV = os.getenv("ENV", "dev").lower()

# Shopify app configuration (optional). If provided, app can run as an embedded Shopify app.
SHOPIFY_API_KEY = os.getenv("SHOPIFY_API_KEY")
SHOPIFY_API_SECRET = os.getenv("SHOPIFY_API_SECRET")
SHOPIFY_SCOPES = os.getenv("SHOPIFY_SCOPES", "read_products,write_script_tags")
APP_URL = os.getenv("APP_URL")  # e.g., https://yourapp.com

# ---- DB helpers ----

def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)


def get_conn() -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # Improve concurrency and safety
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA foreign_keys=ON")
    except Exception:
        pass
    return conn


def init_db() -> None:
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            placement TEXT NOT NULL,
            conditions_json TEXT NOT NULL,
            suggestions_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            limit_count INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS analytics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            placement TEXT,
            rule_id INTEGER,
            meta_json TEXT,
            FOREIGN KEY(rule_id) REFERENCES rules(id)
        )
        """
    )
    # Migrations: add new columns if missing
    # rules: priority, schedule_start, schedule_end, per_session_cap
    cur.execute("PRAGMA table_info(rules)")
    r_cols = {row[1] for row in cur.fetchall()}  # name at index 1
    if "priority" not in r_cols:
        cur.execute("ALTER TABLE rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 100")
    if "schedule_start" not in r_cols:
        cur.execute("ALTER TABLE rules ADD COLUMN schedule_start INTEGER")
    if "schedule_end" not in r_cols:
        cur.execute("ALTER TABLE rules ADD COLUMN schedule_end INTEGER")
    if "per_session_cap" not in r_cols:
        cur.execute("ALTER TABLE rules ADD COLUMN per_session_cap INTEGER NOT NULL DEFAULT 0")
    if "ab_test_pct" not in r_cols:
        cur.execute("ALTER TABLE rules ADD COLUMN ab_test_pct INTEGER NOT NULL DEFAULT 100")
    if "shop" not in r_cols:
        cur.execute("ALTER TABLE rules ADD COLUMN shop TEXT")

    # analytics: session_id
    cur.execute("PRAGMA table_info(analytics)")
    a_cols = {row[1] for row in cur.fetchall()}
    if "session_id" not in a_cols:
        cur.execute("ALTER TABLE analytics ADD COLUMN session_id TEXT")
    if "shop" not in a_cols:
        cur.execute("ALTER TABLE analytics ADD COLUMN shop TEXT")
    # Indexes for performance
    cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_status_priority ON rules(status, priority)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_analytics_rule_event ON analytics(rule_id, event_type)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics(session_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_analytics_ts ON analytics(ts)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_rules_shop_status ON rules(shop, status, priority)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_analytics_shop ON analytics(shop, rule_id, event_type)")
    # Shopify shops table
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS shops (
            shop TEXT PRIMARY KEY,
            access_token TEXT,
            installed_at INTEGER,
            updated_at INTEGER,
            plan_status TEXT,
            customer_id TEXT,
            subscription_id TEXT
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_shops_shop ON shops(shop)")
    conn.commit()
    conn.close()


# ---- Mock catalog for simulator ----
CATALOG: List[Dict[str, Any]] = [
    {
        "id": 1001,
        "title": "BooCam Pro Mirrorless Camera",
        "price": 899.0,
        "collections": ["cameras"],
        "tags": ["camera", "mirrorless", "boopug"],
        "image": "/static/img/camera.svg",
    },
    {
        "id": 1002,
        "title": "SD Card 64GB UHS-I",
        "price": 14.99,
        "collections": ["accessories"],
        "tags": ["sdcard", "memory", "camera"],
        "image": "/static/img/sdcard.svg",
    },
    {
        "id": 1003,
        "title": "Tripod Lite Carbon",
        "price": 79.0,
        "collections": ["accessories"],
        "tags": ["tripod", "camera"],
        "image": "/static/img/tripod.svg",
    },
    {
        "id": 1004,
        "title": "Cleaning Kit (Lens + Blower)",
        "price": 19.0,
        "collections": ["care"],
        "tags": ["cleaning", "camera", "starter"],
        "image": "/static/img/cleaning.svg",
    },
    {
        "id": 1005,
        "title": "Gift Wrap",
        "price": 4.0,
        "collections": ["extras"],
        "tags": ["giftable"],
        "image": "/static/img/gift.svg",
    },
]


def find_product(pid: int) -> Optional[Dict[str, Any]]:
    for p in CATALOG:
        if p["id"] == pid:
            return p
    return None


# ---- App ----
app = FastAPI(title=APP_TITLE)

# Compression
app.add_middleware(GZipMiddleware, minimum_size=500)

# CORS (restrict in production)
if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Basic security headers + static caching
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    resp = await call_next(request)
    # Security headers
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    # For embedded Shopify admin (/admin, /shopify/*), omit X-Frame-Options and rely on CSP frame-ancestors.
    path = request.url.path
    if path.startswith("/admin") or path.startswith("/shopify/"):
        if "X-Frame-Options" in resp.headers:
            del resp.headers["X-Frame-Options"]
    else:
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=()")
    # CSP to our needs (allow inline due to current templates)
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "img-src 'self' data:; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self' https://cdn.shopify.com https://fonts.shopifycdn.com data:; "
        "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.shopify.com; "
        "connect-src 'self' https://*.myshopify.com https://admin.shopify.com; "
        "frame-ancestors 'self' https://admin.shopify.com https://*.myshopify.com"
    )
    # Cache static assets aggressively
    if path.startswith("/static/") and not path.endswith(".html"):
        resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    return resp


@app.on_event("startup")
async def startup_event() -> None:
    init_db()


# Mount static
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def root() -> RedirectResponse:
    return RedirectResponse(url="/admin")


security = HTTPBasic()

def require_admin_or_shop_session(request: Request, credentials: HTTPBasicCredentials = Depends(security)) -> None:
    # If Shopify app credentials exist and a valid shop cookie/session is present, allow.
    shop_cookie = request.cookies.get("shop")
    if SHOPIFY_API_KEY and SHOPIFY_API_SECRET and shop_cookie and shop_installed(shop_cookie):
        return
    # Otherwise fall back to Basic Auth
    if not (ADMIN_USERNAME and ADMIN_PASSWORD):
        if ENV == "prod":
            raise HTTPException(status_code=503, detail="Admin auth not configured")
        return
    if not (credentials.username == ADMIN_USERNAME and credentials.password == ADMIN_PASSWORD):
        raise HTTPException(status_code=401, detail="Unauthorized", headers={"WWW-Authenticate": "Basic"})

def shop_installed(shop: str) -> bool:
    if not shop:
        return False
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT shop FROM shops WHERE shop=? AND access_token IS NOT NULL", (shop,))
    row = cur.fetchone()
    conn.close()
    return bool(row)


def get_shop_token(shop: str) -> Optional[str]:
    if not shop:
        return None
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT access_token FROM shops WHERE shop=?", (shop,))
    row = cur.fetchone()
    conn.close()
    return row[0] if row and row[0] else None


def current_shop_from_request(request: Request) -> Optional[str]:
    """Best-effort shop resolver from cookie or query param."""
    return request.cookies.get("shop") or request.query_params.get("shop")


async def shopify_graphql(shop: str, token: str, query: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = f"https://{shop}/admin/api/2023-07/graphql.json"
    headers = {"X-Shopify-Access-Token": token}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(url, json={"query": query, "variables": variables or {}}, headers=headers)
        r.raise_for_status()
        return r.json()


async def register_app_uninstalled_webhook(shop: str, token: str) -> None:
    try:
        url = f"https://{shop}/admin/api/2023-07/webhooks.json"
        headers = {"X-Shopify-Access-Token": token}
        payload = {
            "webhook": {
                "topic": "app/uninstalled",
                "address": f"{APP_URL}/shopify/webhooks/app_uninstalled",
                "format": "json",
            }
        }
        async with httpx.AsyncClient(timeout=20) as client:
            await client.post(url, json=payload, headers=headers)
    except Exception:
        # Non-fatal
        pass


async def ensure_storefront_script_tag(shop: str, token: str) -> None:
    try:
        src_base = f"{APP_URL}/storefront/boopug.js"
        src_full = f"{src_base}?shop={shop}"
        base = f"https://{shop}/admin/api/2023-07/script_tags.json"
        headers = {"X-Shopify-Access-Token": token}
        async with httpx.AsyncClient(timeout=20) as client:
            # List existing
            r = await client.get(base, headers=headers)
            if r.status_code == 200:
                data = r.json() or {}
                tags = data.get("script_tags", [])
                for t in tags:
                    esrc = str(t.get("src") or "")
                    if esrc.split("?")[0] == src_base:
                        # If same base but different or missing query, update to include shop param
                        if esrc != src_full and t.get("id"):
                            try:
                                upd_url = f"https://{shop}/admin/api/2023-07/script_tags/{t['id']}.json"
                                await client.put(upd_url, json={"script_tag": {"src": src_full}}, headers=headers)
                            except Exception:
                                pass
                        return  # already present (updated if needed)
            # Create new
            await client.post(base, json={"script_tag": {"event": "onload", "src": src_full}}, headers=headers)
    except Exception:
        pass


@app.get("/shopify/config", dependencies=[Depends(require_admin_or_shop_session)])
async def shopify_config(request: Request) -> Dict[str, Any]:
    shop = current_shop_from_request(request)
    return {"apiKey": SHOPIFY_API_KEY, "shop": shop}


@app.get("/admin", dependencies=[Depends(require_admin_or_shop_session)])
async def admin_ui() -> FileResponse:
    """Serve the new SPA if present; otherwise fall back to legacy admin."""
    spa_index = STATIC_DIR / "admin-spa" / "index.html"
    if spa_index.exists():
        return FileResponse(str(spa_index))
    # Fallback to legacy
    legacy = STATIC_DIR / "admin.html"
    if not legacy.exists():
        raise HTTPException(500, "Admin UI not found. Did files generate?")
    return FileResponse(str(legacy))

@app.get("/admin-legacy", dependencies=[Depends(require_admin_or_shop_session)])
async def admin_legacy() -> FileResponse:
    path = STATIC_DIR / "admin.html"
    if not path.exists():
        raise HTTPException(500, "Legacy Admin UI not found. Did files generate?")
    return FileResponse(str(path))


# ---- Shopify OAuth ----
def valid_shop_domain(shop: Optional[str]) -> bool:
    if not shop:
        return False
    return shop.endswith(".myshopify.com") and "." in shop and len(shop) < 255


def verify_shopify_hmac(params: Mapping[str, str], secret: str) -> bool:
    params = {k: v for k, v in params.items() if k not in ("hmac", "signature")}
    sorted_items = sorted(params.items(), key=lambda kv: kv[0])
    # Join using k=v pairs with raw values
    message = "&".join([f"{k}={v}" for k, v in sorted_items])
    digest = hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()
    provided = (params.get("hmac") or "").lower()  # not present here after filtering; read separately in handlers
    # Provided hmac must be fetched before filtering; handlers will pass it in explicitly if needed.
    return False  # placeholder; handlers implement constant-time compare


@app.get("/shopify/auth")
async def shopify_auth(request: Request) -> RedirectResponse:
    if not (SHOPIFY_API_KEY and SHOPIFY_API_SECRET and APP_URL):
        raise HTTPException(500, "Shopify app not configured. Set SHOPIFY_API_KEY, SHOPIFY_API_SECRET, APP_URL.")
    shop = request.query_params.get("shop")
    if not valid_shop_domain(shop):
        raise HTTPException(400, "Missing or invalid 'shop' parameter")
    state = secrets.token_urlsafe(16)
    # Set state cookie
    resp = RedirectResponse(url="/")
    resp.set_cookie(
        key="oauth_state",
        value=state,
        httponly=True,
        secure=(ENV == "prod"),
        samesite=("none" if ENV == "prod" else "lax"),
        max_age=600,
    )
    # Build Shopify OAuth URL
    redirect_uri = f"{APP_URL}/shopify/callback"
    scope = SHOPIFY_SCOPES
    query = {
        "client_id": SHOPIFY_API_KEY,
        "scope": scope,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    auth_url = f"https://{shop}/admin/oauth/authorize?{urllib.parse.urlencode(query)}"
    resp.headers["Location"] = auth_url
    resp.status_code = 302
    return resp


@app.get("/shopify/callback")
async def shopify_callback(request: Request) -> RedirectResponse:
    if not (SHOPIFY_API_KEY and SHOPIFY_API_SECRET and APP_URL):
        raise HTTPException(500, "Shopify app not configured.")
    qp = dict(request.query_params)
    shop = qp.get("shop")
    hmac_provided = qp.get("hmac", "").lower()
    state = qp.get("state")
    code = qp.get("code")
    if not (valid_shop_domain(shop) and hmac_provided and state and code):
        raise HTTPException(400, "Invalid callback parameters")
    # Verify state
    state_cookie = request.cookies.get("oauth_state")
    if not (state_cookie and secrets.compare_digest(state_cookie, state)):
        raise HTTPException(400, "Invalid OAuth state")
    # Verify HMAC
    params_for_hmac = {k: v for k, v in qp.items() if k not in ("hmac", "signature")}
    message = "&".join([f"{k}={v}" for k, v in sorted(params_for_hmac.items(), key=lambda kv: kv[0])])
    calc = hmac.new(SHOPIFY_API_SECRET.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()
    if not secrets.compare_digest(calc, hmac_provided):
        raise HTTPException(400, "HMAC validation failed")
    # Exchange code for access token
    token_url = f"https://{shop}/admin/oauth/access_token"
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(token_url, json={
            "client_id": SHOPIFY_API_KEY,
            "client_secret": SHOPIFY_API_SECRET,
            "code": code,
        })
        r.raise_for_status()
        data = r.json()
    access_token = data.get("access_token")
    if not access_token:
        raise HTTPException(400, "Failed to obtain access token")
    # Store/Upsert shop
    now = int(time.time())
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT shop FROM shops WHERE shop=?", (shop,))
    exists = cur.fetchone() is not None
    if exists:
        cur.execute("UPDATE shops SET access_token=?, updated_at=? WHERE shop=?", (access_token, now, shop))
    else:
        cur.execute("INSERT INTO shops (shop, access_token, installed_at, updated_at) VALUES (?,?,?,?)", (shop, access_token, now, now))
    conn.commit()
    conn.close()
    # Post-install tasks: register webhook and ensure storefront script tag
    try:
        await register_app_uninstalled_webhook(shop, access_token)
        await ensure_storefront_script_tag(shop, access_token)
    except Exception:
        # Non-fatal; proceed with redirect
        pass
    # Set shop cookie and redirect to admin
    resp = RedirectResponse(url=f"/admin?shop={urllib.parse.quote(shop)}")
    resp.set_cookie(
        key="shop",
        value=shop,
        httponly=True,
        secure=(ENV == "prod"),
        samesite=("none" if ENV == "prod" else "lax"),
        max_age=7*24*3600,
    )
    # Clear state cookie
    resp.delete_cookie("oauth_state")
    return resp


@app.post("/shopify/webhooks/app_uninstalled")
async def webhook_app_uninstalled(request: Request) -> Response:
    """Handle app/uninstalled webhook: verify HMAC and clear shop token."""
    # If not configured as a Shopify app, acknowledge to avoid retries
    if not SHOPIFY_API_SECRET:
        return Response(status_code=200)
    raw_body = await request.body()
    provided_sig = request.headers.get("X-Shopify-Hmac-Sha256", "")
    try:
        digest = hmac.new(SHOPIFY_API_SECRET.encode("utf-8"), raw_body, hashlib.sha256).digest()
        expected_sig = base64.b64encode(digest).decode()
    except Exception:
        expected_sig = ""
    if not (provided_sig and secrets.compare_digest(provided_sig, expected_sig)):
        # Unauthorized to ensure Shopify doesn't retry with bad secret
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    shop = request.headers.get("X-Shopify-Shop-Domain", "")
    now = int(time.time())
    conn = get_conn()
    cur = conn.cursor()
    if shop:
        # Clear access token but retain record
        cur.execute("UPDATE shops SET access_token=NULL, updated_at=? WHERE shop=?", (now, shop))
    conn.commit()
    conn.close()
    return Response(status_code=200)


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> RedirectResponse:
    # Redirect to a bundled SVG to avoid 404 noise in console
    return RedirectResponse(url="/static/img/boopug.svg")


@app.get("/simulator")
async def simulator_ui() -> FileResponse:
    path = STATIC_DIR / "storefront.html"
    if not path.exists():
        raise HTTPException(500, "Simulator UI not found. Did files generate?")
    return FileResponse(str(path))


@app.get("/storefront/boopug.js")
async def storefront_script() -> Response:
    """Serve a lightweight storefront script that evaluates rules and logs impressions.

    The script detects placement via URL path, requests suggestions, and posts impression analytics.
    It derives the base URL from the script tag src to avoid relying on APP_URL.
    """
    js = (
        "(function(){\n"
        "  try {\n"
        "    var s = document.currentScript || (function(){var scripts=document.getElementsByTagName('script');return scripts[scripts.length-1];})();\n"
        "    var src = s && s.src || '';\n"
        "    var u = (function(){ try { return new URL(src, (location && location.origin) || undefined); } catch(e){ return null; }})();\n"
        "    var base = src.split('/storefront/')[0] || ((u && u.origin) || (location.origin || ''));\n"
        "    var shop = (u && u.searchParams && u.searchParams.get('shop')) || '';\n"
        "    var key = 'boopug_sid';\n"
        "    var sid = localStorage.getItem(key);\n"
        "    if(!sid){ sid = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(key, sid); }\n"
        "    var path = (location && location.pathname) || '';\n"
        "    var placement = path.indexOf('/cart') !== -1 ? 'cart' : 'product_page';\n"
        "    var payload = { session_id: sid, shop: shop, context: { placement: placement } };\n"
        "    fetch(base + '/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), credentials: 'omit' })\n"
        "      .then(function(r){ return r.json(); })\n"
        "      .then(function(data){\n"
        "        var tr = (data && data.triggered_rules) || [];\n"
        "        var cr = (data && data.control_rules) || [];\n"
        "        for (var i=0;i<tr.length;i++){\n"
        "          try {\n"
        "            fetch(base + '/api/analytics/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'impression', placement: placement, rule_id: tr[i], session_id: sid, shop: shop }), credentials: 'omit' });\n"
        "          } catch(e){}\n"
        "        }\n"
        "        for (var j=0;j<cr.length;j++){\n"
        "          try {\n"
        "            fetch(base + '/api/analytics/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'impression_control', placement: placement, rule_id: cr[j], session_id: sid, shop: shop }), credentials: 'omit' });\n"
        "          } catch(e){}\n"
        "        }\n"
        "        if (data && data.suggestions && data.suggestions.length){ console.debug('[BooPug]', 'suggestions', data.suggestions); }\n"
        "      })\n"
        "      .catch(function(){});\n"
        "  } catch(e){}\n"
        "})();\n"
    )
    return Response(content=js, media_type="application/javascript", headers={"Cache-Control": "public, max-age=300"})


@app.get("/api/health")
async def health() -> Dict[str, Any]:
    return {"ok": True, "app": APP_TITLE}


@app.get("/api/catalog")
async def catalog() -> Dict[str, Any]:
    return {"items": CATALOG}


# ---- Rules CRUD ----
@app.get("/api/rules", dependencies=[Depends(require_admin_or_shop_session)])
async def list_rules(request: Request) -> Dict[str, Any]:
    shop = current_shop_from_request(request)
    conn = get_conn()
    cur = conn.cursor()
    if shop:
        cur.execute("SELECT * FROM rules WHERE shop=? ORDER BY id DESC", (shop,))
    else:
        cur.execute("SELECT * FROM rules WHERE shop IS NULL ORDER BY id DESC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    for r in rows:
        r["conditions"] = json.loads(r.pop("conditions_json"))
        r["suggestions"] = json.loads(r.pop("suggestions_json"))
    return {"rules": rows}


@app.post("/api/rules", dependencies=[Depends(require_admin_or_shop_session)])
async def create_rule(request: Request, payload: Dict[str, Any]) -> Dict[str, Any]:
    required = ["name", "placement", "conditions", "suggestions"]
    for k in required:
        if k not in payload:
            raise HTTPException(400, f"Missing field: {k}")
    status = payload.get("status", "active")
    limit_count = int(payload.get("limit", payload.get("limit_count", 1)))
    priority = int(payload.get("priority", 100))
    # schedule can be provided as fields or nested object
    sched = payload.get("schedule", {}) or {}
    schedule_start = payload.get("schedule_start", sched.get("start"))
    schedule_end = payload.get("schedule_end", sched.get("end"))
    schedule_start = int(schedule_start) if schedule_start is not None else None
    schedule_end = int(schedule_end) if schedule_end is not None else None
    per_session_cap = int(payload.get("per_session_cap", payload.get("session_cap", 0)))
    ab_test_pct = int(payload.get("ab_test_pct", 100))
    now = int(time.time())
    shop = current_shop_from_request(request)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO rules (name, placement, conditions_json, suggestions_json, status, limit_count, priority, schedule_start, schedule_end, per_session_cap, ab_test_pct, created_at, updated_at, shop)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload["name"],
            payload["placement"],
            json.dumps(payload["conditions"]),
            json.dumps(payload["suggestions"]),
            status,
            limit_count,
            priority,
            schedule_start,
            schedule_end,
            per_session_cap,
            ab_test_pct,
            now,
            now,
            shop,
        ),
    )
    conn.commit()
    rid = cur.lastrowid
    conn.close()
    return {"id": rid}

@app.put("/api/rules/{rule_id}", dependencies=[Depends(require_admin_or_shop_session)])
async def update_rule(request: Request, rule_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    shop = current_shop_from_request(request)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM rules WHERE id=?", (rule_id,))
    prev = cur.fetchone()
    if not prev:
        conn.close()
        raise HTTPException(404, "Rule not found")

    prevd = dict(prev)
    if shop and prevd.get("shop") and prevd.get("shop") != shop:
        conn.close()
        raise HTTPException(403, "Cannot modify rule from a different shop")
    name = payload.get("name", prevd.get("name"))
    placement = payload.get("placement", prevd.get("placement"))
    conditions_json = json.dumps(payload.get("conditions", json.loads(prevd.get("conditions_json", "{}"))))
    suggestions_json = json.dumps(payload.get("suggestions", json.loads(prevd.get("suggestions_json", "[]"))))
    status = payload.get("status", prevd.get("status"))
    limit_count = int(payload.get("limit", payload.get("limit_count", prevd.get("limit_count", 1))))
    priority = int(payload.get("priority", prevd.get("priority", 100)))
    sched = payload.get("schedule", {}) or {}
    schedule_start = payload.get("schedule_start", sched.get("start", prevd.get("schedule_start")))
    schedule_end = payload.get("schedule_end", sched.get("end", prevd.get("schedule_end")))
    schedule_start = int(schedule_start) if schedule_start is not None else None
    schedule_end = int(schedule_end) if schedule_end is not None else None
    per_session_cap = int(payload.get("per_session_cap", payload.get("session_cap", prevd.get("per_session_cap", 0))))
    ab_test_pct = int(payload.get("ab_test_pct", prevd.get("ab_test_pct", 100)))

    if shop:
        cur.execute(
            """
            UPDATE rules SET name=?, placement=?, conditions_json=?, suggestions_json=?, status=?, limit_count=?, priority=?, schedule_start=?, schedule_end=?, per_session_cap=?, ab_test_pct=?, updated_at=?
            WHERE id=? AND shop=?
            """,
            (
                name,
                placement,
                conditions_json,
                suggestions_json,
                status,
                limit_count,
                priority,
                schedule_start,
                schedule_end,
                per_session_cap,
                ab_test_pct,
                int(time.time()),
                rule_id,
                shop,
            ),
        )
    else:
        cur.execute(
            """
            UPDATE rules SET name=?, placement=?, conditions_json=?, suggestions_json=?, status=?, limit_count=?, priority=?, schedule_start=?, schedule_end=?, per_session_cap=?, ab_test_pct=?, updated_at=?
            WHERE id=? AND shop IS NULL
            """,
            (
                name,
                placement,
                conditions_json,
                suggestions_json,
                status,
                limit_count,
                priority,
                schedule_start,
                schedule_end,
                per_session_cap,
                ab_test_pct,
                int(time.time()),
                rule_id,
            ),
        )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.post("/api/rules/import", dependencies=[Depends(require_admin_or_shop_session)])
async def import_rules(request: Request, payload: Any = Body(...), replace: bool = Query(False)) -> Dict[str, Any]:
    # Normalize incoming structure
    rules_in: List[Dict[str, Any]]
    if isinstance(payload, list):
        rules_in = payload  # type: ignore
    elif isinstance(payload, dict) and "rules" in payload:
        rules_in = payload.get("rules", [])  # type: ignore
    else:
        raise HTTPException(400, "Invalid import format. Provide a list of rules or {'rules': [...]}.")

    now = int(time.time())
    shop = current_shop_from_request(request)
    conn = get_conn()
    cur = conn.cursor()
    if replace:
        if shop:
            cur.execute("DELETE FROM rules WHERE shop=?", (shop,))
        else:
            cur.execute("DELETE FROM rules WHERE shop IS NULL")

    inserted = 0
    for r in rules_in:
        # Basic validation and normalization
        name = r.get("name")
        placement = r.get("placement")
        conditions = r.get("conditions")
        suggestions = r.get("suggestions")
        if not (name and placement is not None and conditions is not None and suggestions is not None):
            continue  # skip invalid entries
        status = r.get("status", "active")
        limit_count = int(r.get("limit", r.get("limit_count", 1)))
        # new fields
        priority = int(r.get("priority", 100))
        sched = r.get("schedule", {}) or {}
        schedule_start = r.get("schedule_start", sched.get("start"))
        schedule_end = r.get("schedule_end", sched.get("end"))
        schedule_start = int(schedule_start) if schedule_start is not None else None
        schedule_end = int(schedule_end) if schedule_end is not None else None
        per_session_cap = int(r.get("per_session_cap", r.get("session_cap", 0)))
        ab_test_pct = int(r.get("ab_test_pct", 100))
        created_at = int(r.get("created_at", now))
        updated_at = int(r.get("updated_at", now))

        cur.execute(
            """
            INSERT INTO rules (name, placement, conditions_json, suggestions_json, status, limit_count, priority, schedule_start, schedule_end, per_session_cap, ab_test_pct, created_at, updated_at, shop)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name,
                placement,
                json.dumps(conditions),
                json.dumps(suggestions),
                status,
                limit_count,
                priority,
                schedule_start,
                schedule_end,
                per_session_cap,
                ab_test_pct,
                created_at,
                updated_at,
                shop,
            ),
        )
        inserted += 1

    conn.commit()
    conn.close()
    return {"inserted": inserted}

@app.get("/api/analytics/by-rule", dependencies=[Depends(require_admin_or_shop_session)])
async def analytics_by_rule(request: Request) -> Dict[str, Any]:
    """Return per-rule analytics counts and basic rates and revenue.

    Response shape:
      { rules: { [rule_id]: { impression: int, accept: int, rate: float, revenue: float, discount: float } } }
    """
    shop = current_shop_from_request(request)
    conn = get_conn()
    cur = conn.cursor()
    # counts (including control impressions)
    if shop:
        cur.execute(
            "SELECT rule_id, event_type, COUNT(*) as c FROM analytics WHERE rule_id IS NOT NULL AND shop=? GROUP BY rule_id, event_type",
            (shop,),
        )
    else:
        cur.execute(
            "SELECT rule_id, event_type, COUNT(*) as c FROM analytics WHERE rule_id IS NOT NULL AND shop IS NULL GROUP BY rule_id, event_type"
        )
    rows = cur.fetchall()
    # accept meta for revenue
    if shop:
        cur.execute(
            "SELECT rule_id, meta_json FROM analytics WHERE event_type='accept' AND rule_id IS NOT NULL AND shop=?",
            (shop,),
        )
    else:
        cur.execute(
            "SELECT rule_id, meta_json FROM analytics WHERE event_type='accept' AND rule_id IS NOT NULL AND shop IS NULL"
        )
    acc_rows = cur.fetchall()
    conn.close()
    agg: Dict[str, Dict[str, int]] = {}
    for r in rows:
        rid = str(r["rule_id"]) if r["rule_id"] is not None else "0"
        et = r["event_type"]
        c = int(r["c"])  # type: ignore
        agg.setdefault(rid, {})[et] = c
    revenue: Dict[str, float] = {}
    discount_totals: Dict[str, float] = {}
    for r in acc_rows:
        rid = str(r["rule_id"]) if r["rule_id"] is not None else "0"
        try:
            meta = json.loads(r["meta_json"]) if r["meta_json"] else {}
        except Exception:
            meta = {}
        # Prefer discounted_price if provided, else compute
        base_price = float(meta.get("base_price", 0))
        disc_pct = float(meta.get("discount_pct", 0))
        discounted_price = float(meta.get("discounted_price", base_price * (1 - disc_pct / 100)))
        revenue[rid] = revenue.get(rid, 0.0) + float(discounted_price)
        discount_totals[rid] = discount_totals.get(rid, 0.0) + float(max(base_price - discounted_price, 0))
    out: Dict[str, Any] = {}
    for rid, counts in agg.items():
        impr = int(counts.get("impression", 0))
        ctrl = int(counts.get("impression_control", 0))
        acc = int(counts.get("accept", 0))
        rate = (acc / impr) if impr > 0 else 0.0
        out[rid] = {
            "impression": impr,
            "control_impression": ctrl,
            "accept": acc,
            "rate": rate,
            "revenue": round(revenue.get(rid, 0.0), 2),
            "discount": round(discount_totals.get(rid, 0.0), 2),
            "lift": round(rate - 0.0, 4),
        }
    return {"rules": out}

@app.get("/api/analytics/summary", dependencies=[Depends(require_admin_or_shop_session)])
async def analytics_summary(request: Request) -> Dict[str, Any]:
    shop = current_shop_from_request(request)
    conn = get_conn()
    cur = conn.cursor()
    if shop:
        cur.execute("SELECT event_type, COUNT(*) as c FROM analytics WHERE shop=? GROUP BY event_type", (shop,))
    else:
        cur.execute("SELECT event_type, COUNT(*) as c FROM analytics WHERE shop IS NULL GROUP BY event_type")
    rows = cur.fetchall()
    conn.close()
    out: Dict[str, int] = {}
    for r in rows:
        out[str(r["event_type"])] = int(r["c"])  # type: ignore
    return {"summary": out}

@app.post("/api/analytics/event")
async def analytics_event(request: Request, payload: Dict[str, Any]) -> Dict[str, Any]:
    et = payload.get("event_type")
    if not et:
        raise HTTPException(400, "Missing event_type")
    ts = int(time.time())
    placement = payload.get("placement")
    rule_id = payload.get("rule_id")
    session_id = payload.get("session_id")
    meta = payload.get("meta")
    shop = payload.get("shop") or current_shop_from_request(request)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO analytics (ts, event_type, placement, rule_id, meta_json, session_id, shop) VALUES (?,?,?,?,?,?,?)",
        (ts, str(et), placement, rule_id, json.dumps(meta) if meta is not None else None, session_id, shop),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.get("/api/rules/export", dependencies=[Depends(require_admin_or_shop_session)])
async def export_rules(request: Request) -> Dict[str, Any]:
    shop = current_shop_from_request(request)
    conn = get_conn()
    cur = conn.cursor()
    if shop:
        cur.execute("SELECT * FROM rules WHERE shop=? ORDER BY id ASC", (shop,))
    else:
        cur.execute("SELECT * FROM rules WHERE shop IS NULL ORDER BY id ASC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    out: List[Dict[str, Any]] = []
    for r in rows:
        r["conditions"] = json.loads(r.pop("conditions_json"))
        r["suggestions"] = json.loads(r.pop("suggestions_json"))
        out.append(r)
    return {"rules": out}

@app.delete("/api/rules/{rule_id}", dependencies=[Depends(require_admin_or_shop_session)])
async def delete_rule(request: Request, rule_id: int) -> Dict[str, Any]:
    shop = current_shop_from_request(request)
    conn = get_conn()
    cur = conn.cursor()
    if shop:
        cur.execute("DELETE FROM rules WHERE id=? AND shop=?", (rule_id, shop))
    else:
        cur.execute("DELETE FROM rules WHERE id=? AND shop IS NULL", (rule_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

def rule_matches(rule: Dict[str, Any], context: Dict[str, Any]) -> bool:
    placement = context.get("placement")
    if placement != rule.get("placement"):
        return False
    cond = rule.get("conditions") or {}
    product = context.get("product") or {}
    cart = context.get("cart") or {}
    # product_tags_any
    if "product_tags_any" in cond:
        tags_have = {str(t).lower() for t in (product.get("tags") or [])}
        tags_need = {str(t).lower() for t in (cond.get("product_tags_any") or [])}
        if not (tags_have & tags_need):
            return False
    # product_collections_any
    if "product_collections_any" in cond:
        cols_have = {str(c).lower() for c in (product.get("collections") or [])}
        cols_need = {str(c).lower() for c in (cond.get("product_collections_any") or [])}
        if not (cols_have & cols_need):
            return False
    # cart_subtotal_between
    if "cart_subtotal_between" in cond:
        rng = cond.get("cart_subtotal_between") or {}
        subtotal = float(cart.get("subtotal") or 0)
        mn = float(rng.get("min")) if rng.get("min") is not None else float("-inf")
        mx = float(rng.get("max")) if rng.get("max") is not None else float("inf")
        if not (mn <= subtotal <= mx):
            return False
    return True

@app.post("/api/evaluate")
async def evaluate(request: Request, payload: Dict[str, Any]) -> Dict[str, Any]:
    context = payload.get("context", {})
    session_id = payload.get("session_id")
    debug = bool(payload.get("debug", False))
    shop = payload.get("shop") or current_shop_from_request(request)
    conn = get_conn()
    cur = conn.cursor()
    if shop:
        cur.execute("SELECT * FROM rules WHERE status='active' AND shop=? ORDER BY priority ASC, id ASC", (shop,))
    else:
        cur.execute("SELECT * FROM rules WHERE status='active' AND shop IS NULL ORDER BY priority ASC, id ASC")
    db_rules = [dict(r) for r in cur.fetchall()]
    conn.close()

    rules: List[Dict[str, Any]] = []
    for r in db_rules:
        r["conditions"] = json.loads(r.pop("conditions_json"))
        r["suggestions"] = json.loads(r.pop("suggestions_json"))
        rules.append(r)

    suggestions: List[Dict[str, Any]] = []
    triggered_rules: List[int] = []
    control_rules: List[int] = []
    debug_traces: List[Dict[str, Any]] = []

    now_ts = int(time.time())
    for r in rules:
        trace: Dict[str, Any] = {"rule_id": int(r["id"]), "name": r.get("name"), "placement": r.get("placement")}
        # Placement check
        placement_ok = (context.get("placement") == r.get("placement"))
        trace["placement_ok"] = placement_ok
        if not placement_ok:
            if debug:
                debug_traces.append(trace)
            continue
        # Schedule window
        rs = r.get("schedule_start")
        re = r.get("schedule_end")
        sched_ok = True
        if rs is not None and now_ts < int(rs):
            sched_ok = False
        if re is not None and now_ts > int(re):
            sched_ok = False
        trace["schedule_ok"] = sched_ok
        trace["schedule_start"] = rs
        trace["schedule_end"] = re
        if not sched_ok:
            if debug:
                debug_traces.append(trace)
            continue

        # Per-session cap based on impressions
        cap = int(r.get("per_session_cap", 0))
        trace["cap"] = cap
        if cap > 0 and session_id:
            conn2 = get_conn()
            cur2 = conn2.cursor()
            if shop:
                cur2.execute(
                    "SELECT COUNT(*) AS c FROM analytics WHERE event_type='impression' AND rule_id=? AND session_id=? AND shop=?",
                    (int(r["id"]), str(session_id), shop),
                )
            else:
                cur2.execute(
                    "SELECT COUNT(*) AS c FROM analytics WHERE event_type='impression' AND rule_id=? AND session_id=? AND shop IS NULL",
                    (int(r["id"]), str(session_id)),
                )
            row = cur2.fetchone()
            conn2.close()
            seen = int(row[0]) if row else 0
            trace["session_impressions"] = seen
            if seen >= cap:
                trace["cap_ok"] = False
                if debug:
                    debug_traces.append(trace)
                continue
        trace["cap_ok"] = True

        # Conditions detail (for debug)
        cond = r.get("conditions") or {}
        product = context.get("product") or {}
        cart = context.get("cart") or {}
        tags_have = {str(t).lower() for t in (product.get("tags") or [])}
        cols_have = {str(c).lower() for c in (product.get("collections") or [])}
        tags_need = set(str(t).lower() for t in (cond.get("product_tags_any") or [])) if ("product_tags_any" in cond) else None
        cols_need = set(str(c).lower() for c in (cond.get("product_collections_any") or [])) if ("product_collections_any" in cond) else None
        subtotal = float((cart or {}).get("subtotal") or 0)
        rng = cond.get("cart_subtotal_between") or {}
        mn = float(rng.get("min")) if ("min" in rng and rng.get("min") is not None) else float("-inf")
        mx = float(rng.get("max")) if ("max" in rng and rng.get("max") is not None) else float("inf")
        cond_detail = {
            "product_tags_any": None if tags_need is None else (len(tags_have & tags_need) > 0),
            "product_collections_any": None if cols_need is None else (len(cols_have & cols_need) > 0),
            "cart_subtotal_between": ("cart_subtotal_between" in cond and (mn <= subtotal <= mx)) if ("cart_subtotal_between" in cond) else None,
            "subtotal": subtotal,
            "min": mn if ("cart_subtotal_between" in cond) else None,
            "max": mx if ("cart_subtotal_between" in cond) else None,
        }
        trace["conditions"] = cond_detail

        if rule_matches(r, context):
            # A/B split: if in control, do not show suggestions but record control assignment
            ab_pct = int(r.get("ab_test_pct", 100))
            trace["ab_test_pct"] = ab_pct
            ab_hash = None
            if session_id:
                seed = f"{session_id}:{r['id']}".encode("utf-8")
                ab_hash = int(hashlib.md5(seed).hexdigest(), 16) % 100
            trace["ab_bucket"] = ab_hash
            if 0 <= ab_pct < 100 and session_id:
                if ab_hash is not None and ab_hash >= ab_pct:
                    control_rules.append(int(r["id"]))
                    trace["matched"] = True
                    trace["control_assigned"] = True
                    if debug:
                        debug_traces.append(trace)
                    break
            triggered_rules.append(int(r["id"]))
            for sug in r["suggestions"]:
                prod = find_product(int(sug["product_id"]))
                if not prod:
                    continue
                s = {
                    "rule_id": int(r["id"]),
                    "placement": r.get("placement"),
                    "product": prod,
                    "discount_pct": float(sug.get("discount_pct", 0)),
                }
                suggestions.append(s)
            # enforce limit
            limit_n = int(r.get("limit_count", 1))
            if limit_n > 0:
                suggestions = suggestions[:limit_n]
            trace["matched"] = True
            trace["control_assigned"] = False
            trace["chosen"] = True
            if debug:
                debug_traces.append(trace)
            break  # only take first matching rule per placement for simplicity
        else:
            trace["matched"] = False
            if debug:
                debug_traces.append(trace)
    out = {"suggestions": suggestions, "triggered_rules": triggered_rules, "control_rules": control_rules}
    if debug:
        out["debug"] = {"rules": debug_traces}
    return out
