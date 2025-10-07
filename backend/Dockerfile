# FastAPI Backend Dockerfile
FROM python:3.12-slim

WORKDIR /app

# Installer dépendances système (ffmpeg, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copier les fichiers requis
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copier tout le code backend
COPY . .

# Variables d'environnement
ENV PYTHONUNBUFFERED=1 \
    CINEMA_SESSIONS_ROOT=/tmp/cinema_sessions

EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
