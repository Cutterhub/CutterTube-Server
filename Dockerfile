# 1. استخدام صورة Node 22 خفيفة ومستقرة
FROM node:22-bookworm-slim

WORKDIR /app

# 2. تثبيت الحزم الأساسية لنظام لينكس (ffmpeg + python3 لتشغيل yt-dlp + curl لجلب الملفات)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       curl \
       ca-certificates \
       python3 \
    && rm -rf /var/lib/apt/lists/*

# 3. تحميل وتثبيت أحدث إصدار من yt-dlp وإعطائه صلاحيات التنفيذ
# تحميل أحدث إصدار Nightly من yt-dlp لحل خطأ The page needs to be reloaded
RUN curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# 4. نسخ ملفات الحزم أولاً للاستفادة من Docker Cache في سرعة البناء
COPY package*.json ./

# 5. تثبيت حزم الإنتاج فقط (بدون حزم التطوير)
RUN npm ci --omit=dev

# 6. نسخ كود السيرفر
COPY server.js ./

# 7. إنشاء مجلد المقاطع المؤقتة
RUN mkdir -p /app/clips

# 8. ضبط مسارات البيئة الافتراضية
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV CLIPS_DIR=/app/clips
ENV PORT=4000

# 9. كشف المنفذ
EXPOSE 4000

# 10. أمر تشغيل السيرفر
CMD ["npm", "start"]