FROM python:3.11-slim

WORKDIR /app
COPY server.py ./server.py
COPY signaling.py ./signaling.py
COPY webserver.py ./webserver.py
COPY public ./public

EXPOSE 8000
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8000", "--max-peers", "8"]
