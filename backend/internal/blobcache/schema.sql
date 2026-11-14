-- Generated from src/core/blob-cache.ts by backend/contracts/blob-index.cjs.
CREATE TABLE IF NOT EXISTS aliases(key TEXT PRIMARY KEY,digest TEXT REFERENCES blobs(digest) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS blobs(digest TEXT PRIMARY KEY,file TEXT,size INTEGER,stored INTEGER,encoding TEXT,accessed INTEGER,allocated INTEGER);
CREATE TABLE IF NOT EXISTS decisions(key TEXT PRIMARY KEY,digest TEXT,changed INTEGER,accessed INTEGER,expires INTEGER, isText INTEGER);
CREATE TABLE IF NOT EXISTS fills(key TEXT PRIMARY KEY,token TEXT,expires INTEGER,reserved INTEGER);
CREATE TABLE IF NOT EXISTS history(key TEXT PRIMARY KEY,seen INTEGER,evicted INTEGER);
CREATE TABLE IF NOT EXISTS maintenance(id INTEGER PRIMARY KEY,nextScan INTEGER);
CREATE TABLE IF NOT EXISTS publications(token TEXT PRIMARY KEY,digest TEXT,file TEXT);
CREATE TABLE IF NOT EXISTS readers(token TEXT PRIMARY KEY,digest TEXT,expires INTEGER);
CREATE TABLE IF NOT EXISTS summary(id INTEGER PRIMARY KEY,blobs INTEGER,originalBytes INTEGER,storedBytes INTEGER,allocatedBytes INTEGER,activeReaders INTEGER,decisions INTEGER,aliases INTEGER,history INTEGER,reservedBytes INTEGER);
CREATE TABLE IF NOT EXISTS totals(id INTEGER PRIMARY KEY, bytes INTEGER);
CREATE INDEX IF NOT EXISTS aliases_digest ON aliases(digest);
CREATE INDEX IF NOT EXISTS blobs_file ON blobs(file);
CREATE INDEX IF NOT EXISTS blobs_lru ON blobs(accessed);
CREATE INDEX IF NOT EXISTS decisions_age ON decisions(accessed);
CREATE INDEX IF NOT EXISTS decisions_expiry ON decisions(expires);
CREATE INDEX IF NOT EXISTS history_seen ON history(seen);
CREATE INDEX IF NOT EXISTS readers_digest ON readers(digest);
CREATE INDEX IF NOT EXISTS readers_expiry ON readers(expires);
CREATE TRIGGER IF NOT EXISTS blob_added AFTER INSERT ON blobs BEGIN UPDATE totals SET bytes=bytes+NEW.allocated WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_removed AFTER DELETE ON blobs BEGIN UPDATE totals SET bytes=bytes-OLD.allocated WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_aliases_delete AFTER DELETE ON aliases BEGIN UPDATE summary SET aliases=aliases-1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_aliases_insert AFTER INSERT ON aliases BEGIN UPDATE summary SET aliases=aliases+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_blobs_delete AFTER DELETE ON blobs BEGIN UPDATE summary SET blobs=blobs-1,originalBytes=originalBytes-OLD.size,storedBytes=storedBytes-OLD.stored,allocatedBytes=allocatedBytes-OLD.allocated WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_blobs_insert AFTER INSERT ON blobs BEGIN UPDATE summary SET blobs=blobs+1,originalBytes=originalBytes+NEW.size,storedBytes=storedBytes+NEW.stored,allocatedBytes=allocatedBytes+NEW.allocated WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_blobs_update AFTER UPDATE OF size,stored,allocated ON blobs
            BEGIN UPDATE summary SET originalBytes=originalBytes-OLD.size+NEW.size,storedBytes=storedBytes-OLD.stored+NEW.stored,allocatedBytes=allocatedBytes-OLD.allocated+NEW.allocated WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_decisions_delete AFTER DELETE ON decisions BEGIN UPDATE summary SET decisions=decisions-1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_decisions_insert AFTER INSERT ON decisions BEGIN UPDATE summary SET decisions=decisions+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_fills_delete AFTER DELETE ON fills BEGIN UPDATE summary SET reservedBytes=reservedBytes-OLD.reserved WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_fills_insert AFTER INSERT ON fills BEGIN UPDATE summary SET reservedBytes=reservedBytes+NEW.reserved WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_fills_update AFTER UPDATE OF reserved ON fills
            BEGIN UPDATE summary SET reservedBytes=reservedBytes-OLD.reserved+NEW.reserved WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_history_delete AFTER DELETE ON history BEGIN UPDATE summary SET history=history-1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_history_insert AFTER INSERT ON history BEGIN UPDATE summary SET history=history+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_readers_delete AFTER DELETE ON readers BEGIN UPDATE summary SET activeReaders=activeReaders-1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS summary_readers_insert AFTER INSERT ON readers BEGIN UPDATE summary SET activeReaders=activeReaders+1 WHERE id=1; END;
