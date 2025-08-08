import asyncio
import re
from fastapi import HTTPException

# Как в твоей прошлой версии
pattern = r"【\d+:\d+†source】"

async def stream_generator(streamManager):
    try:
        async with streamManager as stream:
            async for event in stream:
                if event.event == "thread.message.delta":
                    for d in event.data.delta.content:
                        yield re.sub(pattern, "", d.text.value).replace("*", "")

        # Явно завершаем поток
        yield "__END_OF_STREAM__"
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Stream timed out")
