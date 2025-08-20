# BooPug Upsell Rules - Production Image
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ENV=prod

WORKDIR /app

# System deps (optional): add build tools if needed for wheels
# RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

# Copy application code
COPY backend/ backend/
COPY static/ static/

# Ensure data directory exists but don't bake local DB into the image
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8000

# Runtime configuration
# Optional envs to set at run:
# - ADMIN_USERNAME, ADMIN_PASSWORD
# - ALLOWED_ORIGINS (comma-separated)
# - ENV=prod (already set)

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--log-level", "info"]
