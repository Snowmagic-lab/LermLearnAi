"""Small local bridge for StudyFlow's desktop voice mode.

This intentionally follows Athena's audio path:
  - Gemini Live native audio with the Charon voice for replies.
  - Athena's local Whisper runtime for Thai speech recognition.

The process communicates over JSON lines on stdin/stdout. Secrets are read from
the environment and are never printed.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
from pathlib import Path


# Windows may start Python with a legacy code page. The bridge protocol is
# JSON-lines and must always be UTF-8 because transcripts can contain Thai.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_whisper():
    """Load Athena's Whisper wrapper lazily so TTS does not pay its startup cost."""
    root = os.environ.get("ATHENA_ROOT", "")
    if root:
        sys.path.insert(0, root)
    try:
        from core.stt import WhisperSTT  # type: ignore
    except ModuleNotFoundError as error:
        if error.name == "faster_whisper":
            raise RuntimeError(
                "ยังไม่ได้ติดตั้ง faster-whisper ใน runtime ของ Athena "
                "จึงยังถอดเสียงในเครื่องไม่ได้"
            ) from error
        raise

    model_name = os.environ.get("ATHENA_WHISPER_MODEL", "base")
    return WhisperSTT(model_name=model_name, language="th")


async def synthesize(text: str, api_key: str) -> bytes:
    from google import genai  # type: ignore
    from google.genai import types  # type: ignore

    client = genai.Client(api_key=api_key, http_options={"api_version": "v1beta"})
    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        output_audio_transcription={},
        system_instruction=(
            "คุณคือ Athena ผู้ช่วยเสียงของ StudyFlow. "
            "อ่านข้อความที่ได้รับแล้วตอบเป็นภาษาไทยอย่างเป็นธรรมชาติ สุภาพ กระชับ "
            "ใช้คำลงท้ายแบบผู้ชาย เช่น ครับ เท่านั้น ห้ามใช้ ค่ะ หรือ คะ. "
            "ไม่เติมข้อมูลใหม่ ไม่อ่านสัญลักษณ์ Markdown และไม่พูดเหมือนข้อความแจ้งเตือนจากระบบ."
        ),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Charon")
            )
        ),
    )
    audio = bytearray()
    async with client.aio.live.connect(model=MODEL, config=config) as session:
        await session.send_client_content(
            turns={"parts": [{"text": text}]}, turn_complete=True
        )
        async for response in session.receive():
            if response.data:
                audio.extend(response.data)
            if response.server_content and response.server_content.turn_complete:
                break
    return bytes(audio)


async def handle(request: dict) -> None:
    request_id = request.get("id")
    action = request.get("action")
    try:
        if action == "speak":
            api_key = os.environ.get("STUDYFLOW_GEMINI_VOICE_API_KEY", "").strip()
            if not api_key:
                raise RuntimeError("ยังไม่ได้ตั้งค่า Gemini API key สำหรับเสียง Athena")
            text = str(request.get("text", "")).strip()
            if not text:
                raise RuntimeError("ไม่มีข้อความสำหรับอ่านออกเสียง")
            audio = await synthesize(text[:900], api_key)
            emit(
                {
                    "id": request_id,
                    "ok": True,
                    "type": "audio",
                    "sampleRate": 24000,
                    "pcm16": base64.b64encode(audio).decode("ascii"),
                }
            )
            return

        if action == "transcribe":
            raw = base64.b64decode(str(request.get("pcm16", "")))
            if not raw:
                raise RuntimeError("ไม่มีเสียงที่บันทึกได้")
            import numpy as np  # type: ignore

            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            text = load_whisper().transcribe(samples)
            emit({"id": request_id, "ok": True, "type": "transcript", "text": text})
            return

        raise RuntimeError("ไม่รู้จักคำสั่ง voice bridge")
    except Exception as error:  # the desktop client turns this into a visible status
        emit({"id": request_id, "ok": False, "error": str(error)[:500]})


async def main() -> None:
    emit({"type": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            await handle(request)
        except Exception as error:
            emit({"id": None, "ok": False, "error": str(error)[:500]})


if __name__ == "__main__":
    asyncio.run(main())
