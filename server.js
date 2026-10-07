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
// 1. المنفذ والرابط العام (Railway / Linux)
// =============================================================

const PORT = process.env.PORT || 4000;

const PUBLIC_API_URL =
    process.env.PUBLIC_API_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    (
        process.env.RAILWAY_PUBLIC_DOMAIN
            ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
            : `http://localhost:${PORT}`
    );

// =============================================================
// 2. إعدادات CORS
// =============================================================

app.use(cors({
    origin: (origin, callback) => {
        if (
            !origin ||
            origin.includes('cuttertube.com') ||
            origin.includes('vercel.app') ||
            origin.includes('localhost') ||
            origin.includes('127.0.0.1') ||
            origin.startsWith('chrome-extension://')
        ) {
            return callback(null, true);
        }

        return callback(null, true);
    },

    credentials: true,

    methods: [
        'GET',
        'POST',
        'OPTIONS'
    ],

    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-app-client',
        'x-requested-with'
    ]
}));

app.options('*', cors());

// =============================================================
// 3. التحقق من متغيرات Supabase
// =============================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error(
        '❌ CRITICAL ERROR: Supabase URL or Service Key is missing in .env file.'
    );

    process.exit(1);
}

const supabase = createClient(
    supabaseUrl,
    supabaseKey,
    {
        auth: {
            persistSession: false
        },

        realtime: {
            createSocket: () => null
        }
    }
);

// =============================================================
// 4. مجلد المقاطع المؤقتة
// =============================================================

const CLIPS_DIR =
    process.env.CLIPS_DIR ||
    path.join(__dirname, 'clips');

if (!fs.existsSync(CLIPS_DIR)) {
    fs.mkdirSync(
        CLIPS_DIR,
        {
            recursive: true
        }
    );
}

// =============================================================
// 5. مسارات الأدوات
// =============================================================

const FFMPEG_PATH =
    process.env.FFMPEG_PATH ||
    'ffmpeg';

const YTDLP_PATH =
    process.env.YTDLP_PATH ||
    'yt-dlp';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/121.0.0.0 Safari/537.36';

const COOKIES_PATH =
    path.join(
        os.tmpdir(),
        'youtube_cookies.txt'
    );

// =============================================================
// 6. تحميل YouTube Cookies إذا كانت موجودة
// =============================================================

if (process.env.YOUTUBE_COOKIES) {
    try {
        let cookieData =
            process.env.YOUTUBE_COOKIES.trim();

        if (
            !cookieData.includes('\t') &&
            !cookieData.includes('\n')
        ) {
            cookieData =
                Buffer
                    .from(cookieData, 'base64')
                    .toString('utf8');
        }

        fs.writeFileSync(
            COOKIES_PATH,
            cookieData,
            'utf8'
        );

        console.log(
            '🍪 Session credentials loaded successfully.'
        );

    } catch (err) {

        console.error(
            '❌ Credentials processing error:',
            err.message
        );
    }
}

// =============================================================
// 7. إعداد Arguments الخاصة بـ yt-dlp
// =============================================================

function getBaseYtDlpArgs(extraArgs = []) {
    const potProviderUrl = process.env.BGUTIL_POT_PROVIDER_URL || 'http://bgutil-ytdlp-pot-provider.railway.internal:4416';

    const args = [
        '--user-agent', USER_AGENT,
        '--no-warnings',
        '--no-check-certificates',
        '--no-playlist',
        '--force-ipv4',
        '--js-runtimes', 'node',
        // دمج خادم التوكنات وعملاء يوتيوب المتوافقة
        '--extractor-args', `youtubepot-bgutilhttp:base_url=${potProviderUrl}`,
        '--extractor-args', 'youtube:player_client=mweb,android,ios,web'
    ];

    const localCookieFile = path.join(__dirname, 'cookies.txt');
    const hasCookies = fs.existsSync(COOKIES_PATH) || fs.existsSync(localCookieFile);

    if (hasCookies) {
        const cookieToUse = fs.existsSync(COOKIES_PATH) ? COOKIES_PATH : localCookieFile;
        args.push('--cookies', cookieToUse);
    }

    return [...args, ...extraArgs];
}

// =============================================================
// 8. تشغيل yt-dlp
// =============================================================

