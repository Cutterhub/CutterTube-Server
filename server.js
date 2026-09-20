require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// =============================================================
// 1. تحديد المنفذ والرابط العام
// =============================================================
const PORT = process.env.PORT || 4000;
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 
                       process.env.PUBLIC_BACKEND_URL || 
                       (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);

// =============================================================
// 2. إعدادات CORS الديناميكية
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
        if (!origin || allowedOrigins.includes(origin) || origin.startsWith('chrome-extension://')) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

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
// 4. مسار مجلد المقاطع
// =============================================================
const CLIPS_DIR = process.env.CLIPS_DIR || path.join(__dirname, 'clips');

if (!fs.existsSync(CLIPS_DIR)) {
    fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

// =============================================================
// 5. مسارات الأدوات وإعداد الكوكيز
// =============================================================
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const COOKIES_PATH = path.join(os.tmpdir(), 'youtube_cookies.txt');

if (process.env.YOUTUBE_COOKIES) {
    try {
        let cookieData = process.env.YOUTUBE_COOKIES.trim();
        if (!cookieData.includes('\t') && !cookieData.includes('\n')) {
            cookieData = Buffer.from(cookieData, 'base64').toString('utf8');
        }
        fs.writeFileSync(COOKIES_PATH, cookieData, 'utf8');
        console.log('🍪 Session credentials loaded successfully.');
    } catch (err) {
        console.error('❌ Credentials processing error:', err);
    }
}

function getBaseYtDlpArgs(extraArgs = []) {
    const args = [
        '--user-agent', USER_AGENT,
        '--no-warnings',
        '--no-check-certificates',
        '--no-playlist',
        '--force-ipv4',
        '--js-runtimes', 'node'
    ];

    const localCookieFile = path.join(__dirname, 'cookies.txt');
    const hasCookies = fs.existsSync(COOKIES_PATH) || fs.existsSync(localCookieFile);

    if (hasCookies) {
        const cookieToUse = fs.existsSync(COOKIES_PATH) ? COOKIES_PATH : localCookieFile;
        args.push('--cookies', cookieToUse);
        args.push('--extractor-args', 'youtube:player_client=web,default');
    } else {
        args.push('--extractor-args', 'youtube:player_client=android,ios,web');
    }

    return [...args, ...extraArgs];
}

const jobs = {};

// --- تعريف صلاحيات الخطط ---
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

// دالة مساعدة للبحث في جدول users أو profiles
async function getUserProfileData(userId) {
    let { data: userRow } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

    if (!userRow) {
        const { data: profileRow } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle();
        userRow = profileRow;
    }

    return userRow;
}

// مسار فحص صحة السيرفر (White-labeled)
app.get('/', (req, res) => {
    res.json({ 
        status: 'online', 
        service: 'CutterTube Processing API', 
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

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
                    if (unlinkErr) console.error("[Download] Cleanup error:", unlinkErr);
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
// Endpoint to get Video Metadata (Subs & Audio)
// =============================================================
app.get('/video-metadata', async (req, res) => {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ message: 'Video ID is required.' });

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const ytdlpArgs = getBaseYtDlpArgs(['--dump-json', videoUrl]);
    const ytdlp = spawn(YTDLP_PATH, ytdlpArgs);
    
    let output = '';
    let errorOutput = '';

    ytdlp.stdout.on('data', (data) => output += data.toString());
    ytdlp.stderr.on('data', (data) => errorOutput += data.toString());

    ytdlp.on('close', (code) => {
        if (code !== 0) {
            console.error(`[Metadata] Extraction failed (code ${code}): ${errorOutput}`);
            return res.status(500).json({ 
                message: 'Failed to fetch video details. Please try again later.'
            });
        }

        try {
            const info = JSON.parse(output);

            const audioTracks = [];
            const languageMap = {};

            if (info.formats) {
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
            console.error(`[Metadata] Failed to parse response: ${e}`);
            res.status(500).json({ message: 'Failed to process video metadata.' });
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

        const profile = await getUserProfileData(user.id);

        res.json({
            subscription: profile?.plan || profile?.subscription || 'Free',
            credits: profile?.credits !== undefined ? profile.credits : 100
        });

    } catch (error) {
        console.error("[/user-status] Error:", error);
        res.status(500).json({ message: "A server error occurred." });
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

// =============================================================
// مسار إنشاء وقص الفيديو
// =============================================================
app.post('/create-clip', async (req, res) => {
    let jobId = null;
    try {
        const authHeader = req.headers.authorization;
        let user = null;
        let userPlan = 'free';
        let currentCredits = 100;
        let isGuest = true;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            try {
                const { data: { user: authUser } } = await supabase.auth.getUser(token);
                if (authUser) {
                    user = authUser;
                    isGuest = false;
                    const profile = await getUserProfileData(user.id);
                    userPlan = (profile?.plan || profile?.subscription || 'free').toLowerCase();
                    currentCredits = profile?.credits !== undefined ? profile.credits : 100;
                }
            } catch (authErr) {
                console.warn('[Auth Note] Processing in Guest Mode');
            }
        }

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

        if (!isGuest && user) {
            if (currentCredits < requiredCredits) {
                return res.status(402).json({ message: `Insufficient credits.`, details: { required: requiredCredits, available: currentCredits } });
            }
            const newCredits = Math.max(0, currentCredits - requiredCredits);
            try {
                await supabase.from('users').update({ credits: newCredits }).eq('id', user.id);
                await supabase.from('profiles').update({ credits: newCredits }).eq('id', user.id);
            } catch (e) {
                console.warn('[Credits Update Warning]', e);
            }
            console.log(`[Credits] Deducted ${requiredCredits} credits for user ${user.id}.`);
        } else {
            console.log(`[Guest Mode] Processing clip for guest visitor.`);
        }

        jobId = crypto.randomBytes(16).toString('hex');
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        const cleanTitle = sanitizeFilename(title);
        const finalFilename = `(cuttertube.com) ${cleanTitle}.${format}`;

        const clipMetadata = { 
            userId: user ? user.id : null, 
            name: title, 
            videoUrl, 
            startTime, 
            endTime, 
            quality, 
            format, 
            cost: requiredCredits 
        };

        jobs[jobId] = { status: 'starting', progress: 0, tempFile: `${jobId}.${format}`, finalFile: finalFilename };
        res.status(202).json({ success: true, jobId });

        console.log(`[Job ${jobId}] Starting video processing.`);

        const totalDuration = endTime - startTime;
        const isGif = format === 'gif';
        const videoQuality = isGif ? '720' : (quality || '720');
        const targetHeight = parseInt(videoQuality.replace('p', '')) || 720;
        let baseAudio = audioTrackId ? audioTrackId : 'bestaudio';

        let formatSelection = isAudioFormat(format)
            ? (audioTrackId ? audioTrackId : 'bestaudio/best')
            : `bestvideo[height<=${targetHeight}]+${baseAudio}/bestvideo[height<=${targetHeight}]+bestaudio/best[height<=${targetHeight}]/bestvideo+bestaudio/best`;

        const rawClipPrefix = `raw_${jobId}`;
        const rawClipPath = path.join(CLIPS_DIR, `${rawClipPrefix}.mp4`);
        const finalOutputPath = path.join(CLIPS_DIR, jobs[jobId].tempFile);

        const ytdlpSectionArgs = getBaseYtDlpArgs([
            videoUrl,
            '--download-sections', `*${startTime}-${endTime}`,
            '--force-keyframes-at-cuts',
            '-f', formatSelection,
            '--ffmpeg-location', FFMPEG_PATH,
            '-o', rawClipPath
        ]);

        const ytdlpProcess = spawn(YTDLP_PATH, ytdlpSectionArgs);
        let ytdlpError = '';

        ytdlpProcess.stderr.on('data', (data) => {
            ytdlpError += data.toString();
        });

        ytdlpProcess.on('error', (err) => {
            jobs[jobId].status = 'failed';
            jobs[jobId].error = 'Processing failed to initialize.';
        });

        ytdlpProcess.on('close', async (code) => {
            const foundFiles = fs.readdirSync(CLIPS_DIR).filter(f => f.startsWith(rawClipPrefix) && !f.endsWith('.part'));
            const actualRawPath = foundFiles.length > 0 ? path.join(CLIPS_DIR, foundFiles[0]) : null;

            if (code !== 0 || !actualRawPath || !fs.existsSync(actualRawPath)) {
                jobs[jobId].status = 'failed';
                jobs[jobId].error = 'Failed to extract video section. Please try again.';
                return;
            }

            jobs[jobId].status = 'processing';
            jobs[jobId].progress = 50;

            let subPath = null;
            if (subtitleTrackId && !isAudioFormat(format) && !isGif) {
                const subFileBase = path.join(CLIPS_DIR, `sub_${jobId}`);
                
                const subArgs = getBaseYtDlpArgs([
                    '--skip-download',
                    '--write-subs',
                    '--write-auto-subs',
                    '--sub-lang', subtitleTrackId,
                    '--convert-subs', 'srt',
                    '-o', subFileBase,
                    videoUrl
                ]);
                
                const subProcess = spawn(YTDLP_PATH, subArgs);
                await new Promise((resolve) => {
                    subProcess.on('close', (subCode) => {
                        const expectedSubPath = `${subFileBase}.${subtitleTrackId}.srt`;
                        if (subCode === 0 && fs.existsSync(expectedSubPath)) {
                            subPath = expectedSubPath;
                        }
                        resolve();
                    });
                });
            }

            const watermarkFilter = "drawtext=text='CutterTube.com':x=10:y=H-th-10:fontsize=24:fontcolor=white@0.5:box=1:boxcolor=black@0.4";

            if (isGif) {
                const fps = 15, scale = 540, palettePath = path.join(CLIPS_DIR, `palette_${jobId}.png`);
                const paletteArgs = [
                    '-i', actualRawPath,
                    '-vf', `fps=${fps},scale=${scale}:-1:flags=lanczos,palettegen`,
                    '-y', palettePath
                ];
                const paletteProcess = spawn(FFMPEG_PATH, paletteArgs);
                paletteProcess.on('close', (paletteCode) => {
                    if (paletteCode !== 0) { 
                        jobs[jobId].status = 'failed'; 
                        jobs[jobId].error = 'Image optimization failed.'; 
                        if (fs.existsSync(actualRawPath)) fs.unlinkSync(actualRawPath);
                        return; 
                    }

                    let filterComplex = `fps=${fps},scale=${scale}:-1:flags=lanczos`;
                    if (permissions.watermark) {
                        filterComplex += `,${watermarkFilter}`;
                    }
                    filterComplex += `[x];[x][1:v]paletteuse`;

                    const gifArgs = [
                        '-i', actualRawPath,
                        '-i', palettePath,
                        '-filter_complex', filterComplex,
                        '-y', '-progress', 'pipe:1',
                        finalOutputPath
                    ];
                    const gifProcess = spawn(FFMPEG_PATH, gifArgs);
                    handleFfmpegProcess(gifProcess, jobId, totalDuration, clipMetadata, () => {
                        if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath);
                        if (fs.existsSync(actualRawPath)) fs.unlinkSync(actualRawPath);
                    });
                });
            } else if (isAudioFormat(format)) {
                let ffmpegArgs = [
                    '-i', actualRawPath,
                    '-vn'
                ];
                if (format === 'mp3') ffmpegArgs.push('-c:a', 'libmp3lame', '-q:a', '0');
                else if (format === 'wav') ffmpegArgs.push('-c:a', 'pcm_s16le');
                ffmpegArgs.push('-y', '-progress', 'pipe:1', finalOutputPath);

                const ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs);
                handleFfmpegProcess(ffmpegProcess, jobId, totalDuration, clipMetadata, () => {
                    if (fs.existsSync(actualRawPath)) fs.unlinkSync(actualRawPath);
                });
            } else {
                let ffmpegArgs = ['-i', actualRawPath];
                let filters = [];

                if (permissions.watermark) {
                    filters.push(watermarkFilter);
                }
                if (subPath) {
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
                    ffmpegArgs.push('-an');
                } else {
                    ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
                }

                ffmpegArgs.push('-y', '-progress', 'pipe:1', finalOutputPath);

                const ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs);
                handleFfmpegProcess(ffmpegProcess, jobId, totalDuration, clipMetadata, () => {
                    if (subPath && fs.existsSync(subPath)) fs.unlinkSync(subPath);
                    if (fs.existsSync(actualRawPath)) fs.unlinkSync(actualRawPath);
                });
            }
        });

    } catch (e) {
        console.error("[/create-clip] Error:", e);
        if (jobId && jobs[jobId]) {
            delete jobs[jobId];
        }
        res.status(500).json({ message: "An error occurred while preparing your video." });
    }
});

function handleFfmpegProcess(ffmpegProcess, jobId, totalDuration, clipMetadata, onCompleteCallback) {
    const job = jobs[jobId];
    if (!job) return;
    const baseProgress = job.progress || 50;
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
        job.error = 'Processing encountered an unexpected error.';
        console.error(`[Job ${jobId}] Rendering error:`, err);
    });

    ffmpegProcess.on('close', (code) => {
        if (code === 0 && fs.existsSync(path.join(CLIPS_DIR, job.tempFile))) {
            if (onCompleteCallback) onCompleteCallback();

            async function logClipToDatabase() {
                try {
                    if (!clipMetadata.userId) return;
                    const insertData = {
                        user_id: clipMetadata.userId,
                        name: clipMetadata.name,
                        video_url: clipMetadata.videoUrl,
                        start_time_seconds: Math.round(clipMetadata.startTime),
                        end_time_seconds: Math.round(clipMetadata.endTime),
                        quality: clipMetadata.quality,
                        format: clipMetadata.format
                    };
                    await supabase.from('clips').insert(insertData);
                } catch (dbError) { 
                    console.error(`[Job ${jobId}] Log Error:`, dbError); 
                }
            }
            logClipToDatabase();

            const downloadUrl = `${PUBLIC_API_URL}/download/${job.tempFile}/${encodeURIComponent(job.finalFile)}`;
            job.status = 'completed';
            job.progress = 100;
            job.result = { success: true, downloadUrl };
        } else {
            job.status = 'failed';
            job.error = 'Video processing failed. Please try again.';
            console.error(`[Job ${jobId}] Render exited with code ${code}.`);
        }
    });
}

// =============================================================
// 6. تشغيل السيرفر على جميع الواجهات 0.0.0.0
// =============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ CutterTube Server is running on port ${PORT}`);
    console.log(`🌐 Public API URL: ${PUBLIC_API_URL}`);
});

module.exports = app;