/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter } from '@songloft/plugin-sdk';

const router = createRouter();
const requestLogs: any[] = [];
let keepAliveTimer: any = null;

// ==========================================
// ⚙️ 默认歌词源配置 (Songloft 居中)
// ==========================================
interface LyricSourceItem {
    id: 'karaoke' | 'songloft' | 'builtin';
    name: string;
    desc: string;
    enabled: boolean;
}

const DEFAULT_SOURCES: LyricSourceItem[] = [
    { id: 'karaoke', name: '逐字歌词插件 (karaoke-lyric)', desc: '优先返回逐字时间轴 (lxlyric)，无逐字时回退普通歌词', enabled: true },
    { id: 'songloft', name: 'Songloft 本地曲库歌词', desc: '检索宿主已有歌曲库并直接提取歌词', enabled: true },
    { id: 'builtin', name: '自带网络刮削 (lrc.cx / lrclib)', desc: '聚合多平台刮削并智能校验评分', enabled: true }
];

async function getStoredSources(): Promise<LyricSourceItem[]> {
    try {
        const cfg = await songloft.storage.get('lyric_sources');
        if (cfg && Array.isArray(cfg)) return cfg;
    } catch (e) {}
    return DEFAULT_SOURCES;
}

// 探测 karaoke-lyric 逐字歌词插件是否在线
async function checkKaraokePluginAlive(): Promise<boolean> {
    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const res: any = await Promise.race([
            fetch(`${hostUrl}/api/v1/jsplugin/karaoke-lyric/info`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1500))
        ]);
        return !!(res && res.ok);
    } catch (e) {
        return false;
    }
}

// ==========================================
// 🛡️ 防火墙伪装与请求头配置
// ==========================================
const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*"
};

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
// 🎵 核心过滤与文本工具函数
// ==========================================
function cleanArtist(artist: string): string {
    if (!artist) return "";
    const s = artist.trim().toLowerCase();
    if (s === "未知歌手" || s === "未知" || s === "unknown artist" || s === "unknown") {
        return "";
    }
    return artist;
}

function cleanStr(str: string): string {
    if (!str) return "";
    return String(str).replace(/\.[^/.]+$/, "").replace(/[\(（].*?[\)）]/g, '').replace(/\s+/g, '').toLowerCase().trim();
}

function parseArtists(str: string): string[] {
    const validArtist = cleanArtist(str);
    if (!validArtist) return [];
    return validArtist.split(/&|、|,|，|\/|\||和|与|feat\.|ft\./i).map(a => a.replace(/\s+/g, '').toLowerCase().trim()).filter(a => a);
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
// 🖼️ 封面刮削 (优先 Apple -> 兜底网易云走宿主原生代理)
// ==========================================
async function fetchCover(title: string, artist: string, album: string): Promise<string | null> {
    artist = cleanArtist(artist);
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
                    const token = await songloft.plugin.getToken();
                    return `/api/v1/proxy?url=${encodeURIComponent(al.picUrl)}&access_token=${token}`;
                }
            }
        }
    } catch (e) {}

    return null;
}

// ==========================================
// 🎤 歌词渠道 1: 逐字歌词插件 (karaoke-lyric)
// ==========================================
async function fetchFromKaraokePlugin(title: string, artist: string, allowVerbatim = true): Promise<string | null> {
    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const url = `${hostUrl}/api/v1/jsplugin/karaoke-lyric/open-scrape`;

        const res: any = await Promise.race([
            fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    title: title,
                    artist: artist,
                    lyrics_type: allowVerbatim ? 'verbatim' : 'line'
                })
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 4000))
        ]);

        if (res && res.ok) {
            const data = await res.json();
            if (data && data.success) {
                // 🌟 1. 允许逐字歌词（如箭头音乐）：优先返回逐字时间轴
                if (allowVerbatim && data.lxlyric && typeof data.lxlyric === 'string' && data.lxlyric.trim().length > 0) {
                    return data.lxlyric.trim();
                }

                // 🌟 2. 不支持逐字歌词（如音流）或无逐字时间轴：返回普通逐行 lyric
                if (data.lyric && typeof data.lyric === 'string' && data.lyric.trim().length > 0) {
                    return data.lyric.trim();
                }

                // 3. 兜底保护：若只收到了逐字时间轴且客户端不支持逐字，剥除内嵌时间戳转为普通逐行歌词
                if (!allowVerbatim && data.lxlyric && typeof data.lxlyric === 'string') {
                    return data.lxlyric.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, (match: string, offset: number, fullStr: string) => {
                        return (offset === 0 || fullStr[offset - 1] === '\n') ? match : '';
                    }).trim();
                }
            }
        }
    } catch (e) {}
    return null;
}

// ==========================================
// 🎤 歌词渠道 2: Songloft 本地曲库搜索
// ==========================================
async function fetchFromSongloftLocal(title: string, artist: string): Promise<string | null> {
    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        if (!hostUrl || !token) return null;

        const searchUrl = `${hostUrl}/api/v1/songs?keyword=${encodeURIComponent(title)}&limit=10`;
        const res: any = await Promise.race([
            fetch(searchUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000))
        ]);

        if (!res || !res.ok) return null;

        const data: any = await res.json();
        const list: any[] = Array.isArray(data) ? data : (data.items || data.songs || data.data || []);
        if (!list || list.length === 0) return null;

        let target = list[0];
        if (artist) {
            const cleanA = cleanStr(artist);
            const match = list.find((s: any) => cleanStr(s.artist || '').includes(cleanA));
            if (match) target = match;
        }

        if (target.lyric && typeof target.lyric === 'string' && target.lyric.trim().length > 0) {
            return target.lyric.trim();
        }

        if (target.id) {
            const lyricRes = await fetch(`${hostUrl}/api/v1/songs/${target.id}/lyric`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (lyricRes.ok) {
                const lData: any = await lyricRes.json();
                const lrc = lData.lyric || lData.lyrics;
                if (lrc && typeof lrc === 'string' && lrc.trim().length > 0) {
                    return lrc.trim();
                }
            }
        }
    } catch (e) {}
    return null;
}

