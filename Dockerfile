# ==============================================================================
# VisionTrack — Production Dockerfile
# Provides Node.js 20 runtime, explicit FFmpeg installation, model assets,
# and compiled React frontend for deployment on Railway / Render.
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build Frontend Assets
# ------------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies for any native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

# Build Vite React client into /app/dist
RUN npm run build

# ------------------------------------------------------------------------------
# Stage 2: Production Runtime Environment
# ------------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Install FFmpeg (critical for RTSP / MP4 ingestion) and ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg is installed and accessible
RUN ffmpeg -version

ENV NODE_ENV=production
ENV PORT=3001

# Copy dependency specifications and install production-only dependencies
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy backend server code and configuration
COPY server/ ./server/
COPY models/ ./models/
COPY public/ ./public/

# Copy built frontend assets from builder stage
COPY --from=builder /app/dist ./dist

# Create persistent storage directories for SQLite and uploads
RUN mkdir -p /data /app/server/uploads/detections /app/server/uploads/media

# Default environment variables
ENV DB_PATH=/data/anpr.db

EXPOSE 3001

# Start VisionTrack central server
CMD ["node", "server/index.js"]
