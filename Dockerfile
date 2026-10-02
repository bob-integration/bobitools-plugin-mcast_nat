# SPDX-License-Identifier: GPL-3.0-or-later
# Image autonome de l'outil « NAT multicast ». Seule dépendance : requests (NX-API).
FROM python:3.13-slim

RUN pip install --no-cache-dir requests

WORKDIR /app
COPY server.py nat_parse.py nat_model.py nat_pair.py /app/

# Volume propre : réglages, journal, états d'alerte, historique, captures.
VOLUME ["/data"]
# /inventory : volume de « Pilotage de switch », monté EN LECTURE SEULE par l'app.

# DOIT correspondre à docker.port du plugin.json.
EXPOSE 8080

CMD ["python", "-u", "/app/server.py"]
