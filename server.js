require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// =============================================================
// 1. تحديد المنفذ والرابط العام (بالترتيب الصحيح)
// =============================================================
const PORT = process.env.PORT || 4000;
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 
                       process.env.PUBLIC_BACKEND_URL || 
                       (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);

// =============================================================
// 2. إعدادات CORS الديناميكية (من متغيرات البيئة)
// =============================================================
const allowedOrigins = (
    process.env.CORS_ORIGINS ||
    'https://www.cuttertube.com,https://cuttertube.com,http://localhost:5173,http://localhost:3000'
)
.split(',')
.map(origin => origin.trim())
.filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        // السماح بالطلبات بدون Origin (مثل Postman/سيرفر داخلي) أو النطاقات المعتمدة أو إضافات Chrome
        if (!origin || allowedOrigins.includes(origin) || origin.startsWith('chrome-extension://')) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// معالجة كافة طلبات الـ Preflight
app.options('*', cors());

// =============================================================
// 3. التحقق من متغيرات Supabase
// =============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error("❌ CRITICAL ERROR: Supabase URL or Service Key is missing in .env file.");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        persistSession: false
    },
    realtime: {
        createSocket: () => null
    }
});

// =============================================================
// 4. مسار مجلد المقاطع (متوافق مع Railway Volume والتطوير المحلي)
// =============================================================
const CLIPS_DIR = process.env.CLIPS_DIR || path.join(__dirname, 'clips');

if (!fs.existsSync(CLIPS_DIR)) {
    fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

// =============================================================
// 5. مسارات الأدوات (Linux / Railway)
// =============================================================
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const jobs = {};

// --- START: تعريف صلاحيات الخطط (مصدر الحقيقة الوحيد) ---
const PLAN_PERMISSIONS = {
    free: {
        plan_name: 'Free',
        max_duration: 60,
        watermark: true,
        allowed_features: ['144p_quality', '240p_quality', '360p_quality', '480p_quality', 'mp4_format', 'mp3_format']
    },
    basic: {
        plan_name: 'Basic',
        max_duration: 90,
        watermark: false,
        allowed_features: ['144p_quality', '240p_quality', '360p_quality', '480p_quality', '720p_quality', '1080p_quality', 'mp4_format', 'mp3_format', 'webm_format', 'gif_format']
    },
    advanced: {
        plan_name: 'Advanced',
        max_duration: 120,
        watermark: false,
        allowed_features: ['144p_quality', '240p_quality', '360p_quality', '480p_quality', '720p_quality', '1080p_quality', '1440p_quality', '2160p_quality', 'mp4_format', 'mp3_format', 'webm_format', 'gif_format', 'wav_format', 'mkv_format']
    },
    pro: {
        plan_name: 'Pro',
        max_duration: 180,
        watermark: false,
        allowed_features: ['144p_quality', '240p_quality', '360p_quality', '480p_quality', '720p_quality', '1080p_quality', '1440p_quality', '2160p_quality', 'mp4_format', 'mp3_format', 'webm_format', 'gif_format', 'wav_format', 'mkv_format', 'mov_format', 'avi_format']
    }
};
// --- END: تعريف صلاحيات الخطط ---

function isAudioFormat(format) {
    return ['mp3', 'wav'].includes(format);
}

function calculateCreditCost(durationInSeconds, quality, format) {
    const DURATION_BLOCK_SIZE = 30;
    const BASE_DURATION_COST = Math.ceil(durationInSeconds / DURATION_BLOCK_SIZE);

    const QUALITY_MULTIPLIERS = {
        '144p': 0.8, '240p': 0.8, '360p': 0.9, '480p': 0.9,
        '720p': 1, '1080p': 1.5, '1440p': 2, '2160p': 3, 'default': 1
    };
    const FORMAT_MULTIPLIERS = { 'gif': 2.5, 'mp3': 0.7, 'wav': 0.7 };

    let multiplier = FORMAT_MULTIPLIERS[format] || QUALITY_MULTIPLIERS[quality] || QUALITY_MULTIPLIERS['default'];
    const calculatedCost = BASE_DURATION_COST * multiplier;
    return Math.max(1, Math.ceil(calculatedCost));
}

// مسار فحص صحة السيرفر
app.get('/', (req, res) => {
    res.json({ 
        status: 'online', 
        service: 'CutterTube Clip Server', 
        public_url: PUBLIC_API_URL,
        ytdlp: YTDLP_PATH, 
        ffmpeg: FFMPEG_PATH 
    });
});

// مسار فحص الصحة لـ Railway Health Check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'cuttertube-server',
        timestamp: new Date().toISOString()
    });
});

