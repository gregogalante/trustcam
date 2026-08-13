# Internal watermark service: embeds/extracts VideoSeal payloads.
# Not exposed publicly — only the Node server talks to it.
import os
import tempfile

from fastapi import FastAPI, UploadFile, Form, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

import codec
import media

app = FastAPI()


def _save_upload(file: UploadFile) -> str:
    suffix = os.path.splitext(file.filename or '')[1] or '.bin'
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        while True:
            chunk = file.file.read(1 << 20)
            if not chunk:
                break
            tmp.write(chunk)
        return tmp.name


@app.get('/health')
def health():
    return {'ok': True}


@app.post('/embed')
def embed(file: UploadFile, proof_id: int = Form(...)):
    src = _save_upload(file)
    dst = src + ('.mp4' if media.is_video(src) else '.jpg')
    try:
        msg = codec.encode(proof_id)
        if media.is_video(src):
            media.embed_video(src, dst, msg)
        else:
            media.embed_image(src, dst, msg)
    except Exception as e:
        os.unlink(src)
        if os.path.exists(dst):
            os.unlink(dst)
        raise HTTPException(500, f'embed failed: {e}')
    os.unlink(src)
    cleanup = BackgroundTask(lambda: os.path.exists(dst) and os.unlink(dst))
    mime = 'video/mp4' if dst.endswith('.mp4') else 'image/jpeg'
    return FileResponse(dst, media_type=mime, background=cleanup)


@app.post('/extract')
def extract(file: UploadFile):
    src = _save_upload(file)
    try:
        soft = media.extract_video(src) if media.is_video(src) else media.extract_image(src)
        proof_id, confidence = codec.decode(soft)
    except Exception as e:
        raise HTTPException(500, f'extract failed: {e}')
    finally:
        os.unlink(src)
    return {'proofId': proof_id, 'confidence': round(confidence, 4)}
