import { mockRunner } from './mock.js';
import { candleRunner } from './candle.js';
import { commandRunner } from './command.js';
import { comfyuiRunner } from './comfyui.js';
import { diffusersRunner } from './diffusers.js';
/** RU: Все раннеры. EN: All runners. */
export const RUNNERS = [comfyuiRunner, candleRunner, diffusersRunner, commandRunner, mockRunner];
/** RU: Карта по id. EN: Map by id. */
const BY_ID = new Map(RUNNERS.map((runner) => [runner.id, runner]));
/** RU: Раннер по id. EN: Runner by id. */
export function getRunner(id) {
    return BY_ID.get(id) ?? mockRunner;
}
/** RU: Контекст проверки. EN: Availability context. */
export function availabilityInput(input) {
    return input;
}
/** RU: Проверяет конкретный раннер. EN: Checks a concrete runner. */
export function checkRunner(id, input) {
    return getRunner(id).availability(input);
}
/** RU: Доступность всех раннеров для модели. EN: Availability of every runner for a model. */
export function allAvailability(input) {
    return RUNNERS.map((runner) => ({ id: runner.id, ...runner.availability(input) }));
}
/** RU: Выбирает раннер: явный → порядок модели → mock (только если разрешён).
 *  EN: Picks a runner: explicit → model order → mock (only when allowed). */
export function pickRunner(input) {
    const context = availabilityInput(input);
    if (input.preferred) {
        const runner = getRunner(input.preferred);
        return { runner, availability: runner.availability(context) };
    }
    for (const id of input.model.runtimes) {
        const runner = getRunner(id);
        const availability = runner.availability(context);
        if (availability.available)
            return { runner, availability };
    }
    return null;
}
