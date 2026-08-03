# Scheduled logical backups of the Railway Postgres service.
# Runs as a Railway cron service: the container starts, uploads one dump and exits.
FROM postgres:16-alpine

RUN apk add --no-cache curl

COPY infra/railway/backup/backup.sh /usr/local/bin/backup.sh
COPY infra/railway/backup/restore.sh /usr/local/bin/restore.sh
COPY infra/railway/backup/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/entrypoint.sh

CMD ["/usr/local/bin/entrypoint.sh"]
