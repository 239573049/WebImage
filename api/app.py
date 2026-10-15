from __future__ import annotations

import time
from contextlib import asynccontextmanager
from threading import Event

import anyio.to_thread
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from api import accounts, ai, image_tasks, proxy_pool, system
from api.errors import install_exception_handlers
from api.support import resolve_web_asset, start_limited_account_watcher
from services.account_service import account_service
from services.backup_service import backup_service
from services.config import config
from services.image_service import start_image_cleanup_scheduler
from services.metrics_service import ai_metrics
from services.proxy_pool_service import proxy_pool as proxy_pool_store
from services.proxy_subscription_service import proxy_subscriptions


def create_app() -> FastAPI:
    app_version = config.app_version

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        # AnyIO 默认仅 40 线程，生图等长任务会占满并阻塞所有 run_in_threadpool 调用
        anyio.to_thread.current_default_thread_limiter().total_tokens = config.api_threadpool_tokens
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        cleanup_thread = start_image_cleanup_scheduler(stop_event)
        # 代理池：已开启时补迁旧账号代理、补分配未绑定账号；健康探测常驻
        try:
            account_service.activate_proxy_pool()
        except Exception as exc:
            print(f"[proxy-pool] activate failed: {exc}", flush=True)
        pool_thread = proxy_pool_store.start_health_loop(stop_event)
        # 订阅定时刷新；启用内核时首轮把配置推给 mihomo
        subscription_thread = proxy_subscriptions.start_loop(stop_event)
        backup_service.start()
        config.cleanup_old_images()
        try:
            yield
        finally:
            stop_event.set()
            thread.join(timeout=1)
            cleanup_thread.join(timeout=1)
            pool_thread.join(timeout=1)
            subscription_thread.join(timeout=1)
            backup_service.stop()

    app = FastAPI(title="chatgpt2api", version=app_version, lifespan=lifespan)
    install_exception_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def track_ai_metrics(request: Request, call_next):
        if not request.url.path.startswith("/v1/"):
            return await call_next(request)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            _record_ai_request(request, False, started)
            raise
        _record_ai_request(request, response.status_code < 400, started)
        return response

    app.include_router(ai.create_router())
    app.include_router(accounts.create_router())
    app.include_router(image_tasks.create_router())
    app.include_router(proxy_pool.create_router())
    app.include_router(system.create_router(app_version))

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def serve_web(full_path: str):
        asset = resolve_web_asset(full_path)
        if asset is not None:
            return FileResponse(asset)
        if full_path.strip("/").startswith("_next/"):
            raise HTTPException(status_code=404, detail="Not Found")
        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback)

    return app


def _record_ai_request(request: Request, ok: bool, started: float) -> None:
    route = request.scope.get("route")
    # 用路由模板而非实际路径，避免路径参数把端点维度打散
    endpoint = getattr(route, "path", None) or request.url.path
    if "{full_path" in endpoint:
        return
    ai_metrics.record(endpoint, ok, (time.perf_counter() - started) * 1000)
