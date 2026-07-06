# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app

# Shared schema/choreography/metrics package first (its own layer for cache reuse).
COPY shared/guidemate_msgs /app/shared/guidemate_msgs
RUN pip install /app/shared/guidemate_msgs

# The service.
COPY agent_service /app/agent_service
RUN pip install /app/agent_service
# amazon-transcribe (streaming STT) is installed --no-deps on purpose: its metadata
# hard-pins awscrt~=0.26.1 which conflicts with awsiotsdk's awscrt 0.34.x. Its only
# dependency IS awscrt, already present at 0.34.1 (runtime-compatible; verified by the
# live Polly->Transcribe loopback). See the note in agent_service/pyproject.toml.
RUN pip install --no-deps amazon-transcribe
# The app loads static assets (chat + admin UI) from a `static/` dir resolved as a
# sibling of the installed `guidemate_agent` package. A non-editable install ships only
# the package, not the sibling `static/` tree, so place it beside the installed package.
RUN cp -r /app/agent_service/static "$(python -c 'import site; print(site.getsitepackages()[0])')/static"

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status==200 else sys.exit(1)"

CMD ["uvicorn", "guidemate_agent.app:app", "--host", "0.0.0.0", "--port", "8000"]
