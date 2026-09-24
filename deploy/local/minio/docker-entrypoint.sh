#!/bin/sh
# Compose passes `server /data --console-address :9001`. Prepend the
# server binary, matching the community image entrypoint.
if [ "${1}" != "minio" ]; then
	if [ -n "${1}" ]; then
		set -- /usr/local/bin/minio "$@"
	fi
fi
exec "$@"
