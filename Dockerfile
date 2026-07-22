# Small image: no torch, no OpenCV - extraction happens in hosted models.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

WORKDIR /srv

COPY pyproject.toml ./
COPY app ./app
COPY config ./config

RUN pip install --no-cache-dir .

EXPOSE 8000

# Container Apps injects PORT; single worker per replica, scale out with replicas.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
