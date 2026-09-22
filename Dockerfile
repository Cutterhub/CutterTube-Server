FROM node:22-bookworm-slim

WORKDIR /app

# تثبيت الحزم الأساسية و Python مع pip
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       curl \
       ca-certificates \
       python3 \
       python3-pip \
    && rm -rf /var/lib/apt/lists/*

# تثبيت أحدث إصدار Nightly من yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# تثبيت إضافة توليد الـ PO Token لـ yt-dlp
RUN python3 -m pip install -U bgutil-ytdlp-pot-provider --break-system-packages

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

RUN mkdir -p /app/clips

ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV CLIPS_DIR=/app/clips
ENV PORT=4000

EXPOSE 4000

CMD ["npm", "start"]