"""Synthetic local experiment; never connect to a real process manager."""
import contextlib
import fcntl
import os
import secrets
import sqlite3

class Fenced(RuntimeError): pass

STATES = {'RESERVED','LAUNCHING','RUNNING','STOPPING','VERIFIED_EMPTY','RELEASED','UNKNOWN'}
TRANSITIONS = {('RESERVED','LAUNCHING'), ('LAUNCHING','RUNNING'),
               ('RUNNING','STOPPING'), ('STOPPING','VERIFIED_EMPTY'),
               ('VERIFIED_EMPTY','RELEASED')} | {(s, 'UNKNOWN') for s in ('RESERVED','LAUNCHING','RUNNING','STOPPING')}

def crash(point):
    if os.environ.get('CRASH_POINT') == point: os._exit(91)

class FakeManager:
    """Only appends synthetic events to a separate SQLite database."""
    def __init__(self, path):
        self.path = path
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE IF NOT EXISTS events (kind TEXT, op TEXT)')
    def effect(self, kind, op):
        with sqlite3.connect(self.path) as db:
            db.execute('INSERT INTO events VALUES (?,?)', (kind,op))
    def count(self, kind):
        with sqlite3.connect(self.path) as db:
            return db.execute('SELECT count(*) FROM events WHERE kind=?',(kind,)).fetchone()[0]

