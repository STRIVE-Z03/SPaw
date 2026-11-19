"""Authenticated, bounded audio cache with online and offline speech engines."""

from pathlib import Path
import asyncio, hashlib, os, shutil, subprocess, threading, time, uuid

_limit = threading.BoundedSemaphore(2)
_lock = threading.Lock()
_online_retry_at = {}
LOCALES = {
    "zh": "zh-CN",
    "zh-cn": "zh-CN",
    "en": "en-GB",
    "en-gb": "en-GB",
    "en-us": "en-US",
}
VOICES = {
    "zh-CN": "zh-CN-XiaoxiaoNeural",
    "en-GB": "en-GB-SoniaNeural",
    "en-US": "en-US-JennyNeural",
}


def validate(text, language):
    if (
        not isinstance(text, str)
        or not text.strip()
        or len(text) > 120
        or any(ord(c) < 32 and not c.isspace() for c in text)
    ):
        raise ValueError("朗读内容应为 1 到 120 个字的词语或短句")
    if (
        not isinstance(language, str)
        or language.lower().replace("_", "-") not in LOCALES
    ):
        raise ValueError("请选择普通话、英式英语或美式英语读音")
    return " ".join(text.split()), LOCALES[language.lower().replace("_", "-")]


def prune(folder):
    files = sorted(
        (
            p
            for p in folder.iterdir()
            if p.suffix in [".mp3", ".wav"] and p.is_file() and not p.is_symlink()
        ),
        key=lambda p: p.stat().st_mtime,
    )
    size = sum(p.stat().st_size for p in files)
    while files and (size > 32 * 1024**2 or len(files) > 512):
        path = files.pop(0)
        size -= path.stat().st_size
        path.unlink(missing_ok=True)


def audio(text, language, private, root):
    global _online_retry_at
    text, language = validate(text, language)
    folder = Path(private) / "speech"
    folder.mkdir(exist_ok=True)
    identity = hashlib.sha256(
        ("v2-exact-locale:" + language + ":" + text).encode()
    ).hexdigest()

    def cached():
        for suffix, mime in [(".mp3", "audio/mpeg"), (".wav", "audio/wav")]:
            file = folder / (identity + suffix)
            if file.is_file() and file.stat().st_size > 200:
                return file.read_bytes(), mime

    hit = cached()
    if hit:
        return hit
    if not _limit.acquire(timeout=10):
        raise ValueError("朗读正在准备，请再点一次播放")
    temporary = folder / (identity + "." + uuid.uuid4().hex)
    try:
        hit = cached()
        if hit:
            return hit
        with _lock:
            retry_at = _online_retry_at.get(language, 0)
        if time.time() >= retry_at:
            try:
                import edge_tts

                async def online():
                    voice = VOICES[language]
                    await asyncio.wait_for(
                        edge_tts.Communicate(text, voice, rate="-15%").save(
                            str(temporary)
                        ),
                        timeout=10,
                    )

                asyncio.run(online())
                if temporary.stat().st_size < 200:
                    raise ValueError("Empty audio")
                os.replace(temporary, folder / (identity + ".mp3"))
                prune(folder)
                return cached()
            except Exception:
                with _lock:
                    _online_retry_at[language] = time.time() + 300
                temporary.unlink(missing_ok=True)
        executable = shutil.which("espeak-ng")
        if executable:
            voice = {"en-GB": "en-gb", "en-US": "en-us", "zh-CN": "cmn"}[language]
            result = subprocess.run(
                [executable, "-v", voice, "-s", "130", "-w", str(temporary), "--stdin"],
                input=text.encode(),
                capture_output=True,
                timeout=10,
            )
        elif os.name == "nt":
            executable = str(
                Path(os.environ.get("WINDIR", "C:/Windows"))
                / "System32/WindowsPowerShell/v1.0/powershell.exe"
            )
            result = subprocess.run(
                [
                    executable,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(Path(root) / "tts-windows.ps1"),
                    "-Text",
                    text,
                    "-Language",
                    language,
                    "-OutputPath",
                    str(temporary),
                ],
                capture_output=True,
                timeout=15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        else:
            raise ValueError("服务器朗读组件暂不可用，请稍后重试")
        if (
            result.returncode
            or not temporary.exists()
            or temporary.stat().st_size < 100
        ):
            raise ValueError("读音生成失败，请重新播放")
        os.replace(temporary, folder / (identity + ".wav"))
        prune(folder)
        return cached()
    finally:
        temporary.unlink(missing_ok=True)
        _limit.release()
