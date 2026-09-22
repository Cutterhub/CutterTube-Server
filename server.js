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
// 1. تحديد المنفذ والرابط العام (Railway / Linux)
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
// 4. مسار مجلد المقاطع المؤقتة (Volume)
// =============================================================
const CLIPS_DIR = process.env.CLIPS_DIR || path.join(__dirname, 'clips');
if (!fs.existsSync(CLIPS_DIR)) {
    fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

// =============================================================
// 5. مسارات الأدوات وإعداد PO Token Provider
// =============================================================
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const COOKIES_PATH = path.join(os.tmpdir(), 'youtube_cookies.txt');

if (process.env.YOUTUBE_COOKIES) {
    try {
        let cookieData = process.env.YOUTUBE_COOKIES.trim();
        if (!cookieData.includes('\t') && !cookieData.includes('\n')) {
            cookieData = Buffer.from(cookieData, 'base64').toString('utf8');
        }
        fs.writeFileSync(COOKIES_PATH, cookieData, 'utf8');
    } catch (err) {
        console.error('❌ Credentials processing error.');
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

    const potProviderUrl = process.env.BGUTIL_POT_PROVIDER_URL || 'http://bgutil-ytdlp-pot-provider.railway.internal:4416';
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${potProviderUrl}`);
    args.push('--extractor-args', 'youtube:player_client=mweb,web,default');

    const localCookieFile = path.join(__dirname, 'cookies.txt');
    const hasCookies = fs.existsSync(COOKIES_PATH) || fs.existsSync(localCookieFile);

    if (process.env.USE_YOUTUBE_COOKIES === 'true' && hasCookies) {
        const cookieToUse = fs.existsSync(COOKIES_PATH) ? COOKIES_PATH : localCookieFile;
        args.push('--cookies', cookieToUse);
    }

    return [...args, ...extraArgs];
}

const jobs = {};

// =============================================================
// 6. تعريف صلاحيات الباقات الثلاث (Free, Basic, Pro)
// =============================================================
const PLAN_PERMISSIONS = {
    free: {
        plan_name: 'Free',
        max_duration: 120,
        watermark: true,
        allowed_qualities: ['144p', '240p', '360p', '480p', '720p'],
        allowed_formats: ['mp4', 'mp3']
    },
    basic: {
        plan_name: 'Basic',
        max_duration: 1800,
        watermark: false,
        allowed_qualities: ['144p', '240p', '360p', '480p', '720p', '1080p'],
        allowed_formats: ['mp4', 'mp3']
    },
    pro: {
        plan_name: 'Pro',
        watermark: false,
        allowed_qualities: ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2k', '2160p', '4k'],
        allowed_formats: ['mp4', 'mp3', 'webm', 'gif', 'wav', 'mkv', 'mov', 'avi']
    }
};

function getMaxDurationForPro(qualityKey, format) {
    if (format === 'mp3') return 2700;
    if (qualityKey === '4k' || qualityKey === '2160p') return 900;
    if (qualityKey === '2k' || qualityKey === '1440p' || qualityKey === '1080p') return 1800;
    if (qualityKey === '720p') return 3600;
    return 7200;
}

function parseTargetHeight(qualityStr) {
    const q = (qualityStr || '').toLowerCase().trim();
    if (q === '4k' || q === '2160p' || q === '2160') return 2160;
    if (q === '2k' || q === '1440p' || q === '1440') return 1440;
    if (q === '1080p' || q === '1080') return 1080;
    if (q === '720p' || q === '720') return 720;
    if (q === '480p' || q === '480') return 480;
    if (q === '360p' || q === '360') return 360;
    if (q === '240p' || q === '240') return 240;
    if (q === '144p' || q === '144') return 144;
    return 720;
}

function isAudioFormat(format) {
    return ['mp3', 'wav'].includes((format || '').toLowerCase());
}

function extractUserIdFromToken(token) {
    try {
        const parts = token.split('.');
        if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
            return payload.sub || payload.id || null;
        }
    } catch (e) {
        return null;
    }
    return null;
}

function resolveUserPlan(userRow) {
    if (!userRow) return 'free';
    if (userRow.is_admin === true || userRow.role === 'admin') return 'pro';
    if (userRow.is_pro === true) return 'pro';
    const plan = String(userRow.plan || 'free').toLowerCase().trim();
    if (['free', 'basic', 'pro'].includes(plan)) return plan;
    if (userRow.role === 'basic') return 'basic';
    return 'free';
}

async function getUserProfileData(userId) {
    if (!userId) return null;
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

function sanitizeFilename(name) {
    if (!name) return 'clip';
    return name.replace(/[\\/:\*\?"<>\|]/g, '_').replace(/^\.+|\.+$/g, '').trim().replace(/\s+/g, ' ');
}

// =============================================================
// مسار فحص صحة السيرفر
// =============================================================
app.get('/', async (req, res) => {
    const potUrl = process.env.BGUTIL_POT_PROVIDER_URL || 'http://bgutil-ytdlp-pot-provider.railway.internal:4416';
    let potReachable = false;
    let potResponse = null;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        const pingRes = await fetch(`${potUrl}/ping`, { signal: controller.signal });
        clearTimeout(timeout);
        potReachable = pingRes.ok;
        potResponse = await pingRes.text();
    } catch (err) {
        potReachable = false;
        potResponse = err.message;
    }

    res.json({ 
        status: 'online', 
        service: 'CutterTube Processing API', 
        version: '1.0.0',
        pot_provider_url: potUrl,
        pot_provider_reachable: potReachable,
        pot_provider_status: potResponse,
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

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'cuttertube-server' });
});

// =============================================================
// GET /video-metadata
// =============================================================
const handleVideoMetadata = async (req, res) => {
    const videoId = req.query.videoId || req.body?.videoId;
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
            console.error(`[Metadata Error] Extraction failed (code ${code}): ${errorOutput}`);
            return res.status(500).json({ 
                message: 'Failed to fetch video details.',
                details: errorOutput ? errorOutput.split('\n').filter(Boolean).slice(-2).join(' ') : 'Unknown error'
            });
        }

        try {
            const info = JSON.parse(output);

            const standardHeights = [144, 240, 360, 480, 720, 1080, 1440, 2160];
            const detectedHeights = new Set();

            if (info.formats && Array.isArray(info.formats)) {
                info.formats.forEach(f => {
                    const hasValidVideo = f.vcodec && f.vcodec !== 'none' && !f.vcodec.startsWith('images');
                    if (hasValidVideo && f.height && typeof f.height === 'number') {
                        detectedHeights.add(f.height);
                    }
                });
            }

            const availableQualities = standardHeights
                .filter(h => {
                    for (const detected of detectedHeights) {
                        if (detected === h || Math.abs(detected - h) <= 10) return true;
                    }
                    return false;
                })
                .map(h => h === 2160 ? '4k' : (h === 1440 ? '2k' : `${h}p`));

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
                availableQualities,
                audioTracks,
                subtitles
            });

        } catch (e) {
            console.error(`[Metadata Parse Error]: ${e.message}`);
            res.status(500).json({ message: 'Failed to process video metadata.', details: e.message });
        }
    });
};

app.get('/video-metadata', handleVideoMetadata);
app.post('/video-metadata', handleVideoMetadata);
app.get('/api/video-metadata', handleVideoMetadata);
app.post('/api/video-metadata', handleVideoMetadata);

// =============================================================
// GET /user-status
// =============================================================
const handleUserStatus = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Unauthorized' });
        }
        const token = authHeader.split(' ')[1];
        let userId = extractUserIdFromToken(token);

        if (!userId) {
            const { data: { user } } = await supabase.auth.getUser(token);
            if (user) userId = user.id;
        }

        const userRow = await getUserProfileData(userId);
        const plan = resolveUserPlan(userRow);

        res.json({
            plan: plan,
            subscription: plan.toUpperCase(),
            is_pro: plan === 'pro',
            is_admin: userRow?.is_admin === true || userRow?.role === 'admin'
        });

    } catch (error) {
        console.error("[/user-status Error]:", error.message);
        res.status(500).json({ message: "A server error occurred." });
    }
};
app.get('/user-status', handleUserStatus);
app.get('/api/user-status', handleUserStatus);

// =============================================================
// GET /progress/:jobId
// =============================================================
const handleProgress = (req, res) => {
    const { jobId } = req.params;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!jobs[jobId]) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Job not found or already finished.' })}\n\n`);
        return res.end();
    }

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
};
app.get('/progress/:jobId', handleProgress);
app.get('/api/progress/:jobId', handleProgress);

