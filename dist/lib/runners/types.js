/** RU: Успешная доступность. EN: Available result. */
export function available() {
    return { available: true, reason: null, hint: null };
}
/** RU: Недоступность с подсказкой. EN: Unavailable with a hint. */
export function unavailable(reason, hint) {
    return { available: false, reason, hint };
}