app.get('/download/:tempFilename/:finalFilename', (req, res) => {
    try {
        const { tempFilename, finalFilename } = req.params;
        const decodedFinalFilename = decodeURIComponent(finalFilename);
        const filePath = path.join(CLIPS_DIR, tempFilename);

        if (fs.existsSync(filePath)) {
            res.download(filePath, decodedFinalFilename, (err) => {
                if (err) console.error("[Download] Error sending file:", err);
                fs.unlink(filePath, (unlinkErr) => {
                    if (unlinkErr) console.error("[Download] Error deleting temp file:", unlinkErr);
                    else console.log(`[Download] Temp file ${tempFilename} deleted.`);
                });
            });
        } else {
            res.status(404).send('File not found or has already been downloaded.');
        }
    } catch (error) {
        console.error("[Download Error]", error);
        res.status(500).send("An internal server error occurred.");
    }
});

function sanitizeFilename(name) {
    if (!name) return 'clip';
    return name.replace(/[\\/:\*\?"<>\|]/g, '_').replace(/^\.+|\.+$/g, '').trim().replace(/\s+/g, ' ');
}

// =============================================================
//               Endpoint to get Video Metadata (Subs & Audio)
// =============================================================
app.get('/video-metadata', async (req, res) => {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ message: 'Video ID is required.' });

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // استخدام yt-dlp مع وسائط تخطي الحظر السحابي
    const ytdlpArgs = [
        '--user-agent', USER_AGENT,
        '--no-warnings',
        '--no-check-certificates',
        '--extractor-args', 'youtube:player_client=android,web',
        '--dump-json',
        videoUrl
    ];

    const ytdlp = spawn(YTDLP_PATH, ytdlpArgs);
    let output = '';
    let errorOutput = '';

    ytdlp.stdout.on('data', (data) => output += data.toString());
    ytdlp.stderr.on('data', (data) => errorOutput += data.toString());

    ytdlp.on('close', (code) => {
        if (code !== 0) {
            console.error(`[Metadata] yt-dlp failed (code ${code}): ${errorOutput}`);
            return res.status(500).json({ 
                message: 'Failed to fetch video metadata.',
                details: errorOutput || 'Unknown yt-dlp error'
            });
        }

        try {
            const info = JSON.parse(output);

            const audioTracks = [];
            const languageMap = {};

            if (info.formats) {
                console.log(`[Metadata] Analyzing ${info.formats.length} formats for video: ${videoId}`);
                info.formats.forEach(f => {
                    const hasAudio = f.acodec && f.acodec !== 'none';
                    const hasNoVideo = !f.vcodec || f.vcodec === 'none';

                    if (hasAudio && hasNoVideo) {
                        const lang = f.language || f.lang || f.language_code || null;
                        if (lang) {
                            const name = f.language_preference || f.language_note || f.format_note || lang;
                            const key = `${lang}_${name}`;
                            if (!languageMap[key] || (f.tbr || 0) > (languageMap[key].tbr || 0)) {
                                languageMap[key] = {
                                    id: f.format_id,
                                    language: lang,
                                    language_name: name,
                                    tbr: f.tbr || 0
                                };
                            }
                        }
                    }
                });
            }

            if (info.audio_tracks && Array.isArray(info.audio_tracks)) {
                console.log(`[Metadata] Found ${info.audio_tracks.length} audio_tracks in info.`);
                info.audio_tracks.forEach(track => {
                    const lang = track.id || track.language || 'unknown';
                    const name = track.name || track.language_preference || lang;
                    const key = `${lang}_${name}`;
                    if (!languageMap[key]) {
                        languageMap[key] = {
                            id: track.id || track.format_id,
                            language: lang,
                            language_name: name,
                            tbr: 0
                        };
                    }
                });
            }

            console.log(`[Metadata] Unique audio languages identified: ${Object.keys(languageMap).length}`);

            for (const key in languageMap) {
                audioTracks.push(languageMap[key]);
            }

            const subtitles = [];
            if (info.subtitles) {
                for (const lang in info.subtitles) {
                    subtitles.push({
                        id: lang,
                        name: info.subtitles[lang][0]?.name || lang,
                        is_auto: false
                    });
                }
            }
            if (info.automatic_captions) {
                for (const lang in info.automatic_captions) {
                    subtitles.push({
                        id: lang,
                        name: (info.automatic_captions[lang][0]?.name || lang) + ' (auto)',
                        is_auto: true
                    });
                }
            }

            res.json({
                audioTracks,
                subtitles
            });

        } catch (e) {
            console.error(`[Metadata] Failed to parse JSON: ${e}`);
            res.status(500).json({ message: 'Failed to parse video metadata.', details: e.message });
        }
    });
});

