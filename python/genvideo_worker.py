#!/usr/bin/env python3
"""
RU: Воркер diffusers для плагина GenVideo. Читает JSON-запрос, собирает
    LTX-Video pipeline (text-to-video или image-to-video), генерирует кадры и
    сохраняет mp4. Строки прогресса `GENVIDEO {json}` пишутся в stdout, весь
    остальной вывод идёт только в stderr.
EN: Diffusers worker for the GenVideo plugin. Reads a JSON request, builds an
    LTX-Video pipeline (text-to-video or image-to-video), generates frames and
    saves an mp4. Progress lines `GENVIDEO {json}` go to stdout; every other
    message goes to stderr.
"""

import inspect
import json
import os
import sys
import traceback
from typing import Any, NoReturn, Sequence

PROTOCOL_PREFIX = "GENVIDEO "
SAMPLE_PERCENT_START = 10
SAMPLE_PERCENT_END = 70
DEFAULT_STEPS = 8
DEFAULT_GUIDANCE = 1.0
DEFAULT_FPS = 24
EXIT_OK = 0
EXIT_ERROR = 1
EXIT_IMPORT = 2
EXIT_CUDA_OOM = 3

REQUIRED_REQUEST_KEYS = (
    "modelId",
    "repo",
    "baseRepo",
    "weights",
    "modelDir",
    "prompt",
    "negativePrompt",
    "width",
    "height",
    "frames",
    "fps",
    "steps",
    "guidance",
    "seed",
    "image",
    "output",
)

USAGE = (
    "usage: python genvideo_worker.py --request /absolute/path/to/request.json\n"
    "RU: воркер GenVideo; прогресс выводится строками `GENVIDEO {json}` в stdout.\n"
    "EN: GenVideo worker; progress is printed as `GENVIDEO {json}` lines on stdout."
)


def emit(payload: dict[str, Any]) -> None:
    """RU: Печатает одну строку протокола `GENVIDEO {json}` в stdout.
    EN: Prints a single `GENVIDEO {json}` protocol line to stdout.
    """
    line = PROTOCOL_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    print(line, file=sys.stdout, flush=True)


def log(message: str) -> None:
    """RU: Пишет диагностическое сообщение в stderr, не засоряя stdout.
    EN: Writes a diagnostic message to stderr without polluting stdout.
    """
    print(message, file=sys.stderr, flush=True)


def usage_error(reason: str | None = None) -> NoReturn:
    """RU: Печатает причину и usage в stderr, затем завершает процесс с кодом 1.
    EN: Prints the reason and usage to stderr, then exits with code 1.
    """
    if reason:
        log(f"GenVideo worker: {reason}")
    log(USAGE)
    raise SystemExit(EXIT_ERROR)


def parse_args(argv: Sequence[str]) -> str:
    """RU: Разбирает только `--request PATH` (и `--request=PATH`), без argparse,
    чтобы при ошибке отдать код 1 и usage в stderr, а не код 2.
    EN: Parses only `--request PATH` (and `--request=PATH`) without argparse,
    so a mistake exits with code 1 and usage on stderr instead of code 2.
    """
    request_path: str | None = None
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == "--request":
            if index + 1 >= len(argv):
                usage_error("--request requires a path")
            candidate = argv[index + 1]
            if not candidate:
                usage_error("--request requires a non-empty path")
            if request_path is not None:
                usage_error("--request was provided more than once")
            request_path = candidate
            index += 2
        elif argument.startswith("--request="):
            candidate = argument.split("=", 1)[1]
            if not candidate:
                usage_error("--request requires a non-empty path")
            if request_path is not None:
                usage_error("--request was provided more than once")
            request_path = candidate
            index += 1
        else:
            usage_error(f"unknown argument: {argument}")
    if not request_path:
        usage_error("--request is required")
    return os.path.abspath(request_path)


def load_request(path: str) -> dict[str, Any]:
    """RU: Читает JSON-запрос с диска и проверяет обязательные поля.
    EN: Reads the JSON request from disk and validates the required fields.
    """
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("the request JSON root must be an object")
    missing = [key for key in REQUIRED_REQUEST_KEYS if key not in payload]
    if missing:
        raise ValueError(f"the request is missing required keys: {', '.join(missing)}")
    if not isinstance(payload.get("modelDir"), str) or not payload["modelDir"]:
        raise ValueError("`modelDir` must be a non-empty directory path")
    if not isinstance(payload.get("output"), str) or not payload["output"]:
        raise ValueError("`output` must be a non-empty file path")
    if not isinstance(payload.get("prompt"), str):
        raise ValueError("`prompt` must be a string")
    if not isinstance(payload.get("negativePrompt"), str):
        raise ValueError("`negativePrompt` must be a string")
    if not isinstance(payload.get("weights"), list):
        raise ValueError("`weights` must be a list of file names")
    image = payload.get("image")
    if image is not None and not isinstance(image, str):
        raise ValueError("`image` must be an absolute path or null")
    return payload


