# Internal watermark service: extracts VideoSeal payloads for the verifier.
# (Embedding happens on-device since app 0.5.0.) Not exposed publicly.
import os
import tempfile

from fastapi import FastAPI, UploadFile, HTTPException

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


@app.post('/extract')
def extract(file: UploadFile):
    src = _save_upload(file)
    try:
        soft = media.extract_video(src) if media.is_video(src) else media.extract_image(src)
        payload, confidence = codec.decode(soft)
    except Exception as e:
        raise HTTPException(500, f'extract failed: {e}')
    finally:
        os.unlink(src)
    # field name kept as proofId for the Node caller; value is the payload
    return {'proofId': payload, 'confidence': round(confidence, 4)}
