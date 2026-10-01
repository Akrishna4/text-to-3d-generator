# ==============================================================================
# 1. Build frontend (Vite)
# ==============================================================================
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Install dependencies
COPY frontend/package*.json ./
RUN npm ci

# Copy source and build
COPY frontend/ ./
RUN npm run build

# ==============================================================================
# 2. Build backend and final image (FastAPI)
# ==============================================================================
FROM python:3.11-slim
WORKDIR /app



# Install Python dependencies
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ ./backend/

# Copy built frontend from stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Expose port 7860 (required by Hugging Face Spaces Docker SDK)
EXPOSE 7860

# Models directory defaults to /tmp/models which is writable by any user
ENV MODELS_DIR=/tmp/models

# Set working directory to backend so relative paths work as expected
WORKDIR /app/backend

# Start FastAPI
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers --forwarded-allow-ips '*'"]
