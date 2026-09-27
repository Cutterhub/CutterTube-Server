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

# تثبيت yt-dlp مع إطار التوكنات ومزود bgutil معاً
RUN python3 -m pip install -U yt-dlp yt-dlp-get-pot bgutil-ytdlp-pot-provider --break-system-packages

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

RUN mkdir -p /app/clips

ENV YTDLP_PATH=yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV CLIPS_DIR=/app/clips
ENV PORT=4000

EXPOSE 4000

CMD ["npm", "start"]