class Authority:
    @staticmethod
    def initialize(path):
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('CREATE TABLE metadata (version INTEGER NOT NULL, capacity INTEGER)')
            db.execute('INSERT INTO metadata VALUES (1, NULL)')
            db.execute('CREATE TABLE operations (op TEXT PRIMARY KEY, subject TEXT NOT NULL, request TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, UNIQUE(subject,request))')
            db.execute('CREATE TABLE history (seq INTEGER PRIMARY KEY, op TEXT NOT NULL, old TEXT, new TEXT NOT NULL)')
            db.execute('CREATE TRIGGER record_insert AFTER INSERT ON operations BEGIN INSERT INTO history(op,old,new) VALUES (NEW.op,NULL,NEW.state); END')
            db.execute('CREATE TRIGGER record_transition AFTER UPDATE OF state ON operations BEGIN INSERT INTO history(op,old,new) VALUES (NEW.op,OLD.state,NEW.state); END')
    def __init__(self, path, manager, capacity):
        if type(capacity) is not int or capacity < 1: raise Fenced('invalid capacity')
        self.path, self.manager, self.capacity = path, manager, capacity
        self._owner_pid = os.getpid()
        self._lease = open(path + '.authority.lock', 'a')
        try:
            fcntl.flock(self._lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            self._lease.close()
            raise Fenced('authority active') from e
        self._recovered = False
        try: self.recover()
        except BaseException:
            self.close()
            raise
    def close(self):
        if self._lease and not self._lease.closed:
            self._lease.close()
    def __del__(self):
        if hasattr(self, '_lease'): self.close()
    @contextlib.contextmanager
    def locked(self):
        if self._lease.closed or self._owner_pid != os.getpid(): raise Fenced('authority not active')
        with open(self.path + '.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try: yield
            finally: fcntl.flock(lock, fcntl.LOCK_UN)
    @contextlib.contextmanager
    def tx(self):
        db = None
        try:
            db = sqlite3.connect('file:' + self.path + '?mode=rw', uri=True, timeout=10, isolation_level=None)
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]: raise Fenced('integrity')
            metadata = db.execute('SELECT version,capacity FROM metadata').fetchall()
            if len(metadata) != 1 or metadata[0][0] != 1: raise Fenced('schema')
            stored = metadata[0][1]
            if stored is None:
                db.execute('UPDATE metadata SET capacity=?', (self.capacity,))
            elif type(stored) is not int or stored < 1 or stored != self.capacity:
                raise Fenced('capacity mismatch')
            rows = db.execute('SELECT op,subject,request,payload,state FROM operations').fetchall()
            for op, sub, req, payload, state in rows:
                if not (isinstance(op,str) and len(op)==64 and all(c in '0123456789abcdef' for c in op) and all(isinstance(v,str) and v for v in (sub,req,payload)) and state in STATES): raise Fenced('invalid record')
            histories = {}
            for op, old, new in db.execute('SELECT op,old,new FROM history ORDER BY seq'):
                prior = histories.get(op)
                if prior is None:
                    if old is not None or new != 'RESERVED': raise Fenced('invalid history')
                elif old != prior or (old, new) not in TRANSITIONS:
                    raise Fenced('invalid transition')
                histories[op] = new
            if histories != {op: state for op, sub, req, payload, state in rows}: raise Fenced('history mismatch')
            yield db
            db.execute('COMMIT')
        except sqlite3.Error as e:
            if db and db.in_transaction: db.execute('ROLLBACK')
            raise Fenced('store failure') from e
        except BaseException:
            if db and db.in_transaction: db.execute('ROLLBACK')
            raise
        finally:
            if db: db.close()
    def lookup(self, subject, request):
        with self.locked(), self.tx() as db:
            row = db.execute('SELECT op FROM operations WHERE subject=? AND request=?',(subject,request)).fetchone()
            return row[0] if row else None
    def state(self, op):
        with self.locked(), self.tx() as db:
            row = db.execute('SELECT state FROM operations WHERE op=?',(op,)).fetchone()
            return row[0] if row else None
    def start(self, subject, request, payload):
        if not all(isinstance(x,str) and x for x in (subject,request,payload)): raise Fenced('bad request')
        with self.locked():
            with self.tx() as db:
                row = db.execute('SELECT op,payload,state FROM operations WHERE subject=? AND request=?',(subject,request)).fetchone()
                if row:
                    if row[1] != payload: raise Fenced('idempotency conflict')
                    return row[0], row[2]
                if db.execute("SELECT count(*) FROM operations WHERE state != 'RELEASED'").fetchone()[0] >= self.capacity: raise Fenced('capacity')
                while True:
                    op = secrets.token_hex(32)
                    if not db.execute('SELECT 1 FROM operations WHERE op=?',(op,)).fetchone(): break
                db.execute('INSERT INTO operations VALUES (?,?,?,?,?)',(op,subject,request,payload,'RESERVED'))
            crash('after_reserve')
            with self.tx() as db: db.execute("UPDATE operations SET state='LAUNCHING' WHERE op=? AND state='RESERVED'",(op,))
            crash('after_launching')
            self.manager.effect('start',op)
            crash('after_start_effect')
            with self.tx() as db: db.execute("UPDATE operations SET state='RUNNING' WHERE op=? AND state='LAUNCHING'",(op,))
            crash('after_running')
            return op, 'RUNNING'
    def stop(self, subject, op):
        with self.locked():
            with self.tx() as db:
                row = db.execute('SELECT subject,state FROM operations WHERE op=?',(op,)).fetchone()
                if not row or row[0] != subject: raise Fenced('not authorized')
                if row[1] == 'RELEASED': return
                if row[1] != 'RUNNING': raise Fenced('not safely stoppable')
                db.execute("UPDATE operations SET state='STOPPING' WHERE op=? AND state='RUNNING'",(op,))
            crash('after_stopping')
            self.manager.effect('stop',op)
            crash('after_stop_effect')
            # Synthetic manager's synchronous append stands in for proof; not real termination proof.
            with self.tx() as db: db.execute("UPDATE operations SET state='VERIFIED_EMPTY' WHERE op=? AND state='STOPPING'",(op,))
            crash('after_verified')
            with self.tx() as db: db.execute("UPDATE operations SET state='RELEASED' WHERE op=? AND state='VERIFIED_EMPTY'",(op,))
            crash('after_release')
    def recover(self):
        if self._recovered: raise Fenced('recovery already performed')
        with self.locked(), self.tx() as db:
            db.execute("UPDATE operations SET state='UNKNOWN' WHERE state IN ('RESERVED','LAUNCHING','RUNNING','STOPPING')")
            db.execute("UPDATE operations SET state='RELEASED' WHERE state='VERIFIED_EMPTY'")
        self._recovered = True
