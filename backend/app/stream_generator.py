import asyncio
import re
import logging

# убираем источники вида 
SRC_PATTERN = re.compile(r"【\d+:\d+†source】")
log = logging.getLogger("sse")

def _clean(s: str) -> str:
    try:
        return SRC_PATTERN.sub("", s or "").replace("*", "")
    except Exception:
        return s or ""

async def stream_generator(streamManager):
    """
    Надёжный генератор SSE для Assistants Streams (и частично Responses Streams).
    - Не пробрасывает исключения наружу (чтобы не рвать соединение).
    - Поддерживает thread.message.delta и thread.message.completed.
    - На всякий случай понимает response.output_text.delta (Responses API).
    - Всегда отправляет "__END_OF_STREAM__" в конце.
    """
    # Стартовый "пинок", чтобы curl сразу увидел первый чанк
    yield ""  # превратится в 'data: \n\n'

    any_payload = False
    try:
        async with streamManager as stream:
            async for event in stream:
                try:
                    et = getattr(event, "event", "") or ""
                    data = getattr(event, "data", None)

                    # 1) Основной путь: Assistants → дельты сообщений
                    if et == "thread.message.delta" and data and getattr(data, "delta", None):
                        content = getattr(data.delta, "content", None) or []
                        for c in content:
                            ctype = getattr(c, "type", "") or getattr(c, "kind", "")
                            if ctype in ("output_text", "text"):
                                txt = getattr(getattr(c, "text", None), "value", "") or getattr(c, "text", "")
                                if txt:
                                    any_payload = True
                                    yield _clean(txt)

                    # 2) Если пришло сразу готовое сообщение
                    elif et == "thread.message.completed" and data and getattr(data, "message", None):
                        content = getattr(data.message, "content", None) or []
                        for c in content:
                            ctype = getattr(c, "type", "") or getattr(c, "kind", "")
                            if ctype in ("output_text", "text"):
                                txt = getattr(getattr(c, "text", None), "value", "") or getattr(c, "text", "")
                                if txt:
                                    any_payload = True
                                    yield _clean(txt)

                    # 3) Поддержка Responses API (на всякий случай)
                    elif et in ("response.output_text.delta", "output_text.delta") and data:
                        delta = getattr(data, "delta", "")
                        if isinstance(delta, str) and delta:
                            any_payload = True
                            yield _clean(delta)

                    # Остальные события игнорируем

                except Exception as ie:
                    # Логируем, но поток не рвём
                    log.debug("SSE inner event error: %r", ie)

    except asyncio.TimeoutError:
        log.warning("SSE timeout")
    except Exception as e:
        log.error("SSE outer error: %r", e)

    # Завершение потока — всегда
    try:
        yield "__END_OF_STREAM__"
    except Exception:
        pass