app.get('/user-status', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Unauthorized' });
        }
        const token = authHeader.split(' ')[1];

        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
            return res.status(403).json({ message: 'Forbidden: Invalid token' });
        }

        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('plan, credits')
            .eq('id', user.id)
            .single();

        if (profileError || !profile) {
            return res.status(500).json({ message: 'Could not retrieve user profile.' });
        }

        res.json({
            subscription: profile.plan || 'Free',
            credits: profile.credits || 0
        });

    } catch (error) {
        console.error("[/user-status] CRITICAL ERROR:", error);
        res.status(500).json({ message: "A critical server error occurred." });
    }
});

app.get('/progress/:jobId', (req, res) => {
    const { jobId } = req.params;
    if (!jobs[jobId]) return res.status(404).json({ message: 'Job not found.' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendProgress = () => {
        const currentJob = jobs[jobId];
        if (!currentJob) {
            clearInterval(intervalId);
            res.end();
            return;
        }
        res.write(`event: progress\ndata: ${JSON.stringify({ progress: currentJob.progress })}\n\n`);
        if (currentJob.status === 'completed') {
            res.write(`event: completed\ndata: ${JSON.stringify(currentJob.result)}\n\n`);
            clearInterval(intervalId); res.end(); delete jobs[jobId];
        } else if (currentJob.status === 'failed') {
            res.write(`event: error\ndata: ${JSON.stringify({ message: currentJob.error })}\n\n`);
            clearInterval(intervalId); res.end(); delete jobs[jobId];
        }
    };

    const intervalId = setInterval(sendProgress, 500);
    req.on('close', () => {
        clearInterval(intervalId);
    });
});

app.post('/create-clip', async (req, res) => {
    let jobId = null;
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ message: 'Unauthorized: No token provided.' });
        const token = authHeader.split(' ')[1];

        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) return res.status(403).json({ message: 'Forbidden: Invalid token.' });

        const { data: profile, error: profileError } = await supabase.from('profiles').select('plan, credits').eq('id', user.id).single();
        if (profileError || !profile) return res.status(500).json({ message: 'Could not retrieve user profile.' });

        const userPlan = (profile.plan || 'free').toLowerCase();

        const permissions = PLAN_PERMISSIONS[userPlan] || PLAN_PERMISSIONS['free'];
        const { videoId, startTime, endTime, format, quality, title = 'clip', mute, audioTrackId, subtitleTrackId } = req.body;
        const duration = endTime - startTime;

        if (duration > permissions.max_duration + 0.1) {
            return res.status(403).json({ message: `Clip duration (${duration.toFixed(1)}s) exceeds your plan's limit of ${permissions.max_duration}s.` });
        }
        if (!isAudioFormat(format) && format !== 'gif' && !permissions.allowed_features.includes(`${quality}_quality`)) {
            return res.status(403).json({ message: `The selected quality (${quality}) is not available on your plan.` });
        }
        if (!permissions.allowed_features.includes(`${format}_format`)) {
            return res.status(403).json({ message: `The selected format (${format}) is not available on your plan.` });
        }

        const requiredCredits = calculateCreditCost(duration, quality, format);
        if (profile.credits < requiredCredits) {
            return res.status(402).json({ message: `Insufficient credits.`, details: { required: requiredCredits, available: profile.credits } });
        }

        const newCredits = profile.credits - requiredCredits;
        const { error: updateError } = await supabase.from('profiles').update({ credits: newCredits }).eq('id', user.id);
        if (updateError) {
            console.error(`[Credit Error] Failed to deduct credits for user ${user.id}:`, updateError);
            return res.status(500).json({ message: 'Failed to update credit balance.' });
        }

        console.log(`[Credits] ✅ Deducted ${requiredCredits} credits for user ${user.id}. New balance: ${newCredits}`);

        jobId = crypto.randomBytes(16).toString('hex');
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const finalFilename = `${sanitizeFilename(title)}.${format}`;

        const clipMetadata = { userId: user.id, name: title, videoUrl, startTime, endTime, quality, format, cost: requiredCredits };

        jobs[jobId] = { status: 'starting', progress: 0, tempFile: `${jobId}.${format}`, finalFile: finalFilename };
        res.status(202).json({ success: true, jobId });

        console.log(`[Job ${jobId}] Starting process for user ${user.id}.`);

        const totalDuration = endTime - startTime;
        const isGif = format === 'gif';
        const videoQuality = isGif ? '720' : (quality || '720');

        let baseAudio = audioTrackId ? audioTrackId : 'bestaudio[ext=m4a]';
        let formatSelection = isAudioFormat(format)
            ? (audioTrackId ? audioTrackId : `bestaudio/best`)
            : `bestvideo[height<=?${parseInt(videoQuality.replace('p', ''))}][ext=mp4]+${baseAudio}/bestvideo+bestaudio/best`;

        // إضافة وسائط تخطي الحظر السحابي هنا أيضاً
        const ytdlpArgs = [
            '--user-agent', USER_AGENT,
            '--no-warnings',
            '--no-check-certificates',
            '--extractor-args', 'youtube:player_client=android,web',
            videoUrl,
            '-f', formatSelection,
            '-g'
        ];

        const ytdlp = spawn(YTDLP_PATH, ytdlpArgs);
        let streamUrls = '';
        ytdlp.stdout.on('data', (data) => streamUrls += data.toString());
        ytdlp.stderr.on('data', (data) => console.error(`[Job ${jobId}] YTDLP Stderr:`, data.toString()));
        ytdlp.on('error', (err) => { jobs[jobId].status = 'failed'; jobs[jobId].error = 'Failed to start yt-dlp.'; });

        ytdlp.on('close', async (code) => {
            if (code !== 0 || !streamUrls.trim()) {
                jobs[jobId].status = 'failed';
                jobs[jobId].error = 'Failed to fetch stream URLs from YouTube.';
                return;
            }
            jobs[jobId].status = 'processing';
            jobs[jobId].progress = 5;

            const outputPath = path.join(CLIPS_DIR, jobs[jobId].tempFile);
            const urls = streamUrls.trim().split('\n');
            const videoStreamUrl = urls[0];
            const audioStreamUrl = isAudioFormat(format) ? null : (urls.length > 1 ? urls[1] : null);

            let subPath = null;
            if (subtitleTrackId && !isAudioFormat(format) && !isGif) {
                console.log(`[Job ${jobId}] Fetching subtitles for lang: ${subtitleTrackId}`);
                const subFileBase = path.join(CLIPS_DIR, `sub_${jobId}`);
                const subProcess = spawn(YTDLP_PATH, [
                    '--user-agent', USER_AGENT,
                    '--no-warnings',
                    '--no-check-certificates',
                    '--extractor-args', 'youtube:player_client=android,web',
                    '--skip-download',
                    '--write-subs',
                    '--write-auto-subs',
                    '--sub-lang', subtitleTrackId,
                    '--convert-subs', 'srt',
                    '-o', subFileBase,
                    videoUrl
                ]);

                await new Promise((resolve) => {
                    subProcess.on('close', (subCode) => {
                        const expectedSubPath = `${subFileBase}.${subtitleTrackId}.srt`;
                        if (subCode === 0 && fs.existsSync(expectedSubPath)) {
                            subPath = expectedSubPath;
                            console.log(`[Job ${jobId}] Subtitles downloaded to ${subPath}`);
                        } else {
                            console.warn(`[Job ${jobId}] Subtitles download failed or not found.`);
                        }
                        resolve();
                    });
                });
            }

            const watermarkFilter = "drawtext=text='ClipsCap.com':x=10:y=H-th-10:fontsize=24:fontcolor=white@0.5:box=1:boxcolor=black@0.4";

            if (isGif) {
                const fps = 15, scale = 540, palettePath = path.join(CLIPS_DIR, `palette_${jobId}.png`);
                const paletteArgs = [
                    '-user_agent', USER_AGENT,
                    '-ss', startTime.toString(),
                    '-t', totalDuration.toString(),
                    '-i', videoStreamUrl,
                    '-vf', `fps=${fps},scale=${scale}:-1:flags=lanczos,palettegen`,
                    '-y', palettePath
                ];
                const paletteProcess = spawn(FFMPEG_PATH, paletteArgs);
                paletteProcess.on('close', (paletteCode) => {
                    if (paletteCode !== 0) { jobs[jobId].status = 'failed'; jobs[jobId].error = 'FFmpeg failed during palette generation.'; return; }
                    jobs[jobId].progress = 50;

                    let filterComplex = `fps=${fps},scale=${scale}:-1:flags=lanczos`;
                    if (permissions.watermark) {
                        console.log(`[Job ${jobId}] Watermark will be applied for this user.`);
                        filterComplex += `,${watermarkFilter}`;
                    }
                    filterComplex += `[x];[x][1:v]paletteuse`;

                    const gifArgs = [
                        '-user_agent', USER_AGENT,
                        '-ss', startTime.toString(),
                        '-t', totalDuration.toString(),
                        '-i', videoStreamUrl,
                        '-i', palettePath,
                        '-filter_complex', filterComplex,
                        '-y', '-progress', 'pipe:1',
                        outputPath
                    ];
                    const gifProcess = spawn(FFMPEG_PATH, gifArgs);
                    handleFfmpegProcess(gifProcess, jobId, totalDuration, clipMetadata, () => {
                        if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath);
                    });
                });
            } else if (isAudioFormat(format)) {
                let ffmpegArgs = [
                    '-user_agent', USER_AGENT,
                    '-ss', startTime.toString(),
                    '-i', videoStreamUrl,
                    '-t', totalDuration.toString(),
                    '-vn'
                ];
                if (format === 'mp3') ffmpegArgs.push('-c:a', 'libmp3lame', '-q:a', '0');
                else if (format === 'wav') ffmpegArgs.push('-c:a', 'pcm_s16le');
                ffmpegArgs.push('-y', '-progress', 'pipe:1', outputPath);

                const ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs);
                handleFfmpegProcess(ffmpegProcess, jobId, totalDuration, clipMetadata);
            } else { // Video formats
                let ffmpegArgs = [];
                ffmpegArgs.push('-user_agent', USER_AGENT);
                ffmpegArgs.push('-ss', startTime.toString(), '-i', videoStreamUrl);
                if (audioStreamUrl) {
                    ffmpegArgs.push('-user_agent', USER_AGENT);
                    ffmpegArgs.push('-ss', startTime.toString(), '-i', audioStreamUrl);
                }

                ffmpegArgs.push('-t', totalDuration.toString());
                if (audioStreamUrl && !mute) ffmpegArgs.push('-map', '0:v:0', '-map', '1:a:0');
                else ffmpegArgs.push('-map', '0:v:0');

                let filters = [];
                if (permissions.watermark) {
                    console.log(`[Job ${jobId}] Watermark will be applied for this user.`);
                    filters.push(watermarkFilter);
                }
                if (subPath) {
                    console.log(`[Job ${jobId}] burning subtitles: ${subPath}`);
                    const escapedSubPath = subPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
                    filters.push(`subtitles='${escapedSubPath}'`);
                }

                if (filters.length > 0) {
                    ffmpegArgs.push('-vf', filters.join(','));
                    ffmpegArgs.push('-c:v', 'libx264');
                } else {
                    ffmpegArgs.push('-c:v', 'copy');
                }

                if (mute) {
                    console.log(`[Job ${jobId}] Muting audio as requested.`);
                    ffmpegArgs.push('-an');
                } else if (audioStreamUrl) {
                    ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
                }

                ffmpegArgs.push('-y', '-progress', 'pipe:1', outputPath);

                const ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs);
                handleFfmpegProcess(ffmpegProcess, jobId, totalDuration, clipMetadata, () => {
                    if (subPath && fs.existsSync(subPath)) fs.unlinkSync(subPath);
                });
            }
        });
    } catch (e) {
        console.error("[/create-clip] CRITICAL ERROR:", e);
        if (jobId && jobs[jobId]) {
            delete jobs[jobId];
        }
        res.status(500).json({ message: "A critical server error occurred." });
    }
});

