# models.py
# Mapping kept for compatibility with your existing front-end 'model' query param.
# You can replace assistant IDs with your own (OpenAI Assistants). Re-using a thread
# per web session dramatically reduces latency.

MARIA_MODEL = "MARIA_MODEL"
MARIA_RU_MODEL = 'MARIA_RU_MODEL'

# If you want to keep Assistants API, put your real assistant IDs here:
MODEL_MAP = {
    MARIA_MODEL: "asst_bd82EF3r58NnxLeVjgvtuNzH",
    MARIA_RU_MODEL: "asst_bd82EF3r58NnxLeVjgvtuNzH"
}

# Optional direct fast models for the Responses/Chat API (lower latency than Assistants)
# Use these model names if you switch the /api/generate-assistant-response-fast endpoint on.
FAST_MODEL_MAP = {
    MARIA_MODEL: "gpt-4.1-mini",
    MARIA_RU_MODEL: 'gpt-4.1-mini'
}
