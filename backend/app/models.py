# models.py
# Mapping kept for compatibility with your existing front-end 'model' query param.
# You can replace assistant IDs with your own (OpenAI Assistants). Re-using a thread
# per web session dramatically reduces latency.

MARIA_MODEL = "MARIA_MODEL"
VASILISA_MODEL = "VASILISA_MODEL"
NICK_MODEL = "NICK_MODEL"
JOHN_PULSE_MODEL = "JOHN_PULSE_MODEL"

# If you want to keep Assistants API, put your real assistant IDs here:
MODEL_MAP = {
    MARIA_MODEL: "asst_bd82EF3r58NnxLeVjgvtuNzH",
    VASILISA_MODEL: "asst_mppxueCRXMUrWypqNLxpuaUl",
    NICK_MODEL: "asst_JGeiHh0VoHIqztctnlYjbYGy",
    JOHN_PULSE_MODEL: "asst_l38cTaee6TYxdIMF9vU62tiF",
}

# Optional direct fast models for the Responses/Chat API (lower latency than Assistants)
# Use these model names if you switch the /api/generate-assistant-response-fast endpoint on.
FAST_MODEL_MAP = {
    MARIA_MODEL: "gpt-4.1-mini",
    VASILISA_MODEL: "gpt-4.1-mini",
    NICK_MODEL: "gpt-4o-mini",
    JOHN_PULSE_MODEL: "gpt-4o-mini",
}