def pick_dtype(torch_module: Any) -> tuple[Any, str]:
    """RU: Выбирает bfloat16 и CUDA при доступной видеокарте, иначе float32 и CPU.
    EN: Picks bfloat16 with CUDA when a GPU is available, otherwise float32 on CPU.
    """
    if torch_module.cuda.is_available():
        return torch_module.bfloat16, "cuda"
    return torch_module.float32, "cpu"


def resolve_pipeline_class(diffusers_module: Any, image_to_video: bool) -> Any:
    """RU: Импортирует нужный LTX-класс; при отсутствии откатывается на
    `diffusers.DiffusionPipeline`, который сам выберет класс из model_index.json.
    EN: Imports the needed LTX class; when it is missing, falls back to
    `diffusers.DiffusionPipeline`, which picks the class from model_index.json.
    """
    try:
        if image_to_video:
            from diffusers import LTXImageToVideoPipeline as pipeline_class
        else:
            from diffusers import LTXPipeline as pipeline_class
        return pipeline_class
    except Exception as exc:
        log(
            "WARNING: the LTX pipeline class is unavailable "
            f"({type(exc).__name__}: {exc}); falling back to DiffusionPipeline"
        )
        return diffusers_module.DiffusionPipeline


def resolve_transformer_class(diffusers_module: Any) -> Any:
    """RU: Импортирует `LTXVideoTransformer3DModel` для single-file весов.
    EN: Imports `LTXVideoTransformer3DModel` for single-file weights.
    """
    try:
        from diffusers import LTXVideoTransformer3DModel

        return LTXVideoTransformer3DModel
    except Exception as exc:
        log(
            "WARNING: LTXVideoTransformer3DModel is unavailable "
            f"({type(exc).__name__}: {exc}); single-file weights cannot be applied"
        )
        return None


def find_single_file_weight(model_dir: str, weights: Sequence[str]) -> str | None:
    """RU: Находит `.safetensors` из списка weights или в корне modelDir.
    EN: Finds a `.safetensors` from the weights list or in the modelDir root.
    """
    candidates: list[str] = []
    for name in weights:
        if not isinstance(name, str) or not name.lower().endswith(".safetensors"):
            continue
        # RU: Имена в запросе — файлы внутри modelDir, поэтому путь отбрасываем.
        # EN: Request names are files inside modelDir, so discard any directory part.
        candidate = os.path.join(model_dir, os.path.basename(name))
        if os.path.isfile(candidate):
            candidates.append(candidate)
    if not candidates:
        try:
            names = sorted(os.listdir(model_dir))
        except OSError:
            names = []
        for name in names:
            candidate = os.path.join(model_dir, name)
            if name.lower().endswith(".safetensors") and os.path.isfile(candidate):
                candidates.append(candidate)
    candidates = list(dict.fromkeys(candidates))
    if not candidates:
        return None
    if len(candidates) > 1:
        log(f"WARNING: multiple .safetensors weights found; using {candidates[0]}")
    return candidates[0]


def build_pipeline(request: dict[str, Any], diffusers_module: Any, dtype: Any) -> Any:
    """RU: Загружает пайплайн: готовую diffusers-папку из modelDir либо
    эталонный baseRepo с последующей подменой трансформера single-file весами.
    EN: Loads the pipeline: a ready diffusers folder from modelDir, or the
    reference baseRepo followed by swapping the transformer to single-file weights.
    """
    model_dir = os.path.abspath(os.fspath(request["modelDir"]))
    image_to_video = bool(request.get("image"))
    pipeline_class = resolve_pipeline_class(diffusers_module, image_to_video)
    model_index = os.path.join(model_dir, "model_index.json")
    has_model_index = os.path.isfile(model_index)

    if has_model_index:
        source = model_dir
        log(f"GenVideo worker: loading the diffusers pipeline from {source}")
    else:
        source = str(request.get("baseRepo") or request.get("repo") or "")
        if not source:
            raise ValueError("`baseRepo` is required when modelDir has no model_index.json")
        log(
            "GenVideo worker: modelDir has no model_index.json; "
            f"loading the reference pipeline {source}"
        )

    pipe = pipeline_class.from_pretrained(source, torch_dtype=dtype)
    if has_model_index:
        return pipe

    weight_path = find_single_file_weight(model_dir, request.get("weights") or [])
    if not weight_path:
        log(
            "GenVideo worker: no single-file .safetensors weight found; "
            "using the reference transformer"
        )
        return pipe

    transformer_class = resolve_transformer_class(diffusers_module)
    if transformer_class is None:
        return pipe

    log(f"GenVideo worker: applying single-file transformer weights from {weight_path}")
    try:
        pipe.transformer = transformer_class.from_single_file(weight_path, torch_dtype=dtype)
    except Exception as exc:
        log(
            "WARNING: failed to load the single-file transformer "
            f"({type(exc).__name__}: {exc}); continuing with the base pipeline"
        )
    return pipe


