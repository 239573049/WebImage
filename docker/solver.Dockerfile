# Sentinel 求解服务镜像：Python 标准库 + Chromium（无第三方 Python 依赖）
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Chromium 及其运行库；中文字体用于让挑战环境更接近真实浏览器
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        curl \
        fonts-liberation \
        fonts-noto-cjk \
        libnss3 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libgbm1 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libasound2 \
        libpango-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY scripts/sentinel_solver.py /app/sentinel_solver.py

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8788/health || exit 1

ENTRYPOINT ["python", "/app/sentinel_solver.py", \
            "--host", "0.0.0.0", \
            "--port", "8788", \
            "--chrome", "/usr/bin/chromium", \
            "--profile-dir", "/tmp/solver-profile"]
