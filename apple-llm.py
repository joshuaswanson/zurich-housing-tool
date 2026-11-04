# /// script
# requires-python = ">=3.10"
# dependencies = ["apple-fm-sdk"]
# ///
"""
Drafts text with the on-device Apple Intelligence model.
Reads the prompt from stdin and writes the reply to stdout.
Usage: uv run --script apple-llm.py
"""
import asyncio
import sys

import apple_fm_sdk as fm


async def respond(prompt):
    available, reason = fm.SystemLanguageModel().is_available()
    if not available:
        sys.exit(f"Apple Intelligence is not available on this Mac ({reason}).")
    session = fm.LanguageModelSession()
    try:
        return await session.respond(prompt)
    except fm.ExceededContextWindowSizeError:
        sys.exit("The listing is too long for the Apple Intelligence model.")
    except (fm.GuardrailViolationError, fm.RefusalError):
        sys.exit("The Apple Intelligence model declined to write this message.")


print(asyncio.run(respond(sys.stdin.read())))