def configure_pipeline(pipe: Any, device: str) -> bool:
    """RU: Включает VAE slicing и (на CUDA) model CPU offload; возвращает True,
    если offload реально включён — от этого зависит устройство генератора.
    EN: Enables VAE slicing and, on CUDA, model CPU offload; returns True when
    offload is active because the generator device depends on it.
    """
    if hasattr(pipe, "enable_vae_slicing"):
        try:
            pipe.enable_vae_slicing()
        except Exception as exc:
            log(f"WARNING: enable_vae_slicing failed ({type(exc).__name__}: {exc})")

    # RU: Свой прогресс шлём через callback, поэтому tqdm диффьюзеров выключаем.
    # EN: Our progress goes through the callback, so disable diffusers' tqdm.
    if hasattr(pipe, "set_progress_bar_config"):
        try:
            pipe.set_progress_bar_config(disable=True)
        except Exception:
            pass

    offloaded = False
    if device == "cuda":
        if hasattr(pipe, "enable_model_cpu_offload"):
            try:
                pipe.enable_model_cpu_offload()
                offloaded = True
            except Exception as exc:
                log(
                    "WARNING: enable_model_cpu_offload failed "
                    f"({type(exc).__name__}: {exc})"
                )
        if not offloaded:
            # RU: Без offload пайплайн нужно явно перенести на видеокарту.
            # EN: Without offload the pipeline must be moved to the GPU explicitly.
            try:
                pipe.to(device)
            except Exception as exc:
                log(f"WARNING: could not move the pipeline to {device} ({type(exc).__name__}: {exc})")
    return offloaded


def supports_step_callback(pipe: Any) -> bool:
    """RU: Проверяет, принимает ли pipeline `callback_on_step_end`.
    EN: Checks whether the pipeline accepts `callback_on_step_end`.
    """
    try:
        parameters = inspect.signature(pipe.__call__).parameters
    except (TypeError, ValueError):
        return False
    return "callback_on_step_end" in parameters


def sampling_percent(step: int, total: int) -> int:
    """RU: Переводит номер шага в проценты 10..70 для фазы sampling.
    EN: Maps a step number to the 10..70 percent range of the sampling phase.
    """
    if total <= 0:
        return SAMPLE_PERCENT_START
    bounded = min(max(step, 0), total)
    span = SAMPLE_PERCENT_END - SAMPLE_PERCENT_START
    return int(round(SAMPLE_PERCENT_START + span * bounded / total))


