#!/bin/bash
# Run the watermark service (internal, localhost-only) and the Node server.
# If either dies, exit so the platform restarts the container.
(cd /app/videoseal && exec uvicorn app:app --host 127.0.0.1 --port 8000) &
(cd /app && exec node server/src/index.js) &
wait -n
exit $?