// =============================================================
// POST /create-clip
// =============================================================
const handleCreateClip = async (req, res) => {
    let jobId = null;
    try {
        const authHeader = req.headers.authorization;
        let userId = null;
        let userPlan = 'free';

        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            userId = extractUserIdFromToken(token);
            
            if (!userId) {
                try {
                    const { data: { user: authUser } } = await supabase.auth.getUser(token);
                    if (authUser) userId = authUser.id;
                } catch (e) {}
            }

            if (userId) {
                const userRow = await getUserProfileData(userId);
                userPlan = resolveUserPlan(userRow);
            }
        }

        const permissions = PLAN_PERMISSIONS[userPlan] || PLAN_PERMISSIONS['free'];
        const { videoId, startTime, endTime, format = 'mp4', quality = '720p', title = 'clip', mute, audioTrackId, subtitleTrackId } = req.body;
        const duration = endTime - startTime;

        const targetHeight = parseTargetHeight(quality);
        const qualityKey = targetHeight >= 2160 ? '4k' : (targetHeight >= 1440 ? '2k' : `${targetHeight}p`);

        let maxAllowedDuration = permissions.max_duration;
        if (userPlan === 'pro') {
            maxAllowedDuration = getMaxDurationForPro(qualityKey, format.toLowerCase());
        }

        if (duration > maxAllowedDuration + 0.1) {
            const maxMins = Math.round(maxAllowedDuration / 60);
            return res.status(403).json({ 
                message: `Clip duration (${duration.toFixed(1)}s) exceeds your ${permissions.plan_name} plan limit (${maxMins} min) for ${quality}.` 
            });
        }

        const isQualityAllowed = permissions.allowed_qualities.includes(qualityKey) || 
                                 permissions.allowed_qualities.includes(`${targetHeight}p`) ||
                                 (permissions.allowed_qualities.includes('4k') && targetHeight >= 2160) ||
                                 (permissions.allowed_qualities.includes('2k') && targetHeight >= 1440);

        if (!isAudioFormat(format) && format !== 'gif' && !isQualityAllowed) {
            return res.status(403).json({ 
                message: `The selected quality (${quality}) is not available on the ${permissions.plan_name} plan. Please upgrade to access higher resolutions.` 
            });
        }

        if (!permissions.allowed_formats.includes(format.toLowerCase())) {
            return res.status(403).json({ 
                message: `The selected format (${format}) is not available on the ${permissions.plan_name} plan.` 
            });
        }

        jobId = crypto.randomBytes(16).toString('hex');
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        const cleanTitle = sanitizeFilename(title);
        const finalFilename = `(cuttertube.com) ${cleanTitle}.${format}`;

        const clipMetadata = { 
            userId: userId, 
            name: title, 
            videoUrl, 
            startTime, 
            endTime, 
            quality, 
            format, 
            plan: userPlan 
        };

        jobs[jobId] = { status: 'starting', progress: 0, tempFile: `${jobId}.${format}`, finalFile: finalFilename };
        res.status(202).json({ success: true, jobId });

        const totalDuration = endTime - startTime;
        const isGif = format.toLowerCase() === 'gif';
        let baseAudio = audioTrackId ? audioTrackId : 'bestaudio[ext=m4a]/bestaudio/best';

        let formatSelection = isAudioFormat(format)
            ? (audioTrackId ? audioTrackId : 'bestaudio[ext=m4a]/bestaudio/best')
            : `bestvideo[height<=${targetHeight}][vcodec^=avc]+${baseAudio}/bestvideo[height<=${targetHeight}]+${baseAudio}/bestvideo[height<=?${targetHeight}]+${baseAudio}/best`;

        const rawClipPrefix = `raw_${jobId}`;
        const rawClipPath = path.join(CLIPS_DIR, `${rawClipPrefix}.mp4`);
        const finalOutputPath = path.join(CLIPS_DIR, jobs[jobId].tempFile);

        const ytdlpSectionArgs = getBaseYtDlpArgs([
            videoUrl,
            '--download-sections', `*${startTime}-${endTime}`,
            '--downloader-args', 'ffmpeg_i:-threads 2',
            '--downloader-args', 'ffmpeg:-threads 2',
            '-f', formatSelection,
            '--ffmpeg-location', FFMPEG_PATH,
            '-o', rawClipPath
        ]);

        const ytdlpProcess = spawn(YTDLP_PATH, ytdlpSectionArgs);
        let ytdlpFullStderr = '';

        ytdlpProcess.stderr.on('data', (data) => {
            const text = data.toString();
            ytdlpFullStderr += text;
            console.error(`[Job ${jobId} stderr]: ${text.trim()}`);
        });

        ytdlpProcess.on('error', (err) => {
            console.error(`[Job ${jobId}] yt-dlp spawn error:`, err.message);
            jobs[jobId].status = 'failed';
            jobs[jobId].error = 'Processing failed to initialize.';
        });

        ytdlpProcess.on('close', async (code) => {
            const foundFiles = fs.readdirSync(CLIPS_DIR).filter(f => f.startsWith(rawClipPrefix) && !f.endsWith('.part'));
            const actualRawPath = foundFiles.length > 0 ? path.join(CLIPS_DIR, foundFiles[0]) : null;

            if (code !== 0 || !actualRawPath || !fs.existsSync(actualRawPath)) {
                console.error(`[Job ${jobId}] Download failed (code ${code}):`, JSON.stringify({
                    requestedQuality: quality,
                    targetHeight,
                    formatSelection,
                    fullStderr: ytdlpFullStderr
                }, null, 2));

                if (ytdlpFullStderr.includes('Requested format is not available')) {
                    jobs[jobId].status = 'failed';
                    jobs[jobId].error = `Requested ${quality} quality is not available for this video on YouTube.`;
                } else {
                    jobs[jobId].status = 'failed';
                    jobs[jobId].error = 'Failed to extract video section. Please try again.';
                }
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
                    '-threads', '2',
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
                        '-threads', '2',
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
                    '-threads', '2',
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
                let ffmpegArgs = ['-threads', '2', '-i', actualRawPath];
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
                }

                ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22');

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
        console.error("[/create-clip Error]:", e.message);
        if (jobId && jobs[jobId]) {
            delete jobs[jobId];
        }
        res.status(500).json({ message: "An error occurred while preparing your video." });
    }
};
app.post('/create-clip', handleCreateClip);
app.post('/api/create-clip', handleCreateClip);

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
        console.error(`[Job ${jobId}] Rendering process error:`, err.message);
    });

    ffmpegProcess.on('close', (code) => {
        if (code === 0 && fs.existsSync(path.join(CLIPS_DIR, job.tempFile))) {
            if (onCompleteCallback) onCompleteCallback();

            async function logClipToDatabase() {
                try {
                    if (!clipMetadata.userId) return;
                    const insertData = {
                        id: jobId,
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
                    console.error(`[Job ${jobId}] DB Log Warning:`, dbError.message); 
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
            console.error(`[Job ${jobId}] Render process exited with code ${code}.`);
        }
    });
}

// GET /download/:tempFilename/:finalFilename
const handleDownload = (req, res) => {
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
};
app.get('/download/:tempFilename/:finalFilename', handleDownload);
app.get('/api/download/:tempFilename/:finalFilename', handleDownload);

// =============================================================
// 7. تشغيل السيرفر
// =============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ CutterTube Server is running on port ${PORT}`);
    console.log(`🌐 Public API URL: ${PUBLIC_API_URL}`);
});

module.exports = app;