def make_step_callback(total_steps: int) -> Any:
    """RU: Создаёт callback диффьюзеров, печатающий прогресс на каждом шаге.
    EN: Creates the diffusers callback that prints progress after every step.
    """

    def callback_on_step_end(
        pipeline: Any,
        step_index: int,
        timestep: Any,
        callback_kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        """RU: Печатает строку sampling и возвращает тензоры без изменений.
        EN: Prints the sampling line and returns the tensors unchanged.
        """
        step = int(step_index) + 1
        emit(
            {
                "phase": "sampling",
                "percent": sampling_percent(step, total_steps),
                "step": step,
                "total": total_steps,
            }
        )
        return callback_kwargs

    return callback_on_step_end


def load_input_image(path: str) -> Any:
    """RU: Загружает картинку для image-to-video и приводит её к RGB.
    EN: Loads the image for image-to-video and converts it to RGB.
    """
    from PIL import Image

    with Image.open(path) as image:
        return image.convert("RGB")


def extract_frames(result: Any) -> Any:
    """RU: Достаёт первое видео из результата pipeline (батч `frames`).
    EN: Extracts the first video from the pipeline result (a `frames` batch).
    """
    # RU: LTX кладёт в result.frames батч видео; для файла нужно первое.
    # EN: LTX puts a batch of videos into result.frames; a file needs the first.
    frames = getattr(result, "frames", result)
    try:
        return frames[0]
    except (IndexError, KeyError, TypeError):
        return frames


def export_video(frames: Any, output_path: str, fps: int) -> None:
    """RU: Кодирует кадры в mp4 через `diffusers.utils.export_to_video`.
    EN: Encodes the frames into an mp4 via `diffusers.utils.export_to_video`.
    """
    from diffusers.utils import export_to_video as diffusers_export_to_video

    diffusers_export_to_video(frames, output_path, fps=fps)


def is_cuda_oom(torch_module: Any, error: BaseException) -> bool:
    """RU: Определяет ошибку CUDA out of memory, не требуя её класса в старых torch.
    EN: Detects CUDA out of memory without requiring that class in older torch builds.
    """
    oom_class = getattr(getattr(torch_module, "cuda", None), "OutOfMemoryError", None)
    return oom_class is not None and isinstance(error, oom_class)


def main(argv: Sequence[str] | None = None) -> int:
    """RU: Точка входа: разбирает запрос, лениво импортирует torch/diffusers,
    генерирует видео и сообщает прогресс; возвращает код выхода процесса.
    EN: Entry point: parses the request, lazily imports torch/diffusers,
    generates the video and reports progress; returns the process exit code.
    """
    arguments = list(sys.argv[1:] if argv is None else argv)
    request_path = parse_args(arguments)

    try:
        request = load_request(request_path)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return EXIT_ERROR

    # RU: Тяжёлые библиотеки импортируются только внутри main, чтобы ошибки
    #     установки давали понятный код 2, а не падение на импорте модуля.
    # EN: Heavy libraries are imported inside main only, so installation
    #     problems yield a clear exit code 2 instead of a module import crash.
    try:
        import torch
        import diffusers
    except Exception as exc:
        log("GenVideo worker: failed to import torch and diffusers.")
        log(f"  {type(exc).__name__}: {exc}")
        log("  Install the Python engine from GenVideo Settings -> Python & engines.")
        log(
            "  Manual install: "
            f"{sys.executable} -m pip install -r <package>/python/requirements.txt"
        )
        return EXIT_IMPORT

    emit({"phase": "loading_model", "percent": 3})

    try:
        dtype, device = pick_dtype(torch)
        log(f"GenVideo worker: device={device}, dtype={dtype}")

        pipe = build_pipeline(request, diffusers, dtype)
        offloaded = configure_pipeline(pipe, device)

        steps = int(request.get("steps") or 0)
        if steps <= 0:
            steps = DEFAULT_STEPS
        guidance = float(request.get("guidance") or 0.0)
        if guidance <= 0:
            guidance = DEFAULT_GUIDANCE
        width = int(request["width"])
        height = int(request["height"])
        frame_count = int(request["frames"])
        fps = int(request.get("fps") or DEFAULT_FPS)
        if fps <= 0:
            fps = DEFAULT_FPS
        seed = int(request.get("seed") or 0)

        # RU: LTX требует размеры, кратные 32; предупреждаем, не меняя запрос.
        # EN: LTX requires dimensions divisible by 32; warn without altering the request.
        if width % 32 or height % 32:
            log(
                "WARNING: LTX expects width and height divisible by 32; "
                f"the pipeline may reject {width}x{height}"
            )

        # RU: При cpu offload генератор должен жить на CPU, иначе некоторые
        #     пайплайны падают при переносе модулей между устройствами.
        # EN: With cpu offload the generator must live on CPU, otherwise some
        #     pipelines fail while moving modules between devices.
        generator_device = "cpu" if offloaded else device
        generator = torch.Generator(device=generator_device).manual_seed(seed)

        call_kwargs: dict[str, Any] = {
            "prompt": request["prompt"],
            "negative_prompt": request.get("negativePrompt", ""),
            "width": width,
            "height": height,
            "num_frames": frame_count,
            "num_inference_steps": steps,
            "guidance_scale": guidance,
            "generator": generator,
            "output_type": "np",
        }
        image_path = request.get("image") or None
        if image_path:
            call_kwargs["image"] = load_input_image(str(image_path))

        if supports_step_callback(pipe):
            call_kwargs["callback_on_step_end"] = make_step_callback(steps)
        else:
            log(
                "GenVideo worker: callback_on_step_end is unavailable; "
                "emitting a single sampling progress line"
            )
            emit(
                {
                    "phase": "sampling",
                    "percent": SAMPLE_PERCENT_START,
                    "step": 0,
                    "total": steps,
                }
            )

        result = pipe(**call_kwargs)

        emit({"phase": "decoding", "percent": 82})
        frames = extract_frames(result)
        output_path = os.path.abspath(os.fspath(request["output"]))
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

        emit({"phase": "muxing", "percent": 92})
        export_video(frames, output_path, fps)

        if not os.path.isfile(output_path) or os.path.getsize(output_path) <= 0:
            raise RuntimeError(f"export_to_video produced no output at {output_path}")

        emit({"phase": "done", "percent": 100})
        log(f"GenVideo worker: wrote {output_path}")
        return EXIT_OK
    except Exception as exc:
        if is_cuda_oom(torch, exc):
            log("GenVideo worker: CUDA out of memory while generating the video.")
            log("  Try a smaller width/height or fewer frames, close other GPU apps,")
            log("  or use the CPU runner with enough RAM.")
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
            return EXIT_CUDA_OOM
        traceback.print_exc(file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
