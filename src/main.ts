/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter } from '@songloft/plugin-sdk';

const router = createRouter();
const requestLogs: any[] = [];

// 🌟 保活计时器句柄
let keepAliveTimer: any = null;

// 🌟 向前端暴露系统级插件 Token
router.get('/api/token', async () => {
    try {
        const token = await songloft.plugin.getToken();
        return jsonResponse({ token });
    } catch (e) {
        return jsonResponse({ token: "" }, 500);
    }
});

// ==========================================
// 🛡️ 防火墙伪装与请求头配置
// ==========================================
const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*"
};

// ==========================================
// 🛡️ 参数强制解析器 (解决 query 字符串化问题)
// ==========================================
function getQueryParams(req: HTTPRequest): Record<string, string> {
    const query: Record<string, string> = {};
    if (!req.query) return query;

    if (typeof req.query === 'object') return req.query as Record<string, string>;

    if (typeof req.query === 'string') {
        const pairs = req.query.split('&');
        for (const pair of pairs) {
            const [k, v] = pair.split('=');
            if (k) query[k] = v ? decodeURIComponent(v.replace(/\+/g, ' ')) : "";
        }
    }
    return query;
}

function logIncomingRequest(req: HTTPRequest) {
    const headers = req.headers || {};
    const clientIp = (req as any).clientIP || (req as any).ip || headers['x-forwarded-for'] || headers['X-Forwarded-For'] || headers['x-real-ip'] || "未知";

    const logEntry = {
        time: new Date().toISOString(),
        method: req.method,
        path: req.path,
        query: getQueryParams(req),
        headers: headers,
        ip: clientIp,
        responseValue: "-"
    };

    requestLogs.unshift(logEntry);
    if (requestLogs.length > 10) requestLogs.pop();

    return logEntry;
}

// ==========================================
// 🎵 核心工具函数
// ==========================================
function cleanStr(str: string): string {
    if (!str) return "";
    return String(str).replace(/\.[^/.]+$/, "").replace(/[\(（].*?[\)）]/g, '').replace(/\s+/g, '').toLowerCase().trim();
}

function parseArtists(str: string): string[] {
    if (!str) return [];
    return str.split(/&|、|,|，|\/|\||和|与|feat\.|ft\./i).map(a => a.replace(/\s+/g, '').toLowerCase().trim()).filter(a => a);
}

function isArtistMatch(localArtists: string[], apiArtists: string[]): boolean {
    if (localArtists.length === 0 || apiArtists.length === 0) return false;
    return localArtists.some(la => apiArtists.includes(la));
}

async function fetchWithTimeout(url: string, timeoutMs = 3000): Promise<any> {
    try {
        const res: any = await Promise.race([
            fetch(url, { method: 'GET', headers: COMMON_HEADERS }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeoutMs))
        ]);
        return res;
    } catch (e) {
        return null;
    }
}

// ==========================================
// 🖼️ 封面刮削 (优先 Apple -> 兜底网易云)
// ==========================================
async function fetchCover(title: string, artist: string, album: string): Promise<string | null> {
    const searchTerm = `${title || ''} ${artist || ''} ${album || ''}`.trim();
    if (!searchTerm) return null;

    try {
        const appleUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&media=music&entity=song&limit=1`;
        let res = await fetchWithTimeout(appleUrl);

        if (res && res.status === 429) {
            await new Promise(r => setTimeout(r, 3000));
            res = await fetchWithTimeout(appleUrl);
        }

        if (res && res.ok) {
            const data = await res.json();
            if (data && data.results && data.results.length > 0) {
                return data.results[0].artworkUrl100.replace('100x100bb', '600x600bb');
            }
        }
    } catch (e) {}

    try {
        const neteaseUrl = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(searchTerm)}&type=1&limit=1`;
        const neRes = await fetchWithTimeout(neteaseUrl);
        if (neRes && neRes.ok) {
            const neData = await neRes.json();
            if (neData && neData.result && neData.result.songs && neData.result.songs.length > 0) {
                const al = neData.result.songs[0].al;
                if (al && al.picUrl) {
                    return al.picUrl + "?param=600y600";
                }
            }
        }
    } catch (e) {}

    return null;
}

