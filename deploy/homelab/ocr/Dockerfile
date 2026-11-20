# syntax=docker/dockerfile:1
# The organization's Thai OCR for the Webapp: the STeP Desktop local OCR service (Harness
# experiments/local-thai-ocr, from the pinned `harness` submodule) with PaddleOCR and Typhoon OCR V2 0.8B
# run by llama.cpp. Model weights are not in the image; fetch-models.sh puts them in a read-only volume.
# Build with `docker compose ... --profile ocr build ocr` (see docs/homelab.md); about 11 minutes, 2.4 GB.
FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libgomp1 libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
# llama.cpp b12464, the build the Typhoon benchmark and STeP Desktop use (MIT).
ARG LLAMA=llama-b12464-bin-ubuntu-x64.tar.gz
ARG LLAMA_SHA256=7dd1899af7f0ddda42920d383b7dcda7097c1e5e45fcef582b68ea66badb46de
RUN curl -fsSL -o /tmp/llama.tar.gz "https://github.com/ggml-org/llama.cpp/releases/download/b12464/$LLAMA" \
    && echo "$LLAMA_SHA256  /tmp/llama.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/typhoon/llama /opt/typhoon/models \
    && tar -xzf /tmp/llama.tar.gz -C /opt/typhoon/llama \
    && rm /tmp/llama.tar.gz \
    && find /opt/typhoon/llama -name llama-server -type f | grep -q .
WORKDIR /app
COPY harness/experiments/local-thai-ocr/requirements-core.txt ./
# The PaddlePaddle CPU wheel STeP Desktop installs.
RUN pip install paddlepaddle==3.3.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/ \
    && pip install -r requirements-core.txt
COPY harness/experiments/local-thai-ocr/ ./
RUN test -f typhoon_engine.py || (echo "The harness submodule has no Typhoon OCR yet; pin a release that has it." && exit 1)
ENV PADDLE_PDX_CACHE_HOME=/opt/paddlex PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    STEP_TYPHOON_DIR=/opt/typhoon STEP_OCR_ALLOW_REMOTE=1
# The two PaddleOCR models go into the image, so the running service downloads nothing.
RUN python -c "from ocr_engine import LocalThaiOCR; LocalThaiOCR()._get_ocr(); print('models ready')" \
    && chmod -R a+rX /opt/paddlex /app
USER 10001:10001
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=4)" || exit 1
# Bound to the compose network only; the web's nginx is the one way in and checks the Supabase sign-in.
CMD ["python", "app.py", "--host", "0.0.0.0", "--port", "8765", "--no-browser"]
