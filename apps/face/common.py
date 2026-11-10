"""Shared InsightFace setup for the face worker (Phase 3 test).

Model: InsightFace buffalo_l (SCRFD-10G detector + ArcFace R50 / w600k). NOTE: the pretrained
buffalo_l weights are licensed for non-commercial research only — production use needs a
commercial license from InsightFace (decision pending, see project notes).
"""
import os

import numpy as np
import onnxruntime as ort

# insightface creates its own InferenceSession without SessionOptions, and ONNX Runtime ignores
# OMP_NUM_THREADS — each process would spawn one thread per core (load avg > 100 with a process
# pool). Cap threads per session; FACE_THREADS × worker processes should stay below the core count.
_Session = ort.InferenceSession


class _CappedSession(_Session):
    def __init__(self, path, sess_options=None, *args, **kwargs):
        so = sess_options or ort.SessionOptions()
        n = int(os.environ.get("FACE_THREADS", "2"))
        so.intra_op_num_threads = n
        so.inter_op_num_threads = 1
        super().__init__(path, so, *args, **kwargs)


ort.InferenceSession = _CappedSession

from insightface.app import FaceAnalysis  # noqa: E402  (must come after the patch)

_app = None


def face_app(det_size=(640, 640)) -> FaceAnalysis:
    global _app
    if _app is None:
        _app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"], providers=["CPUExecutionProvider"])
        _app.prepare(ctx_id=-1, det_size=det_size)
    return _app


def detect(img: np.ndarray, det_size=(640, 640), thresh=0.5):
    """Returns insightface Face objects (bbox, kps, det_score) — no embeddings yet."""
    app = face_app()
    det = app.det_model
    det.det_thresh = thresh
    bboxes, kpss = det.detect(img, input_size=det_size, max_num=0, metric="default")
    from insightface.app.common import Face

    out = []
    for i in range(bboxes.shape[0]):
        out.append(Face(bbox=bboxes[i, :4], kps=kpss[i] if kpss is not None else None, det_score=float(bboxes[i, 4])))
    return out


def embed(img: np.ndarray, face) -> np.ndarray:
    """L2-normalized 512-d ArcFace embedding, aligned from the full-resolution image."""
    rec = face_app().models["recognition"]
    rec.get(img, face)
    e = face.embedding.astype(np.float32)
    return e / (np.linalg.norm(e) + 1e-9)
