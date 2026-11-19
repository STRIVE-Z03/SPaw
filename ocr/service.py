"""Local OCR worker. Uploaded images stay in memory on this host."""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer

import cv2
import numpy as np
from paddleocr import PaddleOCR


def read_lines(engine, image):
    original_height, original_width = height, width = image.shape[:2]
    if width > 1280:
        height = round(height * 1280 / width)
        image = cv2.resize(image, (1280, height), interpolation=cv2.INTER_AREA)
        width = 1280
    # The overlap gives the detector context without emitting boundary lines twice.
    for start in range(0, height, 1120):
        end = min(start + 1120, height)
        top = max(start - 80, 0)
        tile = image[top : min(end + 80, height)]
        for result in engine.predict(tile):
            for text, score, polygon in zip(
                result["rec_texts"], result["rec_scores"], result["rec_polys"]
            ):
                points = np.asarray(polygon)
                xs, ys = points[:, 0], points[:, 1] + top
                center = float(np.mean(ys))
                if start <= center < end and score >= 0.65 and text.strip():
                    yield {
                        "text": text.strip(),
                        "box": [
                            int(xs.min() * original_width / width),
                            int(ys.min() * original_height / height),
                            int(xs.max() * original_width / width),
                            int(ys.max() * original_height / height),
                        ],
                    }


def main():
    engine = PaddleOCR(
        device="cpu",
        cpu_threads=2,
        enable_mkldnn=False,
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="PP-OCRv5_mobile_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_det_limit_side_len=1280,
        text_det_limit_type="max",
    )

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def send_json(self, value, status=200):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path != "/ocr":
                return self.send_json({"error": "not_found"}, 404)
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8 * 1024**2:
                    return self.send_json({"error": "invalid_size"}, 400)
                image = cv2.imdecode(
                    np.frombuffer(self.rfile.read(size), dtype=np.uint8),
                    cv2.IMREAD_COLOR,
                )
                if image is None or image.shape[0] * image.shape[1] > 8_000_000:
                    return self.send_json({"error": "invalid_image"}, 400)
                lines = list(read_lines(engine, image))
            except Exception as error:
                self.log_error("OCR failure: %s", type(error).__name__)
                return self.send_json({"error": "inference_failed"}, 503)
            return self.send_json(
                {
                    "text": "\n".join(line["text"] for line in lines)[:6000],
                    "lines": lines,
                }
            )

    HTTPServer(("127.0.0.1", 18766), Handler).serve_forever()


if __name__ == "__main__":
    main()