function spawnYtDlp(args) {
    const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';

    console.log(`[yt-dlp] Executable: ${ytdlpPath}`);
    console.log(`[yt-dlp] Arguments: ${args.join(' ')}`);

    return spawn(ytdlpPath, args, {
        env: {
            ...process.env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

// =============================================================
// 9. Jobs
// =============================================================

const jobs = {};

// =============================================================
// 10. تعريف صلاحيات الباقات
// =============================================================

const PLAN_PERMISSIONS = {

    free: {
        plan_name: 'Free',
        max_duration: 120,
        watermark: true,
        allowed_qualities: [
            '144p',
            '240p',
            '360p',
            '480p',
            '720p'
        ],
        allowed_formats: [
            'mp4',
            'mp3'
        ]
    },

    basic: {
        plan_name: 'Basic',
        max_duration: 1800,
        watermark: false,
        allowed_qualities: [
            '144p',
            '240p',
            '360p',
            '480p',
            '720p',
            '1080p'
        ],
        allowed_formats: [
            'mp4',
            'mp3',
            'webm',
            'gif'
        ]
    },

    pro: {
        plan_name: 'Pro',
        watermark: false,
        allowed_qualities: [
            '144p',
            '240p',
            '360p',
            '480p',
            '720p',
            '1080p',
            '1440p',
            '2k',
            '2160p',
            '4k'
        ],
        allowed_formats: [
            'mp4',
            'mp3',
            'webm',
            'gif',
            'wav',
            'mkv',
            'mov',
            'avi'
        ]
    }
};

// =============================================================
// 11. مدة Pro حسب الجودة
// =============================================================

function getMaxDurationForPro(
    qualityKey,
    format
) {

    if (format === 'mp3') {
        return 2700;
    }

    if (
        qualityKey === '4k' ||
        qualityKey === '2160p'
    ) {
        return 900;
    }

    if (
        qualityKey === '2k' ||
        qualityKey === '1440p' ||
        qualityKey === '1080p'
    ) {
        return 1800;
    }

    if (qualityKey === '720p') {
        return 3600;
    }

    return 7200;
}

// =============================================================
// 12. تحويل الجودة إلى Height
// =============================================================

function parseTargetHeight(
    qualityStr
) {

    const q =
        (qualityStr || '')
            .toLowerCase()
            .trim();

    if (
        q === '4k' ||
        q === '2160p' ||
        q === '2160'
    ) {
        return 2160;
    }

    if (
        q === '2k' ||
        q === '1440p' ||
        q === '1440'
    ) {
        return 1440;
    }

    if (
        q === '1080p' ||
        q === '1080'
    ) {
        return 1080;
    }

    if (
        q === '720p' ||
        q === '720'
    ) {
        return 720;
    }

    if (
        q === '480p' ||
        q === '480'
    ) {
        return 480;
    }

    if (
        q === '360p' ||
        q === '360'
    ) {
        return 360;
    }

    if (
        q === '240p' ||
        q === '240'
    ) {
        return 240;
    }

    if (
        q === '144p' ||
        q === '144'
    ) {
        return 144;
    }

    return 720;
}

// =============================================================
// 13. Audio format
// =============================================================

function isAudioFormat(format) {

    return [
        'mp3',
        'wav'
    ].includes(
        (format || '').toLowerCase()
    );
}

// =============================================================
// 14. قراءة JWT
// =============================================================

function extractTokenData(token) {

    try {

        const parts =
            token.split('.');

        if (parts.length === 3) {

            const payload =
                JSON.parse(
                    Buffer
                        .from(
                            parts[1],
                            'base64'
                        )
                        .toString('utf8')
                );

            return {

                id:
                    payload.sub ||
                    payload.id ||
                    null,

                email:
                    payload.email ||
                    null
            };
        }

    } catch (e) {
        // Ignore invalid JWT
    }

    return {
        id: null,
        email: null
    };
}

// =============================================================
// 15. تحديد خطة المستخدم
// =============================================================

function resolveUserPlan(
    userRow
) {

    if (!userRow) {
        return 'free';
    }

    const email =
        (userRow.email || '')
            .trim()
            .toLowerCase();

    if (
        userRow.is_admin === true ||
        userRow.role === 'admin' ||
        email === 'admin@cuttertube.com' ||
        email === 'abdela456a@gmail.com'
    ) {
        return 'pro';
    }

    if (userRow.is_pro === true) {
        return 'pro';
    }

    const plan =
        String(
            userRow.plan || 'free'
        )
        .toLowerCase()
        .trim();

    if (
        [
            'free',
            'basic',
            'pro'
        ].includes(plan)
    ) {
        return plan;
    }

    if (userRow.role === 'basic') {
        return 'basic';
    }

    return 'free';
}

// =============================================================
// 16. بيانات المستخدم
// =============================================================

async function getUserProfileData(
    userId,
    userEmail
) {

    if (
        !userId &&
        !userEmail
    ) {
        return null;
    }

    let profile = null;

    if (userId) {

        const {
            data
        } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle();

        if (data) {
            profile = data;
        }
    }

    if (
        !profile &&
        userEmail
    ) {

        const {
            data
        } = await supabase
            .from('profiles')
            .select('*')
            .eq(
                'email',
                userEmail
                    .trim()
                    .toLowerCase()
            )
            .maybeSingle();

        if (data) {
            profile = data;
        }
    }

    return profile;
}

// =============================================================
// 17. تنظيف اسم الملف
// =============================================================

function sanitizeFilename(name) {

    if (!name) {
        return 'clip';
    }

    return name
        .replace(
            /[\\/:\*\?"<>\|]/g,
            '_'
        )
        .replace(
            /^\.+|\.+$/g,
            ''
        )
        .trim()
        .replace(
            /\s+/g,
            ' '
        );
}

// =============================================================
// 18. Root
// =============================================================

app.get(
    '/',
    (req, res) => {

        res.json({

            status: 'online',

            service:
                'CutterTube Processing API',

            version: '1.0.0',

            cookies_loaded:
                fs.existsSync(
                    COOKIES_PATH
                ) ||
                fs.existsSync(
                    path.join(
                        __dirname,
                        'cookies.txt'
                    )
                ),

            yt_dlp_path:
                YTDLP_PATH,

            ffmpeg_path:
                FFMPEG_PATH,

            bgutil_enabled:
                Boolean(
                    process.env.BGUTIL_POT_PROVIDER_URL?.trim()
                ),

            timestamp:
                new Date().toISOString()
        });
    }
);

// =============================================================
// 19. Health
// =============================================================

const handleHealth = (
    req,
    res
) => {

    res.status(200).json({

        status: 'ok',

        service:
            'cuttertube-server'
    });
};

app.get(
    '/health',
    handleHealth
);

app.get(
    '/api/health',
    handleHealth
);

// =============================================================
// 20. Video Metadata
// =============================================================

async function handleVideoMetadata(
    req,
    res
) {

    const videoId =
        req.query.videoId ||
        req.body?.videoId;

    if (!videoId) {

        return res
            .status(400)
            .json({
                message:
                    'Video ID is required.'
            });
    }

    const videoUrl =
        `https://www.youtube.com/watch?v=${videoId}`;

    const ytdlpArgs =
        getBaseYtDlpArgs([
            '--dump-json',
            videoUrl
        ]);

    const ytdlp =
        spawnYtDlp(
            ytdlpArgs
        );

    let output = '';
    let errorOutput = '';

    ytdlp.stdout.on(
        'data',
        (data) => {
            output += data.toString();
        }
    );

    ytdlp.stderr.on(
        'data',
        (data) => {
            errorOutput += data.toString();
        }
    );

    ytdlp.on(
        'error',
        (error) => {

            console.error(
                '[Metadata Spawn Error]:',
                error.message
            );

            if (!res.headersSent) {

                res.status(500).json({
                    message:
                        'Failed to start yt-dlp.',
                    details:
                        error.message
                });
            }
        }
    );

    ytdlp.on(
        'close',
        (code) => {

            if (res.headersSent) {
                return;
            }

            if (code !== 0) {

                console.error(
                    `[Metadata Error] (code ${code}): ${errorOutput}`
                );

                return res
                    .status(500)
                    .json({

                        message:
                            'Failed to fetch video details.',

                        details:
                            errorOutput
                                ? errorOutput
                                    .split('\n')
                                    .filter(Boolean)
                                    .slice(-3)
                                    .join(' ')
                                : 'Unknown error'
                    });
            }

            try {

                const info =
                    JSON.parse(
                        output
                    );

                const standardHeights = [
                    144,
                    240,
                    360,
                    480,
                    720,
                    1080,
                    1440,
                    2160
                ];

                const detectedHeights =
                    new Set();

                if (
                    info.formats &&
                    Array.isArray(info.formats)
                ) {

                    info.formats.forEach(
                        (f) => {

                            const hasValidVideo =
                                f.vcodec &&
                                f.vcodec !== 'none' &&
                                !f.vcodec.startsWith(
                                    'images'
                                );

                            if (
                                hasValidVideo &&
                                f.height &&
                                typeof f.height === 'number'
                            ) {

                                detectedHeights.add(
                                    f.height
                                );
                            }
                        }
                    );
                }

                const availableQualities =
                    standardHeights
                        .filter(
                            (h) => {

                                for (
                                    const detected
                                    of detectedHeights
                                ) {

                                    if (
                                        detected === h ||
                                        Math.abs(
                                            detected - h
                                        ) <= 10
                                    ) {
                                        return true;
                                    }
                                }

                                return false;
                            }
                        )
                        .map(
                            (h) => {

                                if (h === 2160) {
                                    return '4k';
                                }

                                if (h === 1440) {
                                    return '2k';
                                }

                                return `${h}p`;
                            }
                        );

                const audioTracks = [];
                const languageMap = {};

                if (info.formats) {

                    info.formats.forEach(
                        (f) => {

                            const hasAudio =
                                f.acodec &&
                                f.acodec !== 'none';

                            const hasNoVideo =
                                !f.vcodec ||
                                f.vcodec === 'none';

                            if (
                                hasAudio &&
                                hasNoVideo
                            ) {

                                const lang =
                                    f.language ||
                                    f.lang ||
                                    f.language_code ||
                                    null;

                                if (lang) {

                                    const name =
                                        f.language_preference ||
                                        f.language_note ||
                                        f.format_note ||
                                        lang;

                                    const key =
                                        `${lang}_${name}`;

                                    if (
                                        !languageMap[key] ||
                                        (f.tbr || 0) >
                                        (languageMap[key].tbr || 0)
                                    ) {

                                        languageMap[key] = {

                                            id:
                                                f.format_id,

                                            language:
                                                lang,

                                            language_name:
                                                name,

                                            tbr:
                                                f.tbr || 0
                                        };
                                    }
                                }
                            }
                        }
                    );
                }

                if (
                    info.audio_tracks &&
                    Array.isArray(
                        info.audio_tracks
                    )
                ) {

                    info.audio_tracks.forEach(
                        (track) => {

                            const lang =
                                track.id ||
                                track.language ||
                                'unknown';

                            const name =
                                track.name ||
                                track.language_preference ||
                                lang;

                            const key =
                                `${lang}_${name}`;

                            if (
                                !languageMap[key]
                            ) {

                                languageMap[key] = {

                                    id:
                                        track.id ||
                                        track.format_id,

                                    language:
                                        lang,

                                    language_name:
                                        name,

                                    tbr: 0
                                };
                            }
                        }
                    );
                }

                for (
                    const key in languageMap
                ) {

                    audioTracks.push(
                        languageMap[key]
                    );
                }

                const subtitles = [];

                if (info.subtitles) {

                    for (
                        const lang
                        in info.subtitles
                    ) {

                        subtitles.push({

                            id: lang,

                            name:
                                info
                                    .subtitles[lang][0]
                                    ?.name ||
                                lang,

                            is_auto: false
                        });
                    }
                }

                if (
                    info.automatic_captions
                ) {

                    for (
                        const lang
                        in info.automatic_captions
                    ) {

                        subtitles.push({

                            id: lang,

                            name:
                                (
                                    info
                                        .automatic_captions[lang][0]
                                        ?.name ||
                                    lang
                                ) +
                                ' (auto)',

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

                console.error(
                    `[Metadata Parse Error]: ${e.message}`
                );

                res
                    .status(500)
                    .json({

                        message:
                            'Failed to process video metadata.',

                        details:
                            e.message
                    });
            }
        }
    );
}

app.get(
    '/video-metadata',
    handleVideoMetadata
);

app.post(
    '/video-metadata',
    handleVideoMetadata
);

app.get(
    '/api/video-metadata',
    handleVideoMetadata
);

app.post(
    '/api/video-metadata',
    handleVideoMetadata
);

// =============================================================
// 21. User Status
// =============================================================

async function handleUserStatus(
    req,
    res
) {

    try {

        const authHeader =
            req.headers.authorization;

        if (
            !authHeader ||
            !authHeader.startsWith(
                'Bearer '
            )
        ) {

            return res
                .status(401)
                .json({
                    message:
                        'Unauthorized'
                });
        }

        const token =
            authHeader.split(' ')[1];

        const tokenData =
            extractTokenData(
                token
            );

        let userId =
            tokenData.id;

        let userEmail =
            tokenData.email;

        if (!userId) {

            const {
                data: {
                    user
                }
            } =
                await supabase.auth.getUser(
                    token
                );

            if (user) {

                userId =
                    user.id;

                userEmail =
                    user.email;
            }
        }

        const userRow =
            await getUserProfileData(
                userId,
                userEmail
            );

        const plan =
            resolveUserPlan(
                userRow
            );

        res.json({

            plan,

            subscription:
                plan.toUpperCase(),

            is_pro:
                plan === 'pro',

            is_admin:
                userRow?.is_admin === true ||
                userRow?.role === 'admin'
        });

    } catch (error) {

        console.error(
            '[/user-status Error]:',
            error.message
        );

        res
            .status(500)
            .json({
                message:
                    'A server error occurred.'
            });
    }
}

app.get(
    '/user-status',
    handleUserStatus
);

app.get(
    '/api/user-status',
    handleUserStatus
);

// =============================================================
// 22. SSE Progress
// =============================================================

function handleProgress(
    req,
    res
) {

    const {
        jobId
    } = req.params;

    res.setHeader(
        'Content-Type',
        'text/event-stream; charset=utf-8'
    );

    res.setHeader(
        'Cache-Control',
        'no-cache, no-transform'
    );

    res.setHeader(
        'Connection',
        'keep-alive'
    );

    res.setHeader(
        'X-Accel-Buffering',
        'no'
    );

    res.flushHeaders();

    if (!jobs[jobId]) {

        res.write(
            `event: error\ndata: ${JSON.stringify({
                message:
                    'Job not found or already finished.'
            })}\n\n`
        );

        return res.end();
    }

    res.write(
        `: connected\n\n`
    );

    const sendProgress = () => {

        const currentJob =
            jobs[jobId];

        if (!currentJob) {

            clearInterval(
                intervalId
            );

            return res.end();
        }

        res.write(
            `event: progress\ndata: ${JSON.stringify({
                progress:
                    currentJob.progress
            })}\n\n`
        );

        if (
            currentJob.status ===
            'completed'
        ) {

            res.write(
                `event: completed\ndata: ${JSON.stringify(
                    currentJob.result
                )}\n\n`
            );

            clearInterval(
                intervalId
            );

            res.end();

            delete jobs[jobId];

        } else if (
            currentJob.status ===
            'failed'
        ) {

            res.write(
                `event: error\ndata: ${JSON.stringify({
                    message:
                        currentJob.error ||
                        'Video processing failed.'
                })}\n\n`
            );

            clearInterval(
                intervalId
            );

            res.end();

            delete jobs[jobId];
        }
    };

    const intervalId =
        setInterval(
            sendProgress,
            500
        );

    req.on(
        'close',
        () => {

            clearInterval(
                intervalId
            );
        }
    );
}

app.get(
    '/progress/:jobId',
    handleProgress
);

app.get(
    '/api/progress/:jobId',
    handleProgress
);

// =============================================================
// 23. Create Clip
// =============================================================

async function handleCreateClip(
    req,
    res
) {

    let jobId = null;

    try {

        const authHeader =
            req.headers.authorization;

        let userId = null;

        let userEmail =
            req.body?.email ||
            null;

        let userPlan =
            'free';

        if (
            authHeader &&
            authHeader.startsWith(
                'Bearer '
            )
        ) {

            const token =
                authHeader.split(
                    ' '
                )[1];

            const tokenData =
                extractTokenData(
                    token
                );

            userId =
                tokenData.id;

            if (!userEmail) {
                userEmail =
                    tokenData.email;
            }

            if (!userId) {

                try {

                    const {
                        data: {
                            user: authUser
                        }
                    } =
                        await supabase.auth.getUser(
                            token
                        );

                    if (authUser) {

                        userId =
                            authUser.id;

                        if (!userEmail) {

                            userEmail =
                                authUser.email;
                        }
                    }

                } catch (e) {
                    // Continue as free
                }
            }

            const userRow =
                await getUserProfileData(
                    userId,
                    userEmail
                );

            userPlan =
                resolveUserPlan(
                    userRow
                );

        } else if (
            req.body?.userId ||
            req.body?.user_id ||
            req.body?.email
        ) {

            const userRow =
                await getUserProfileData(
                    req.body.userId ||
                    req.body.user_id,
                    req.body.email
                );

            userPlan =
                resolveUserPlan(
                    userRow
                );
        }

        const permissions =
            PLAN_PERMISSIONS[userPlan] ||
            PLAN_PERMISSIONS.free;

        const {
            videoId,
            startTime,
            endTime,
            format = 'mp4',
            quality = '720p',
            title = 'clip',
            mute,
            audioTrackId,
            subtitleTrackId
        } = req.body;

        if (!videoId) {

            return res
                .status(400)
                .json({
                    message:
                        'Video ID is required.'
                });
        }

        const numericStart =
            Number(startTime);

        const numericEnd =
            Number(endTime);

        if (
            !Number.isFinite(
                numericStart
            ) ||
            !Number.isFinite(
                numericEnd
            ) ||
            numericStart < 0 ||
            numericEnd <= numericStart
        ) {

            return res
                .status(400)
                .json({
                    message:
                        'Invalid start or end time.'
                });
        }

        const duration =
            numericEnd -
            numericStart;

        const targetHeight =
            parseTargetHeight(
                quality
            );

        const qualityKey =
            targetHeight >= 2160
                ? '4k'
                : targetHeight >= 1440
                    ? '2k'
                    : `${targetHeight}p`;

        let maxAllowedDuration =
            permissions.max_duration;

        if (userPlan === 'pro') {

            maxAllowedDuration =
                getMaxDurationForPro(
                    qualityKey,
                    String(format).toLowerCase()
                );
        }

        if (
            duration >
            maxAllowedDuration + 0.1
        ) {

            const maxMins =
                Math.round(
                    maxAllowedDuration /
                    60
                );

            return res
                .status(403)
                .json({

                    message:
                        `Clip duration (${duration.toFixed(1)}s) exceeds your ${permissions.plan_name} plan limit (${maxMins} min) for ${quality}.`
                });
        }

        const isQualityAllowed =
            permissions.allowed_qualities.includes(
                qualityKey
            ) ||
            permissions.allowed_qualities.includes(
                `${targetHeight}p`
            ) ||
            (
                permissions.allowed_qualities.includes(
                    '4k'
                ) &&
                targetHeight >= 2160
            ) ||
            (
                permissions.allowed_qualities.includes(
                    '2k'
                ) &&
                targetHeight >= 1440
            );

        if (
            !isAudioFormat(format) &&
            format !== 'gif' &&
            !isQualityAllowed
        ) {

            return res
                .status(403)
                .json({

                    message:
                        `The selected quality (${quality}) is not available on the ${permissions.plan_name} plan. Please upgrade to access higher resolutions.`
                });
        }

        if (
            !permissions.allowed_formats.includes(
                String(format).toLowerCase()
            )
        ) {

            return res
                .status(403)
                .json({

                    message:
                        `The selected format (${format}) is not available on the ${permissions.plan_name} plan.`
                });
        }

        jobId =
            crypto
                .randomBytes(16)
                .toString('hex');

        const videoUrl =
            `https://www.youtube.com/watch?v=${videoId}`;

        const cleanTitle =
            sanitizeFilename(
                title
            );

        const finalFilename =
            `(cuttertube.com) ${cleanTitle}.${format}`;

        const clipMetadata = {

            userId,

            name:
                title,

            videoUrl,

            startTime:
                numericStart,

            endTime:
                numericEnd,

            quality,

            format,

            plan:
                userPlan
        };

        jobs[jobId] = {

            status:
                'starting',

            progress:
                0,

            tempFile:
                `${jobId}.${format}`,

            finalFile:
                finalFilename
        };

        res.status(202).json({

            success: true,

            jobId
        });

        const totalDuration =
            duration;

        const isGif =
            String(format).toLowerCase() ===
            'gif';

        const baseAudio =
            audioTrackId
                ? audioTrackId
                : 'bestaudio/best';

        let formatSelection;

        if (isAudioFormat(format)) {
            formatSelection = audioTrackId || 'bestaudio/best';
        } else {
            formatSelection =
                `bestvideo[height<=${targetHeight}]+${baseAudio}/best` +
                `/bestvideo[height<=${targetHeight}]/best`;
        }

        const rawClipPrefix =
            `raw_${jobId}`;

        const rawClipPath =
            path.join(
                CLIPS_DIR,
                `${rawClipPrefix}.mp4`
            );

        const finalOutputPath =
            path.join(
                CLIPS_DIR,
                jobs[jobId].tempFile
            );

        const ytdlpSectionArgs =
            getBaseYtDlpArgs([

                videoUrl,

                '--download-sections',
                `*${numericStart}-${numericEnd}`,

                '--format-sort',
                `res:${targetHeight},vcodec:vp9,vcodec:avc,acodec:m4a`,

                '--downloader-args',
                'ffmpeg_i:-threads 2',

                '--downloader-args',
                'ffmpeg:-threads 2',

                '-f',
                formatSelection,

                '--ffmpeg-location',
                FFMPEG_PATH,

                '-o',
                rawClipPath
            ]);

        const ytdlpProcess =
            spawnYtDlp(
                ytdlpSectionArgs
            );

        let ytdlpFullStderr =
            '';

        ytdlpProcess.stderr.on(
            'data',
            (data) => {

                const text =
                    data.toString();

                ytdlpFullStderr +=
                    text;

                console.error(
                    `[Job ${jobId} stderr]: ${text.trim()}`
                );
            }
        );

        ytdlpProcess.on(
            'error',
            (err) => {

                console.error(
                    `[Job ${jobId}] yt-dlp spawn error:`,
                    err.message
                );

                if (jobs[jobId]) {

                    jobs[jobId].status =
                        'failed';

                    jobs[jobId].error =
                        `yt-dlp could not start: ${err.message}`;
                }
            }
        );

        ytdlpProcess.on(
            'close',
            async (code) => {

                if (!jobs[jobId]) {
                    return;
                }

                let foundFiles = [];

                try {

                    foundFiles =
                        fs
                            .readdirSync(
                                CLIPS_DIR
                            )
                            .filter(
                                (f) =>
                                    f.startsWith(
                                        rawClipPrefix
                                    ) &&
                                    !f.endsWith(
                                        '.part'
                                    )
                            );

                } catch (e) {

                    console.error(
                        `[Job ${jobId}] Could not read clips directory:`,
                        e.message
                    );
                }

                const actualRawPath =
                    foundFiles.length > 0
                        ? path.join(
                            CLIPS_DIR,
                            foundFiles[0]
                        )
                        : null;

                if (
                    code !== 0 ||
                    !actualRawPath ||
                    !fs.existsSync(
                        actualRawPath
                    )
                ) {

                    console.error(
                        `[Job ${jobId}] Download failed (code ${code}):`,
                        JSON.stringify(
                            {
                                requestedQuality:
                                    quality,

                                targetHeight,

                                formatSelection,

                                fullStderr:
                                    ytdlpFullStderr
                            },
                            null,
                            2
                        )
                    );

                    if (
                        ytdlpFullStderr.includes(
                            'Requested format is not available'
                        )
                    ) {

                        jobs[jobId].status =
                            'failed';

                        jobs[jobId].error =
                            `Requested ${quality} quality is not available for this video on YouTube.`;

                    } else {

                        jobs[jobId].status =
                            'failed';

                        jobs[jobId].error =
                            'Failed to extract video section. Please try again.';
                    }

                    return;
                }

                jobs[jobId].status =
                    'processing';

                jobs[jobId].progress =
                    50;

                let subPath =
                    null;

                if (
                    subtitleTrackId &&
                    !isAudioFormat(format) &&
                    !isGif
                ) {

                    const subFileBase =
                        path.join(
                            CLIPS_DIR,
                            `sub_${jobId}`
                        );

                    const subArgs =
                        getBaseYtDlpArgs([

                            '--skip-download',

                            '--write-subs',

                            '--write-auto-subs',

                            '--sub-lang',
                            subtitleTrackId,

                            '--convert-subs',
                            'srt',

                            '-o',
                            subFileBase,

                            videoUrl
                        ]);

                    const subProcess =
                        spawnYtDlp(
                            subArgs
                        );

                    await new Promise(
                        (resolve) => {

                            let subError = '';

                            subProcess.stderr.on(
                                'data',
                                (data) => {
                                    subError +=
                                        data.toString();
                                }
                            );

                            subProcess.on(
                                'close',
                                (subCode) => {

                                    const expectedSubPath =
                                        `${subFileBase}.${subtitleTrackId}.srt`;

                                    if (
                                        subCode === 0 &&
                                        fs.existsSync(
                                            expectedSubPath
                                        )
                                    ) {

                                        subPath =
                                            expectedSubPath;

                                    } else if (
                                        subError
                                    ) {

                                        console.error(
                                            `[Job ${jobId}] Subtitle warning: ${subError.trim()}`
                                        );
                                    }

                                    resolve();
                                }
                            );

                            subProcess.on(
                                'error',
                                () => {
                                    resolve();
                                }
                            );
                        }
                    );
                }

                const watermarkFilter =
                    "drawtext=text='CutterTube.com':x=10:y=H-th-10:fontsize=24:fontcolor=white@0.5:box=1:boxcolor=black@0.4";

                if (isGif) {

                    const fps =
                        15;

                    const scale =
                        540;

                    const palettePath =
                        path.join(
                            CLIPS_DIR,
                            `palette_${jobId}.png`
                        );

                    const paletteArgs = [

                        '-threads',
                        '2',

                        '-i',
                        actualRawPath,

                        '-vf',
                        `fps=${fps},scale=${scale}:-1:flags=lanczos,palettegen`,

                        '-y',

                        palettePath
                    ];

                    const paletteProcess =
                        spawn(
                            FFMPEG_PATH,
                            paletteArgs
                        );

                    paletteProcess.on(
                        'error',
                        (err) => {

                            jobs[jobId].status =
                                'failed';

                            jobs[jobId].error =
                                `FFmpeg could not start: ${err.message}`;
                        }
                    );

                    paletteProcess.on(
                        'close',
                        (paletteCode) => {

                            if (
                                paletteCode !== 0
                            ) {

                                jobs[jobId].status =
                                    'failed';

                                jobs[jobId].error =
                                    'Image optimization failed.';

                                if (
                                    fs.existsSync(
                                        actualRawPath
                                    )
                                ) {

                                    fs.unlinkSync(
                                        actualRawPath
                                    );
                                }

                                return;
                            }

                            let filterComplex =
                                `fps=${fps},scale=${scale}:-1:flags=lanczos`;

                            if (
                                permissions.watermark
                            ) {

                                filterComplex +=
                                    `,${watermarkFilter}`;
                            }

                            filterComplex +=
                                `[x];[x][1:v]paletteuse`;

                            const gifArgs = [

                                '-threads',
                                '2',

                                '-i',
                                actualRawPath,

                                '-i',
                                palettePath,

                                '-filter_complex',
                                filterComplex,

                                '-y',

                                '-progress',
                                'pipe:1',

                                finalOutputPath
                            ];

                            const gifProcess =
                                spawn(
                                    FFMPEG_PATH,
                                    gifArgs
                                );

                            handleFfmpegProcess(
                                gifProcess,
                                jobId,
                                totalDuration,
                                clipMetadata,
                                () => {

                                    if (
                                        fs.existsSync(
                                            palettePath
                                        )
                                    ) {

                                        fs.unlinkSync(
                                            palettePath
                                        );
                                    }

                                    if (
                                        fs.existsSync(
                                            actualRawPath
                                        )
                                    ) {

                                        fs.unlinkSync(
                                            actualRawPath
                                        );
                                    }
                                }
                            );
                        }
                    );

                } else if (
                    isAudioFormat(format)
                ) {

                    let ffmpegArgs = [

                        '-threads',
                        '2',

                        '-i',
                        actualRawPath,

                        '-vn'
                    ];

                    if (
                        String(format).toLowerCase() ===
                        'mp3'
                    ) {

                        ffmpegArgs.push(
                            '-c:a',
                            'libmp3lame',

                            '-q:a',
                            '0'
                        );

                    } else if (
                        String(format).toLowerCase() ===
                        'wav'
                    ) {

                        ffmpegArgs.push(
                            '-c:a',
                            'pcm_s16le'
                        );
                    }

                    ffmpegArgs.push(

                        '-y',

                        '-progress',
                        'pipe:1',

                        finalOutputPath
                    );

                    const ffmpegProcess =
                        spawn(
                            FFMPEG_PATH,
                            ffmpegArgs
                        );

                    handleFfmpegProcess(
                        ffmpegProcess,
                        jobId,
                        totalDuration,
                        clipMetadata,
                        () => {

                            if (
                                fs.existsSync(
                                    actualRawPath
                                )
                            ) {

                                fs.unlinkSync(
                                    actualRawPath
                                );
                            }
                        }
                    );

                } else {

                    let ffmpegArgs = [

                        '-threads',
                        '2',

                        '-i',
                        actualRawPath
                    ];

                    let filters = [];

                    if (
                        permissions.watermark
                    ) {

                        filters.push(
                            watermarkFilter
                        );
                    }

                    if (subPath) {

                        const escapedSubPath =
                            subPath
                                .replace(
                                    /\\/g,
                                    '/'
                                )
                                .replace(
                                    /:/g,
                                    '\\:'
                                )
                                .replace(
                                    /'/g,
                                    "\\'"
                                );

                        filters.push(
                            `subtitles='${escapedSubPath}'`
                        );
                    }

                    if (
                        filters.length > 0
                    ) {

                        ffmpegArgs.push(
                            '-vf',
                            filters.join(',')
                        );
                    }

                    ffmpegArgs.push(

                        '-c:v',
                        'libx264',

                        '-preset',
                        'ultrafast',

                        '-crf',
                        '22'
                    );

                    if (mute) {

                        ffmpegArgs.push(
                            '-an'
                        );

                    } else {

                        ffmpegArgs.push(

                            '-c:a',
                            'aac',

                            '-b:a',
                            '192k'
                        );
                    }

                    ffmpegArgs.push(

                        '-y',

                        '-progress',
                        'pipe:1',

                        finalOutputPath
                    );

                    const ffmpegProcess =
                        spawn(
                            FFMPEG_PATH,
                            ffmpegArgs
                        );

                    handleFfmpegProcess(
                        ffmpegProcess,
                        jobId,
                        totalDuration,
                        clipMetadata,
                        () => {

                            if (
                                subPath &&
                                fs.existsSync(
                                    subPath
                                )
                            ) {

                                fs.unlinkSync(
                                    subPath
                                );
                            }

                            if (
                                fs.existsSync(
                                    actualRawPath
                                )
                            ) {

                                fs.unlinkSync(
                                    actualRawPath
                                );
                            }
                        }
                    );
                }
            }
        );

    } catch (e) {

        console.error(
            '[/create-clip Error]:',
            e.message
        );

        if (
            jobId &&
            jobs[jobId]
        ) {

            delete jobs[jobId];
        }

        if (!res.headersSent) {

            res
                .status(500)
                .json({
                    message:
                        'An error occurred while preparing your video.'
                });
        }
    }
}

app.post(
    '/create-clip',
    handleCreateClip
);

app.post(
    '/api/create-clip',
    handleCreateClip
);

// =============================================================
// 24. FFmpeg Process Handler
// =============================================================

function handleFfmpegProcess(
    ffmpegProcess,
    jobId,
    totalDuration,
    clipMetadata,
    onCompleteCallback
) {

    const job =
        jobs[jobId];

    if (!job) {
        return;
    }

    const baseProgress =
        job.progress || 50;

    const progressRange =
        100 - baseProgress;

    let stderrOutput =
        '';

    ffmpegProcess.stderr.on(
        'data',
        (data) => {

            stderrOutput +=
                data.toString();

            const timeMatch =
                stderrOutput.match(
                    /time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/g
                );

            if (timeMatch) {

                const lastTime =
                    timeMatch[
                        timeMatch.length - 1
                    ];

                const parts =
                    lastTime.match(
                        /(\d{2}):(\d{2}):(\d{2})\.(\d{2})/
                    );

                if (parts) {

                    const currentTime =
                        parseInt(parts[1]) *
                            3600 +

                        parseInt(parts[2]) *
                            60 +

                        parseInt(parts[3]) +

                        parseInt(parts[4]) /
                            100;

                    if (
                        totalDuration > 0
                    ) {

                        job.progress =
                            Math.min(
                                99,

                                baseProgress +
                                Math.floor(
                                    (
                                        currentTime /
                                        totalDuration
                                    ) *
                                    (
                                        progressRange -
                                        1
                                    )
                                )
                            );
                    }
                }
            }
        }
    );

    ffmpegProcess.on(
        'error',
        (err) => {

            job.status =
                'failed';

            job.error =
                `FFmpeg failed to start: ${err.message}`;

            console.error(
                `[Job ${jobId}] Rendering process error:`,
                err.message
            );
        }
    );

    ffmpegProcess.on(
        'close',
        (code) => {

            if (!jobs[jobId]) {
                return;
            }

            const isFileReady =
                (
                    code === 0 ||
                    code === null
                ) &&
                fs.existsSync(
                    path.join(
                        CLIPS_DIR,
                        job.tempFile
                    )
                );

            if (isFileReady) {

                if (onCompleteCallback) {

                    try {
                        onCompleteCallback();
                    } catch (cleanupError) {

                        console.error(
                            `[Job ${jobId}] Cleanup error:`,
                            cleanupError.message
                        );
                    }
                }

                async function logClipToDatabase() {

                    try {

                        if (
                            !clipMetadata.userId
                        ) {
                            return;
                        }

                        const insertData = {

                            id:
                                jobId,

                            user_id:
                                clipMetadata.userId,

                            name:
                                clipMetadata.name,

                            video_url:
                                clipMetadata.videoUrl,

                            start_time_seconds:
                                Math.round(
                                    clipMetadata.startTime
                                ),

                            end_time_seconds:
                                Math.round(
                                    clipMetadata.endTime
                                ),

                            quality:
                                clipMetadata.quality,

                            format:
                                clipMetadata.format
                        };

                        const {
                            error
                        } =
                            await supabase
                                .from('clips')
                                .insert(
                                    insertData
                                );

                        if (error) {

                            console.error(
                                `[Job ${jobId}] DB Log Warning:`,
                                error.message
                            );
                        }

                    } catch (dbError) {

                        console.error(
                            `[Job ${jobId}] DB Log Warning:`,
                            dbError.message
                        );
                    }
                }

                logClipToDatabase();

                const downloadUrl =
                    `${PUBLIC_API_URL}/download/${encodeURIComponent(
                        job.tempFile
                    )}/${encodeURIComponent(
                        job.finalFile
                    )}`;

                job.status =
                    'completed';

                job.progress =
                    100;

                job.result = {

                    success:
                        true,

                    downloadUrl
                };

            } else {

                job.status =
                    'failed';

                job.error =
                    'Video processing failed. Please try again.';

                console.error(
                    `[Job ${jobId}] Render process exited with code ${code}.`
                );

                if (stderrOutput) {

                    console.error(
                        `[Job ${jobId}] FFmpeg stderr:`,
                        stderrOutput
                    );
                }
            }
        }
    );
}

// =============================================================
// 25. Download
// =============================================================

function handleDownload(
    req,
    res
) {

    try {

        const {
            tempFilename,
            finalFilename
        } = req.params;

        const decodedFinalFilename =
            decodeURIComponent(
                finalFilename
            );

        const filePath =
            path.join(
                CLIPS_DIR,
                tempFilename
            );

        if (
            !fs.existsSync(
                filePath
            )
        ) {

            return res
                .status(404)
                .send(
                    'File expired or not found. Please create clip again.'
                );
        }

        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${encodeURIComponent(
                decodedFinalFilename
            )}"`
        );

        res.download(
            filePath,
            decodedFinalFilename,
            (err) => {

                if (
                    err &&
                    err.code !== 'ECONNABORTED'
                ) {

                    console.error(
                        '[Download Note]:',
                        err.message
                    );
                }

                setTimeout(
                    () => {

                        try {

                            if (
                                fs.existsSync(
                                    filePath
                                )
                            ) {

                                fs.unlinkSync(
                                    filePath
                                );

                                console.log(
                                    `🧹 Temp file ${tempFilename} cleaned up.`
                                );
                            }

                        } catch (e) {
                            // Ignore cleanup error
                        }

                    },
                    5 * 60 * 1000
                );
            }
        );

    } catch (error) {

        console.error(
            '[Download Error]',
            error
        );

        res
            .status(500)
            .send(
                'An internal server error occurred.'
            );
    }
}

app.get(
    '/download/:tempFilename/:finalFilename',
    handleDownload
);

app.get(
    '/api/download/:tempFilename/:finalFilename',
    handleDownload
);

// =============================================================
// 26. Video Transcript
// =============================================================

app.get(
    [
        '/video-transcript',
        '/api/video-transcript'
    ],
    async (req, res) => {

        const {
            videoId,
            lang = 'en'
        } = req.query;

        if (!videoId) {

            return res
                .status(400)
                .json({
                    message:
                        'Video ID is required.'
                });
        }

        const videoUrl =
            `https://www.youtube.com/watch?v=${videoId}`;

        const subFileBase =
            path.join(
                CLIPS_DIR,
                `transcript_${videoId}_${Date.now()}`
            );

        const subArgs =
            getBaseYtDlpArgs([

                '--skip-download',

                '--write-subs',

                '--write-auto-subs',

                '--sub-lang',
                lang,

                '--convert-subs',
                'vtt',

                '-o',
                subFileBase,

                videoUrl
            ]);

        const ytdlp =
            spawnYtDlp(
                subArgs
            );

        let stderrOutput =
            '';

        ytdlp.stderr.on(
            'data',
            (data) => {

                stderrOutput +=
                    data.toString();
            }
        );

        ytdlp.on(
            'error',
            (error) => {

                console.error(
                    '[Transcript Spawn Error]:',
                    error.message
                );

                if (!res.headersSent) {

                    res
                        .status(500)
                        .json({
                            message:
                                'Failed to start yt-dlp.',
                            error:
                                error.message
                        });
                }
            }
        );

        ytdlp.on(
            'close',
            (code) => {

                if (res.headersSent) {
                    return;
                }

                let vttPath =
                    `${subFileBase}.${lang}.vtt`;

                if (
                    !fs.existsSync(
                        vttPath
                    )
                ) {

                    let foundFiles = [];

                    try {

                        foundFiles =
                            fs
                                .readdirSync(
                                    CLIPS_DIR
                                )
                                .filter(
                                    (f) =>
                                        f.startsWith(
                                            path.basename(
                                                subFileBase
                                            )
                                        ) &&
                                        f.endsWith(
                                            '.vtt'
                                        )
                                );

                    } catch (e) {
                        foundFiles = [];
                    }

                    if (
                        foundFiles.length === 0
                    ) {

                        return res
                            .status(404)
                            .json({

                                message:
                                    'No subtitles/transcript found for this video.',

                                details:
                                    stderrOutput
                                        ? stderrOutput
                                            .split('\n')
                                            .filter(Boolean)
                                            .slice(-2)
                                            .join(' ')
                                        : `yt-dlp exited with code ${code}`
                            });
                    }

                    vttPath =
                        path.join(
                            CLIPS_DIR,
                            foundFiles[0]
                        );
                }

                try {

                    const rawVtt =
                        fs.readFileSync(
                            vttPath,
                            'utf8'
                        );

                    const lines =
                        rawVtt.split(
                            '\n'
                        );

                    const segments = [];

                    let currentText = [];

                    let currentStart =
                        '';

                    lines.forEach(
                        (line) => {

                            const timeMatch =
                                line.match(
                                    /(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3})/
                                );

                            if (timeMatch) {

                                if (
                                    currentText.length >
                                    0 &&
                                    currentStart
                                ) {

                                    segments.push({

                                        time:
                                            currentStart,

                                        text:
                                            currentText
                                                .join(' ')
                                                .replace(
                                                    /<[^>]*>/g,
                                                    ''
                                                )
                                                .trim()
                                    });

                                    currentText =
                                        [];
                                }

                                currentStart =
                                    timeMatch[1]
                                        .split('.')[0];

                            } else if (
                                line.trim() &&
                                !line.startsWith(
                                    'WEBVTT'
                                ) &&
                                !line.startsWith(
                                    'Kind:'
                                ) &&
                                !line.startsWith(
                                    'Language:'
                                )
                            ) {

                                const cleanLine =
                                    line
                                        .replace(
                                            /<[^>]*>/g,
                                            ''
                                        )
                                        .trim();

                                if (
                                    cleanLine &&
                                    !currentText.includes(
                                        cleanLine
                                    )
                                ) {

                                    currentText.push(
                                        cleanLine
                                    );
                                }
                            }
                        }
                    );

                    if (
                        currentText.length > 0 &&
                        currentStart
                    ) {

                        segments.push({

                            time:
                                currentStart,

                            text:
                                currentText
                                    .join(' ')
                                    .replace(
                                        /<[^>]*>/g,
                                        ''
                                    )
                                    .trim()
                        });
                    }

                    const plainText =
                        segments
                            .map(
                                (s) =>
                                    s.text
                            )
                            .join(' ');

                    try {
                        fs.unlinkSync(
                            vttPath
                        );
                    } catch (e) {
                        // Ignore
                    }

                    res.json({

                        success:
                            true,

                        videoId,

                        language:
                            lang,

                        plainText,

                        segments
                    });

                } catch (e) {

                    res
                        .status(500)
                        .json({

                            message:
                                'Failed to parse transcript.',

                            error:
                                e.message
                        });
                }
            }
        );
    }
);

// =============================================================
// 27. Channel Assets
// =============================================================

app.get(
    [
        '/channel-assets',
        '/api/channel-assets'
    ],
    async (req, res) => {

        let {
            url,
            channelUrl,
            handle
        } = req.query;

        let targetUrl =
            url ||
            channelUrl ||
            handle;

        if (!targetUrl) {

            return res
                .status(400)
                .json({

                    message:
                        'Channel URL, handle (@name), or video URL is required.'
                });
        }

        if (
            targetUrl.startsWith('@')
        ) {

            targetUrl =
                `https://www.youtube.com/${targetUrl}`;

        } else if (
            !targetUrl.startsWith('http')
        ) {

            targetUrl =
                `https://www.youtube.com/@${targetUrl}`;
        }

        const ytdlpArgs =
            getBaseYtDlpArgs([

                '--dump-json',

                '--playlist-items',
                '1',

                targetUrl
            ]);

        const ytdlp =
            spawnYtDlp(
                ytdlpArgs
            );

        let output =
            '';

        let errorOutput =
            '';

        ytdlp.stdout.on(
            'data',
            (data) => {

                output +=
                    data.toString();
            }
        );

        ytdlp.stderr.on(
            'data',
            (data) => {

                errorOutput +=
                    data.toString();
            }
        );

        ytdlp.on(
            'error',
            (error) => {

                console.error(
                    '[Channel Assets Spawn Error]:',
                    error.message
                );

                if (!res.headersSent) {

                    res
                        .status(500)
                        .json({

                            message:
                                'Failed to start yt-dlp.',

                            details:
                                error.message
                        });
                }
            }
        );

        ytdlp.on(
            'close',
            (code) => {

                if (res.headersSent) {
                    return;
                }

                if (
                    code !== 0 ||
                    !output.trim()
                ) {

                    return res
                        .status(404)
                        .json({

                            message:
                                'Could not fetch channel details.',

                            details:
                                errorOutput
                                    ? errorOutput
                                        .split('\n')
                                        .filter(Boolean)
                                        .slice(-2)
                                        .join(' ')
                                    : `yt-dlp exited with code ${code}`
                        });
                }

                try {

                    const info =
                        JSON.parse(
                            output
                        );

                    const channelTitle =
                        info.channel ||
                        info.uploader ||
                        info.title ||
                        'YouTube Channel';

                    const resolvedChannelUrl =
                        info.channel_url ||
                        info.uploader_url ||
                        targetUrl;

                    const avatarUrl =
                        info.channel_thumbnail ||
                        info.uploader_avatar ||
                        info.thumbnails?.find(
                            (t) =>
                                t.id ===
                                'avatar'
                        )?.url ||
                        (
                            info.id
                                ? `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`
                                : null
                        );

                    let bannerUrl =
                        null;

                    if (
                        info.thumbnails &&
                        Array.isArray(
                            info.thumbnails
                        )
                    ) {

                        const banners =
                            info.thumbnails.filter(
                                (t) =>
                                    (
                                        t.width &&
                                        t.width > 1000
                                    ) ||
                                    (
                                        t.id &&
                                        t.id.includes(
                                            'banner'
                                        )
                                    )
                            );

                        if (
                            banners.length > 0
                        ) {

                            bannerUrl =
                                banners[
                                    banners.length - 1
                                ].url;
                        }
                    }

                    res.json({

                        success:
                            true,

                        channelTitle,

                        channelUrl:
                            resolvedChannelUrl,

                        avatar: {

                            high:
                                avatarUrl
                                    ? avatarUrl.replace(
                                        /=s\d+/,
                                        '=s800'
                                    )
                                    : null,

                            medium:
                                avatarUrl
                                    ? avatarUrl.replace(
                                        /=s\d+/,
                                        '=s300'
                                    )
                                    : null,

                            low:
                                avatarUrl
                                    ? avatarUrl.replace(
                                        /=s\d+/,
                                        '=s100'
                                    )
                                    : null
                        },

                        banner: {

                            original:
                                bannerUrl,

                            desktop:
                                bannerUrl
                                    ? bannerUrl.replace(
                                        /=w\d+/,
                                        '=w2120'
                                    )
                                    : null,

                            mobile:
                                bannerUrl
                                    ? bannerUrl.replace(
                                        /=w\d+/,
                                        '=w1060'
                                    )
                                    : null
                        }
                    });

                } catch (e) {

                    res
                        .status(500)
                        .json({

                            message:
                                'Failed to parse channel assets.',

                            error:
                                e.message
                        });
                }
            }
        );
    }
);

// =============================================================
// 28. دالة التحقق من البرامج عند الإقلاع
// =============================================================

function checkBinary(binary, args = ['--version']) {
    return new Promise((resolve) => {
        const proc = spawn(binary, args, {
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let output = '';

        proc.stdout.on('data', data => {
            output += data.toString();
        });

        proc.stderr.on('data', data => {
            output += data.toString();
        });

        proc.on('error', error => {
            console.error(`[Startup] ${binary} ERROR: ${error.message}`);
            resolve(false);
        });

        proc.on('close', code => {
            console.log(
                `[Startup] ${binary}: exit=${code} ${output.trim()}`
            );
            resolve(code === 0);
        });
    });
}

// =============================================================
// 29. تشغيل السيرفر
// =============================================================

app.listen(
    PORT,
    '0.0.0.0',
    async () => {

        console.log(
            `🚀 CutterTube API running on port ${PORT}`
        );

        console.log(
            `🌐 Public API: ${PUBLIC_API_URL}`
        );

        const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';

        console.log('🔧 Checking processing binaries...');

        await checkBinary(ytdlpPath, ['--version']);
        await checkBinary(FFMPEG_PATH, ['-version']);

        console.log('✅ Binary checks completed.');

        console.log(
            `🔐 BGUTIL enabled: ${
                Boolean(
                    process.env.BGUTIL_POT_PROVIDER_URL?.trim()
                )
            }`
        );
    }
);

module.exports = app;