// ==========================================
// 🎤 歌词渠道 3: 自带网络刮削引擎 (lrc.cx / lrclib)
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
            }
        }
    }
    return bestLrc;
}

async function scrapeLyricBuiltin(title: string, artist: string, filename: string): Promise<string | null> {
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
                    if (synced && synced.length >= 60) return synced;
                }
            } catch(e) {}
        }
    }
    return null;
}

// ==========================================
// 🎼 统一聚合调度入口
// ==========================================
async function getAggregatedLyric(title: string, artist: string, filename: string, allowVerbatim = true): Promise<string | null> {
    artist = cleanArtist(artist);
    const sources = await getStoredSources();

    for (const src of sources) {
        if (!src.enabled) continue;

        if (src.id === 'karaoke') {
            const lrc = await fetchFromKaraokePlugin(title, artist, allowVerbatim);
            if (lrc) return lrc;
        } else if (src.id === 'songloft') {
            const lrc = await fetchFromSongloftLocal(title, artist);
            if (lrc) return lrc;
        } else if (src.id === 'builtin') {
            const lrc = await scrapeLyricBuiltin(title, artist, filename);
            if (lrc) return lrc;
        }
    }
    return null;
}

// ==========================================
// 🚀 路由定义
// ==========================================
router.get('/api/token', async () => {
    try {
        const token = await songloft.plugin.getToken();
        return jsonResponse({ token });
    } catch (e) {
        return jsonResponse({ token: "" }, 500);
    }
});

// 读取与保存歌词源配置
router.get('/api/settings', async () => {
    const sources = await getStoredSources();
    const karaokeDetected = await checkKaraokePluginAlive();
    return jsonResponse({ sources, karaokeDetected });
});

router.post('/api/settings', async (req) => {
    try {
        const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const data = JSON.parse(bodyStr);
        if (data && Array.isArray(data.sources)) {
            await songloft.storage.set('lyric_sources', data.sources);
            return jsonResponse({ ok: true });
        }
    } catch (e) {}
    return jsonResponse({ ok: false }, 400);
});

router.get('/api/debug/logs', () => jsonResponse(requestLogs));
router.delete('/api/debug/logs', () => {
    requestLogs.length = 0;
    return jsonResponse({ msg: "已清空" });
});

// 🌟 音流接口：传 allowVerbatim = false，仅返回普通逐行 LRC 歌词
router.get('/api/yinliu/lyric', async (req) => {
    const q = getQueryParams(req);
    const title = q.title || q.name || "";
    const artist = q.artist || "";
    let filename = q.filename || "";
    if (!filename && q.path) {
        const pathParts = String(q.path).split('/');
        filename = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
    }

    const lrc = await getAggregatedLyric(title, artist, filename, false);
    return jsonResponse(lrc ? [{ lyrics: lrc }] : []);
});

router.get('/api/yinliu/cover', async (req) => {
    const q = getQueryParams(req);
    const coverUrl = await fetchCover(q.title || q.name || "", q.artist || "", q.album || "");
    if (coverUrl) return { statusCode: 302, headers: { 'Location': coverUrl }, body: '' };
    return { statusCode: 404, headers: {}, body: 'Not Found' };
});

// 🌟 箭头音乐接口：传 allowVerbatim = true，优先享受逐字歌词动效
router.get('/api/jiantou/lyric', async (req) => {
    const q = getQueryParams(req);
    const title = q.title || q.name || "";
    const artist = q.artist || "";
    let filename = q.filename || "";
    if (!filename && q.path) {
        const pathParts = String(q.path).split('/');
        filename = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
    }

    const lrc = await getAggregatedLyric(title, artist, filename, true);
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: lrc || ""
    };
});

router.get('/api/jiantou/cover', async (req) => {
    const q = getQueryParams(req);
    const coverUrl = await fetchCover(q.title || q.name || "", q.artist || "", q.album || "");
    if (coverUrl) return { statusCode: 302, headers: { 'Location': coverUrl }, body: '' };
    return { statusCode: 404, headers: {}, body: 'Not Found' };
});

// ==========================================
// ⏰ 后台定时保活机制
// ==========================================
function startKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(async () => {
        try {
            const token = await songloft.plugin.getToken();
            if (token) {
                await songloft.storage.set('last_keep_alive', new Date().toISOString());
                songloft.log.info('[保活机制] 每日定时保活成功，系统 Token 状态正常');
            }
        } catch (e) {
            songloft.log.warn('[保活机制] 插件每日定时保活触发异常: ' + e);
        }
    }, 24 * 60 * 60 * 1000);
}

async function onInit(): Promise<void> {
    songloft.log.info('lyrics-cover-helper initialized');
    startKeepAlive();
}

async function onDeinit(): Promise<void> {
    songloft.log.info('lyrics-cover-helper deinitialized');
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