function handleFfmpegProcess(ffmpegProcess, jobId, totalDuration, clipMetadata, onCompleteCallback) {
    const job = jobs[jobId];
    if (!job) return;
    const baseProgress = job.progress || 5;
    const progressRange = 100 - baseProgress;

    let stderrOutput = '';
    ffmpegProcess.stderr.on('data', (data) => {
        stderrOutput += data.toString();
        const timeMatch = stderrOutput.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/g);
        if (timeMatch) {
            const lastTime = timeMatch.pop();
            const parts = lastTime.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
            const currentTime = parseInt(parts[1]) * 3600 + parseInt(parts[2]) * 60 + parseInt(parts[3]) + parseInt(parts[4]) / 100;
            job.progress = Math.min(99, baseProgress + Math.floor((currentTime / totalDuration) * (progressRange - 1)));
        }
    });

    ffmpegProcess.on('error', (err) => {
        job.status = 'failed';
        job.error = 'FFmpeg failed to start.';
        console.error(`[Job ${jobId}] FFmpeg spawn error:`, err);
    });

    ffmpegProcess.on('close', (code) => {
        if (code === 0 && fs.existsSync(path.join(CLIPS_DIR, job.tempFile))) {
            if (onCompleteCallback) onCompleteCallback();

            async function logClipToDatabase() {
                try {
                    const { error } = await supabase.from('clips').insert({
                        user_id: clipMetadata.userId, name: clipMetadata.name, video_url: clipMetadata.videoUrl,
                        start_time_seconds: Math.round(clipMetadata.startTime), end_time_seconds: Math.round(clipMetadata.endTime),
                        quality: clipMetadata.quality, format: clipMetadata.format, cost: clipMetadata.cost
                    });
                    if (error) console.error(`[Job ${jobId}] ❌ DB Log Error:`, error.message);
                    else console.log(`[Job ${jobId}] ✅ DB Log Success.`);
                } catch (dbError) { console.error(`[Job ${jobId}] ❌ Critical DB Log Error:`, dbError); }
            }
            logClipToDatabase();

            const downloadUrl = `${PUBLIC_API_URL}/download/${job.tempFile}/${encodeURIComponent(job.finalFile)}`;
            job.status = 'completed';
            job.progress = 100;
            job.result = { success: true, downloadUrl };
        } else {
            job.status = 'failed';
            job.error = 'FFmpeg process failed. Check server logs for details.';
            console.error(`[Job ${jobId}] FFmpeg exited with code ${code}. Stderr:`, stderrOutput);
        }
    });
}

// =============================================================
// 6. تشغيل السيرفر على جميع الواجهات 0.0.0.0
// =============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ YouTube Clip Server is running on port ${PORT}`);
    console.log(`🛠️ YTDLP Path: ${YTDLP_PATH}`);
    console.log(`🎬 FFMPEG Path: ${FFMPEG_PATH}`);
    console.log(`🌐 Public API URL: ${PUBLIC_API_URL}`);
});

module.exports = app;