const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLIPS_DIR = process.env.CLIPS_DIR || path.join(__dirname, 'clips');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const COOKIES_PATH = path.join(os.tmpdir(), 'youtube_cookies.txt');

// دالة الأوامر المشتركة لـ yt-dlp
function getBaseYtDlpArgs(extraArgs = []) {
    const potProviderUrl = process.env.BGUTIL_POT_PROVIDER_URL || 'http://bgutil-ytdlp-pot-provider.railway.internal:4416';
    
    const args = [
        '--user-agent', USER_AGENT,
        '--no-warnings',
        '--no-check-certificates',
        '--no-playlist',
        '--force-ipv4',
        '--js-runtimes', 'node',
        '--extractor-args', `youtubepot-bgutilhttp:base_url=${potProviderUrl}`
    ];

    const localCookieFile = path.join(__dirname, 'cookies.txt');
    const hasCookies = fs.existsSync(COOKIES_PATH) || fs.existsSync(localCookieFile);

    if (hasCookies) {
        const cookieToUse = fs.existsSync(COOKIES_PATH) ? COOKIES_PATH : localCookieFile;
        args.push('--cookies', cookieToUse);
    }

    return [...args, ...extraArgs];
}

function spawnYtDlp(args) {
    return spawn('python3', ['-m', 'yt_dlp', ...args]);
}

// =============================================================
// 1. مسار تحويل الفيديو إلى نص (Video to Text / Transcript)
// =============================================================
router.get(['/video-transcript', '/api/video-transcript'], async (req, res) => {
    const { videoId, lang = 'en' } = req.query;
    if (!videoId) return res.status(400).json({ message: 'Video ID is required.' });

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const subFileBase = path.join(CLIPS_DIR, `transcript_${videoId}_${Date.now()}`);

    const subArgs = getBaseYtDlpArgs([
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-lang', lang,
        '--convert-subs', 'vtt',
        '-o', subFileBase,
        videoUrl
    ]);

    const ytdlp = spawnYtDlp(subArgs);
    let stderrOutput = '';

    ytdlp.stderr.on('data', (data) => stderrOutput += data.toString());

    ytdlp.on('close', (code) => {
        let vttPath = `${subFileBase}.${lang}.vtt`;

        if (!fs.existsSync(vttPath)) {
            const foundFiles = fs.readdirSync(CLIPS_DIR).filter(f => f.startsWith(path.basename(subFileBase)) && f.endsWith('.vtt'));
            if (foundFiles.length === 0) {
                return res.status(404).json({ message: 'No subtitles/transcript found for this video.' });
            }
            vttPath = path.join(CLIPS_DIR, foundFiles[0]);
        }

        try {
            const rawVtt = fs.readFileSync(vttPath, 'utf8');
            const lines = rawVtt.split('\n');
            const segments = [];
            let currentText = [];
            let currentStart = '';

            lines.forEach((line) => {
                const timeMatch = line.match(/(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3})/);
                if (timeMatch) {
                    if (currentText.length > 0 && currentStart) {
                        segments.push({
                            time: currentStart,
                            text: currentText.join(' ').replace(/<[^>]*>/g, '').trim()
                        });
                        currentText = [];
                    }
                    currentStart = timeMatch[1].split('.')[0];
                } else if (line.trim() && !line.startsWith('WEBVTT') && !line.startsWith('Kind:') && !line.startsWith('Language:')) {
                    const cleanLine = line.replace(/<[^>]*>/g, '').trim();
                    if (cleanLine && !currentText.includes(cleanLine)) {
                        currentText.push(cleanLine);
                    }
                }
            });

            if (currentText.length > 0 && currentStart) {
                segments.push({
                    time: currentStart,
                    text: currentText.join(' ').replace(/<[^>]*>/g, '').trim()
                });
            }

            const plainText = segments.map(s => s.text).join(' ');
            try { fs.unlinkSync(vttPath); } catch (e) {}

            res.json({
                success: true,
                videoId,
                language: lang,
                plainText,
                segments
            });

        } catch (e) {
            res.status(500).json({ message: 'Failed to parse transcript.', error: e.message });
        }
    });
});

// =============================================================
// 2. مسار تحميل البانر والصورة الشخصية (Banner & Avatar)
// =============================================================
router.get(['/channel-assets', '/api/channel-assets'], async (req, res) => {
    let { url, channelUrl, handle } = req.query;
    let targetUrl = url || channelUrl || handle;

    if (!targetUrl) {
        return res.status(400).json({ message: 'Channel URL, handle (@name), or video URL is required.' });
    }

    if (targetUrl.startsWith('@')) {
        targetUrl = `https://www.youtube.com/${targetUrl}`;
    } else if (!targetUrl.startsWith('http')) {
        targetUrl = `https://www.youtube.com/@${targetUrl}`;
    }

    const ytdlpArgs = getBaseYtDlpArgs([
        '--dump-json',
        '--playlist-items', '1',
        targetUrl
    ]);

    const ytdlp = spawnYtDlp(ytdlpArgs);
    let output = '';
    let errorOutput = '';

    ytdlp.stdout.on('data', (data) => output += data.toString());
    ytdlp.stderr.on('data', (data) => errorOutput += data.toString());

    ytdlp.on('close', (code) => {
        if (code !== 0 || !output.trim()) {
            return res.status(404).json({ 
                message: 'Could not fetch channel details. Please verify the URL.', 
                details: errorOutput ? errorOutput.split('\n')[0] : 'Unknown error' 
            });
        }

        try {
            const info = JSON.parse(output);
            const channelTitle = info.channel || info.uploader || info.title || 'YouTube Channel';
            const channelUrl = info.channel_url || info.uploader_url || targetUrl;

            // استخراج الأفاتار
            const avatarUrl = info.channel_thumbnail || info.uploader_avatar || info.thumbnails?.find(t => t.id === 'avatar')?.url || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`;

            // استخراج البانر
            let bannerUrl = null;
            if (info.thumbnails && Array.isArray(info.thumbnails)) {
                const banners = info.thumbnails.filter(t => (t.width && t.width > 1000) || (t.id && t.id.includes('banner')));
                if (banners.length > 0) {
                    bannerUrl = banners[banners.length - 1].url;
                }
            }

            res.json({
                success: true,
                channelTitle,
                channelUrl,
                avatar: {
                    high: avatarUrl.replace(/=s\d+/, '=s800'),
                    medium: avatarUrl.replace(/=s\d+/, '=s300'),
                    low: avatarUrl.replace(/=s\d+/, '=s100')
                },
                banner: {
                    original: bannerUrl,
                    desktop: bannerUrl ? bannerUrl.replace(/=w\d+/, '=w2120') : null,
                    mobile: bannerUrl ? bannerUrl.replace(/=w\d+/, '=w1060') : null
                }
            });

        } catch (e) {
            res.status(500).json({ message: 'Failed to parse channel assets.', error: e.message });
        }
    });
});

module.exports = router;