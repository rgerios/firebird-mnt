FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=America/Sao_Paulo

WORKDIR /app

# Instala utilitários Linux para backup/transporte SSH, compressão, openssl, timezone e utilitários Firebird
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    openssl \
    rsync \
    zstd \
    gzip \
    curl \
    tzdata \
    ca-certificates \
    firebird3.0-utils \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /app/backend/data/logs /app/backend/data/ssh /app/backend/data/certs /app/backend/data/offline_lab

WORKDIR /app/backend
EXPOSE 8000 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -kfsS https://127.0.0.1:8443/api/health || curl -fsS http://127.0.0.1:8000/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