// ==========================================
// 🎤 lrc.cx 评分刮削引擎
// ==========================================
async function fetchFromLrcCx(title: string, artist: string): Promise<string | null> {
    if (!title) return null;

    const url = `https://api.lrc.cx/jsonapi?title=${encodeURIComponent(title)}` + (artist ? `&artist=${encodeURIComponent(artist)}` : "");
    const res = await fetchWithTimeout(url);

    if (!res || !res.ok) return null;

    let data: any;
    try { data = await res.json(); } catch(e) { return null; }

    let bestLrc: string | null = null;

    if (Array.isArray(data) && data.length > 0) {
        const cLocalTitle = cleanStr(title);
        const localArtists = parseArtists(artist);
        const rawLocalTitle = title.toLowerCase().replace(/\s+/g, '');

        let highestScore = -999;

        for (const item of data) {
            const lrcText = item.lrc;
            if (typeof lrcText !== 'string' || lrcText.length < 60 || !/\[(\d{1,2}):(\d{2})(?:\.\d{1,3})?\]/m.test(lrcText)) continue;

            const cApiTitle = cleanStr(item.title);
            const rawApiTitle = item.title.toLowerCase().replace(/\s+/g, '');
            const apiArtists = parseArtists(item.artist);

            let score = 0;

            if (rawLocalTitle === rawApiTitle) score += 50;
            else if (cLocalTitle === cApiTitle) score += 40;
            else if (cLocalTitle && cApiTitle && (cApiTitle.includes(cLocalTitle) || cLocalTitle.includes(cApiTitle))) score += 20;

            const penaltyTags = ["live", "remix", "dj", "伴奏", "清唱", "合唱", "cover", "翻唱"];
            for (const tag of penaltyTags) {
                if (rawApiTitle.includes(tag) && !rawLocalTitle.includes(tag)) score -= 15;
            }

            if (isArtistMatch(localArtists, apiArtists)) {
                 const isExact = localArtists.length === apiArtists.length && localArtists.every(la => apiArtists.includes(la));
                 if (isExact) score += 40; else score += 25;
            } else {
                score -= 20;
            }

            score += 30;
            if (lrcText.length > 150) score += 10;
            if (item.from === 'Netease') score += 10;
            if (lrcText.includes('作词') || lrcText.includes('作詞')) score += 5;
            if (lrcText.includes('作曲')) score += 5;

            if (score > highestScore) {
                highestScore = score;
                if (highestScore >= 60) bestLrc = lrcText;
                else bestLrc = null;
            }
        }
    }
    return bestLrc;
}

async function scrapeLyric(title: string, artist: string, filename: string): Promise<string | null> {
    if (!artist && title) {
        filename = title;
        title = "";
    }

    if (title && artist) {
        const lrc = await fetchFromLrcCx(title, artist);
        if (lrc) return lrc;
    }

    if (filename) {
        if (filename.includes('-')) {
            const parts = filename.split('-');
            const part1 = parts[0].trim();
            const part2 = parts.slice(1).join('-').trim();

            let lrc = await fetchFromLrcCx(part1, part2);
            if (lrc) return lrc;

            lrc = await fetchFromLrcCx(part2, part1);
            if (lrc) return lrc;
        } else {
            let lrc = await fetchFromLrcCx(filename, "");
            if (lrc) return lrc;
        }

        const qTerm = encodeURIComponent(filename);
        const res3 = await fetchWithTimeout(`https://lrclib.net/api/search?q=${qTerm}`);
        if (res3 && res3.ok) {
            try {
                const data = await res3.json();
                if (data && data.length > 0) {
                    const synced = data[0].syncedLyrics;
                    if (synced && synced.length >= 60) {
                        return synced;
                    }
                }
            } catch(e) {}
        }
    }

    return null;
}

