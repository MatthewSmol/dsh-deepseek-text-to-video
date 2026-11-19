const LTX_PROFILE = {
    id: 'ltx-2b-distilled',
    minWords: 80,
    recommendedWords: [110, 220],
    maxChars: 4000,
    requiredFacets: [
        'subject and appearance',
        'wardrobe and small details',
        'location, weather and time of day',
        'lighting direction and color',
        'camera framing, lens and movement',
        'one clear action',
        'style and texture',
        'continuity with the previous frame',
    ],
    negativeHints: ['deformed limbs', 'extra fingers', 'text', 'watermark', 'flicker', 'morphing artifacts'],
    segmentDirective: 'Describe one clear action, keep the same subject, wardrobe, location and light, and continue from the previous frame.',
    example: 'A red fox trots through a snowy pine forest at sunrise, its thick winter coat catching the low golden light. Slow tracking shot at eye level, 35mm lens, shallow depth of field; snow sprays softly under each paw while breath steams in the cold air. Warm rim light, cool blue shadows, crisp fur detail, cinematic film grain. Continue the same fox, forest and sunrise from the previous frame, now moving three steps forward and turning its head toward the camera.',
};
/** RU: Профиль для модели и режима. EN: Profile for a model and mode. */
export function resolvePromptProfile(model, mode) {
    if (model.family === 'ltx-video' || model.family === 'ltx-2') {
        const id = model.family === 'ltx-2' ? 'ltx-2' : 'ltx-2b-distilled';
        return {
            ...LTX_PROFILE,
            id,
            maxChars: Math.max(500, model.maxPromptChars),
            segmentDirective: mode === 'v2v'
                ? 'Describe only the target style and changes; preserve the source motion, composition and timing. Do not invent a new scene.'
                : mode === 'i2v'
                    ? 'Describe what starts moving and how; keep the identity and look of the reference image. Do not re-describe the whole character from scratch.'
                    : LTX_PROFILE.segmentDirective,
        };
    }
    return {
        id: 'generic',
        minWords: 20,
        recommendedWords: [30, 100],
        maxChars: Math.max(300, model.maxPromptChars),
        requiredFacets: ['subject', 'setting', 'action', 'camera', 'style'],
        negativeHints: ['artifacts', 'text', 'watermark'],
        segmentDirective: 'Describe the shot clearly and keep continuity with the previous clip.',
        example: 'A subject moves through a clearly described location, with a specific action, camera framing and lighting.',
    };
}
/** RU: Статистика промпта. EN: Prompt statistics. */
export function promptStats(prompt) {
    const text = String(prompt ?? '').trim();
    return { words: text ? text.split(/\s+/u).length : 0, chars: text.length };
}
/** RU: Похожесть по Jaccard. EN: Jaccard similarity. */
export function promptSimilarity(a, b) {
    const words = (value) => new Set(String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const left = words(a);
    const right = words(b);
    if (!left.size || !right.size)
        return 0;
    let intersection = 0;
    for (const word of left)
        if (right.has(word))
            intersection += 1;
    return intersection / (left.size + right.size - intersection);
}
