# Runbook: SQLite Backup & Restore

## Overview

The `SqliteAdapter` supports consistent online backup and point-in-time restore
using better-sqlite3's native backup API. Backups are safe to take while writes
are in progress.

## Backup

### Programmatic

```ts
import { SqliteAdapter } from "@55ndeep/memory-palace/sqlite-adapter";

const adapter = new SqliteAdapter("/data/55ndeep/memory.db");

// Auto-named backup: creates /data/55ndeep/memory.db.backup.2026-05-22T12-00-00-000Z
const result = await adapter.backup();

// Named backup path
const result2 = await adapter.backup("/backups/55ndeep/daily.db");

if (result.ok) {
  console.log(`Backup created: ${result.value.filePath}`);
  console.log(`SHA-256: ${result.value.sha256}`);
  console.log(`Rows: ${JSON.stringify(result.value.rowCount)}`);
}
```

### CLI (via daemon)

```bash
# Trigger a backup via the health server API (requires operator role)
curl -H "Authorization: Bearer $API_KEY" \
  -X POST http://localhost:9090/v1/admin/backup
```

### Scheduled Backups

For production, schedule regular backups via cron or Kubernetes CronJob:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: 55ndeep-backup
spec:
  schedule: "0 */6 * * *" # Every 6 hours
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: 55ndeep:latest
              command: [
                  "node",
                  "-e",
                  "
                  const { SqliteAdapter } = require('@55ndeep/memory-palace/sqlite-adapter');
                  const a = new SqliteAdapter(process.env.DB_PATH);
                  a.backup(process.env.BACKUP_PATH).then(r => {
                  if (r.ok) { console.log('Backup OK:', r.value.filePath); process.exit(0); }
                  else { console.error('Backup FAIL:', r.error); process.exit(1); }
                  });",
                ]
          env:
            - name: DB_PATH
              value: /data/55ndeep/memory.db
            - name: BACKUP_PATH
              value: /backups/55ndeep/hourly-$(date +%Y%m%d%H%M).db
```

### Backup Metadata

Each `backup()` call returns a `BackupMetadata` object:

| Field           | Type           | Description                                          |
| --------------- | -------------- | ---------------------------------------------------- |
| `filePath`      | string         | Absolute path of the backup file                     |
| `sizeBytes`     | number         | Size in bytes                                        |
| `sha256`        | string         | SHA-256 hash of the backup file                      |
| `schemaVersion` | number \| null | Schema version at time of backup                     |
| `timestamp`     | string         | ISO timestamp when backup was created                |
| `rowCount`      | object         | Row counts per table (observations, runs, emissions) |

## Restore

### Programmatic

```ts
const adapter = new SqliteAdapter("/data/55ndeep/memory.db");

// IMPORTANT: This overwrites the current database.
// Create a backup first if you want to preserve current state.
const restoreResult = await adapter.restore("/backups/55ndeep/daily.db");

if (restoreResult.ok) {
  console.log(`Restored from: ${restoreResult.value.filePath}`);
  console.log(`SHA-256: ${restoreResult.value.sha256}`);
  console.log(`Rows: ${JSON.stringify(restoreResult.value.rowCount)}`);
}
```

### Disaster Recovery Procedure

1. **Stop the daemon** to prevent writes during restore:

   ```bash
   kubectl scale deploy/55ndeep --replicas=0
   ```

2. **Verify the backup integrity** (SHA-256 checksum):

   ```bash
   sha256sum /backups/55ndeep/daily.db
   # Compare with the hash recorded at backup time
   ```

3. **Restore from backup**:

   ```bash
   kubectl exec deploy/55ndeep -- node -e "
     const { SqliteAdapter } = require('@55ndeep/memory-palace/sqlite-adapter');
     const a = new SqliteAdapter('/data/55ndeep/memory.db');
     a.restore('/backups/55ndeep/daily.db').then(r => {
       console.log(r.ok ? 'Restore OK' : 'Restore FAIL', r.ok ? r.value : r.error);
       process.exit(r.ok ? 0 : 1);
     });
   "
   ```

4. **Verify row counts** match the backup metadata.

5. **Restart the daemon**:
   ```bash
   kubectl scale deploy/55ndeep --replicas=1
   ```

### Important Notes

- `restore()` is **destructive** — it overwrites the current database file.
- Always create a backup before restoring, unless the current state is known to be corrupt.
- The restore process closes the current database handle, copies the backup file over it,
  and reopens. This means any in-memory state is lost.
- Restore verifies row counts after completion. If the row counts don't match what you
  expect, the restore may have partially failed.

## Listing Backups

```ts
const adapter = new SqliteAdapter("/data/55ndeep/memory.db");

// List auto-named backups in the database directory
const backups = adapter.listBackups();
// Returns sorted array of paths like:
// ["/data/55ndeep/memory.db.backup.2026-05-22T00-00-00-000Z", ...]

// List backups in a specific directory
const customBackups = adapter.listBackups("/backups/55ndeep/");
```

## Retention Policy

Recommended backup retention:

| Frequency | Retention | Storage estimate  |
| --------- | --------- | ----------------- |
| Hourly    | 24 hours  | ~24 × avg DB size |
| Daily     | 30 days   | ~30 × avg DB size |
| Weekly    | 90 days   | ~12 × avg DB size |

## Troubleshooting

| Symptom                           | Cause                 | Resolution                              |
| --------------------------------- | --------------------- | --------------------------------------- |
| `backup failed: SQLITE_BUSY`      | Concurrent write lock | Retry after WAL checkpoint              |
| `backup failed: ENOSPC`           | Disk full             | Free disk space or use different volume |
| `restore failed: not found`       | Backup file missing   | Verify backup path                      |
| `restore failed: SQLITE_CORRUPT`  | Backup file corrupted | Use an earlier backup                   |
| Row counts mismatch after restore | Partial backup        | Verify SHA-256 matches                  |
