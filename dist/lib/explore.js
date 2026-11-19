import { hfGetJson } from './downloads.js';
/** RU: Семейство текстового энкодера по имени и тегам (эвристика).
 *  EN: Text-encoder family from name and tags (heuristic). */
export function encoderName(id, tags) {
    const text = `${id} ${tags.join(' ')}`.toLowerCase();
    if (text.includes('ltx-video') || text.includes('ltx-2'))
        return 'T5-XXL';
    if (text.includes('wan2') || text.includes('wan-ai'))
        return 'umT5-XXL';
    if (text.includes('cogvideo'))
        return 'T5-XXL';
    if (text.includes('hunyuanvideo'))
        return 'Llama/CLIP';
    return null;
}
/** RU: Разбирает «14B», «1.3B» из имени репозитория.
 *  EN: Parses "14B", "1.3B" from the repository name. */
export function parseParamsB(id) {
    const matches = [...id.matchAll(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z0-9])/g)];
    if (!matches.length)
        return null;
    const value = Number(matches[0]?.[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
}
/** RU: Байт на параметр с учётом квантования. EN: Bytes per parameter including quantisation. */
export function bytesPerParam(id, tags) {
    const lower = `${id} ${tags.join(' ')}`.toLowerCase();
    if (lower.includes('gguf') || /\bq[2-8]_/.test(lower) || lower.includes('quant'))
        return 0.55;
    if (lower.includes('fp8'))
        return 1;
    return 2;
}
/** RU: Оценка VRAM в ГБ: веса + 25% на активации/оверхед.
 *  EN: VRAM estimate in GB: weights + 25% for activations/overhead. */
export function estimateVramGB(paramsB, bpp) {
    if (!paramsB || paramsB <= 0)
        return null;
    return Math.round(paramsB * bpp * 1.25 * 10) / 10;
}
/** RU: Помещается ли оценка VRAM в заданный лимит.
 *  EN: Whether the VRAM estimate fits the given limit. */
export function fitsVram(vramGB, limitGB) {
    return vramGB !== null && vramGB > 0 && vramGB <= limitGB;
}
/** RU: Эвристические признаки качества. EN: Heuristic quality signals. */
export function qualityReasons(input) {
    const reasons = new Set();
    const tags = input.tags.map((tag) => tag.toLowerCase());
    const author = input.id.split('/')[0]?.toLowerCase() ?? '';
    if (['wan-ai', 'lightricks', 'sulphurai', 'alibaba-pai'].includes(author))
        reasons.add('official');
    if (input.downloads >= 100_000)
        reasons.add('popular');
    else if (input.downloads >= 10_000)
        reasons.add('known');
    if (tags.includes('gguf') || tags.some((tag) => tag.startsWith('base_model:quantized')))
        reasons.add('quantized');
    if (tags.some((tag) => tag.includes('distill')))
        reasons.add('distilled');
    if (tags.includes('i2v') || tags.includes('ti2v') || tags.some((tag) => tag.includes('image-to-video')))
        reasons.add('image-to-video');
    if (input.paramsB !== null) {
        if (input.paramsB < 1.5)
            reasons.add('light');
        else if (input.paramsB <= 8)
            reasons.add('balanced');
        else
            reasons.add('large');
    }
    return [...reasons];
}
/** RU: Сортировка: сначала известный VRAM по возрастанию, затем популярность.
 *  EN: Sort: known VRAM ascending first, then popularity. */
export function sortByVram(items) {
    return [...items].sort((a, b) => {
        if (a.vramGB !== null && b.vramGB !== null && a.vramGB !== b.vramGB)
            return a.vramGB - b.vramGB;
        if (a.vramGB === null && b.vramGB !== null)
            return 1;
        if (a.vramGB !== null && b.vramGB === null)
            return -1;
        return b.downloads - a.downloads;
    });
}
/** RU: Преобразует ответ HF API в строку обзора. EN: Maps an HF API row into an overview row. */
export function toExploreModel(raw) {
    const id = String(raw.id ?? '');
    const tags = Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag)) : [];
    const paramsB = parseParamsB(id);
    const bpp = bytesPerParam(id, tags);
    return {
        id,
        author: id.split('/')[0] ?? '',
        downloads: Number(raw.downloads ?? 0) || 0,
        likes: Number(raw.likes ?? 0) || 0,
        lastModified: String(raw.lastModified ?? ''),
        library: raw.library_name ? String(raw.library_name) : null,
        tags,
        paramsB,
        vramGB: estimateVramGB(paramsB, bpp),
        reasons: qualityReasons({ id, tags, downloads: Number(raw.downloads ?? 0) || 0, paramsB }),
        encoder: encoderName(id, tags),
    };
}
let cache = null;
/** RU: Загружает популярные text-to-video модели и отдаёт страницу по 10.
 *  EN: Loads popular text-to-video models and returns a page of 10. */
export async function fetchExploreModels(input) {
    const pageSize = Math.max(1, Math.min(50, input.pageSize ?? 10));
    const page = Math.max(1, Math.trunc(input.page) || 1);
    if (!cache || Date.now() - cache.at > 300_000) {
        const url = 'https://huggingface.co/api/models?pipeline_tag=text-to-video&sort=downloads&direction=-1&limit=60';
        const raw = (await hfGetJson(url, input.token, input.proxy));
        const items = sortByVram(raw.filter((item) => item && item.id).map(toExploreModel));
        cache = { at: Date.now(), items };
    }
    const start = (page - 1) * pageSize;
    const items = cache.items.slice(start, start + pageSize);
    return {
        items,
        page,
        pageSize,
        total: cache.items.length,
        hasMore: start + pageSize < cache.items.length,
    };
}