// ==========================================
// 🚀 路由定义
// ==========================================
router.get('/api/debug/logs', () => {
    return jsonResponse(requestLogs);
});

router.delete('/api/debug/logs', () => {
    requestLogs.length = 0;
    return jsonResponse({ msg: "已清空" });
});

router.get('/api/yinliu/cover', async (req) => {
    const q = getQueryParams(req);
    const title = q.title || q.name || "";
    const artist = q.artist || "";
    const album = q.album || "";

    const coverUrl = await fetchCover(title, artist, album);

    if (coverUrl) {
        return {
            statusCode: 302,
            headers: { 'Location': coverUrl },
            body: ''
        };
    }

    return { statusCode: 404, headers: {}, body: 'Not Found' };
});

router.get('/api/yinliu/lyric', async (req) => {
    const q = getQueryParams(req);
    const title = q.title || q.name || "";
    const artist = q.artist || "";

    let filename = q.filename || "";
    if (!filename && q.path) {
        const pathParts = String(q.path).split('/');
        filename = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
    }

    const lrc = await scrapeLyric(title, artist, filename);
    return jsonResponse(lrc ? [{ lyrics: lrc }] : []);
});

router.get('/api/jiantou/cover', async (req) => {
    const q = getQueryParams(req);
    const title = q.title || q.name || "";
    const artist = q.artist || "";
    const album = q.album || "";

    const coverUrl = await fetchCover(title, artist, album);

    if (coverUrl) {
        return {
            statusCode: 302,
            headers: { 'Location': coverUrl },
            body: ''
        };
    }

    return { statusCode: 404, headers: {}, body: 'Not Found' };
});

router.get('/api/jiantou/lyric', async (req) => {
    const q = getQueryParams(req);
    const title = q.title || q.name || "";
    const artist = q.artist || "";

    let filename = q.filename || "";
    if (!filename && q.path) {
        const pathParts = String(q.path).split('/');
        filename = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
    }

    const lrc = await scrapeLyric(title, artist, filename);

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: lrc || ""
    };
});

// ==========================================
// ⏰ 后台定时保活机制（每 1 天自动打卡）
// ==========================================
function startKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);

    // 设置为每 1 天执行一次 (24小时 = 24 * 60 * 60 * 1000 毫秒)
    keepAliveTimer = setInterval(async () => {
        try {
            // 1. 获取系统级 Token 触发宿主内部续期
            const token = await songloft.plugin.getToken();

            // 2. 写入一次轻量时间戳，保持存储引擎和 Actor 激活
            if (token) {
                await songloft.storage.set('last_keep_alive', new Date().toISOString());
                songloft.log.info('[保活机制] 插件每日定时保活成功，系统 Token 状态正常');
            }
        } catch (e) {
            songloft.log.warn('[保活机制] 插件每日定时保活触发异常: ' + e);
        }
    }, 24 * 60 * 60 * 1000);
}

async function onInit(): Promise<void> {
    songloft.log.info('lyrics-cover-helper initialized');

    // 🌟 插件初始化时启动每天一次的后台保活
    startKeepAlive();
}

async function onDeinit(): Promise<void> {
    songloft.log.info('lyrics-cover-helper deinitialized');

    // 🌟 插件卸载/重载时清理计时器
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
    let logEntry = null;

    if (!req.path.startsWith('/api/debug')) {
        logEntry = logIncomingRequest(req);
    }

    const response = await router.handle(req);

    if (logEntry && response) {
        if (response.statusCode === 302 || response.statusCode === 301) {
            const loc = (response.headers as any)?.Location || (response.headers as any)?.location;
            logEntry.responseValue = `[封面跳转] ${loc}`;
        } else {
            let bodyStr = "";
            if (typeof response.body === 'object') {
                bodyStr = JSON.stringify(response.body);
            } else {
                bodyStr = String(response.body || "");
            }
            logEntry.responseValue = bodyStr.length > 120 ? bodyStr.substring(0, 120) + "..." : (bodyStr || "无返回值");
        }
    }

    return response;
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;