# Read-only, descriptor-relative file service. Runs over a private OpenSSH stdio channel.
import os, sys, stat, json, struct, base64, uuid, hashlib
MAX_FRAME = 1048576
roots = {}
if os.name != 'posix':
    sys.stderr.write('Session Files requires a Linux or macOS host with Python 3.\n'); sys.exit(1)
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
DIR = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW

def receive(n):
    chunks = []
    while n:
        b = sys.stdin.buffer.read(n)
        if not b: raise EOFError()
        chunks.append(b); n -= len(b)
    return b''.join(chunks)

def parts(path):
    if not isinstance(path, str) or '\x00' in path or path.startswith('/'):
        raise PermissionError('Invalid relative path')
    out = path.split('/')
    if any(p in ('.', '..') for p in out): raise PermissionError('Path traversal is not allowed')
    return [p for p in out if p]

def open_path(root, path):
    r = roots.get(root)
    if not r: raise KeyError('Root binding expired')
    current = os.stat(r['path'])
    if (current.st_dev, current.st_ino) != r['identity']:
        raise PermissionError('Workspace root changed; reconnect or rebind it explicitly')
    fd = os.dup(r['fd'])
    try:
        ps = parts(path)
        for i, p in enumerate(ps):
            flags = DIR if i < len(ps)-1 else os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK
            newfd = os.open(p, flags, dir_fd=fd)
            os.close(fd); fd = newfd
        return fd
    except BaseException:
        os.close(fd); raise

def info(s):
    kind = 'directory' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'link' if stat.S_ISLNK(s.st_mode) else 'other'
    return {'type': kind, 'size': s.st_size, 'mtime': s.st_mtime_ns//1000000,
            'ctime': s.st_ctime_ns//1000000, 'signature': str(s.st_dev)+':'+str(s.st_ino)+':'+str(s.st_mtime_ns)+':'+str(s.st_size)}

def perform(m):
    op = m['op']; p = m.get('params', {})
    if op == 'hello': return {'version': 1, 'readonly': True}
    if op == 'bind':
        if len(roots) >= 128: raise ValueError('Too many workspace roots')
        path = p['path']
        if not isinstance(path, str) or not path.startswith('/') or '\x00' in path: raise ValueError('Root must be absolute')
        requested = path; path = os.path.realpath(path); fd = os.open(path, DIR); s = os.fstat(fd)
        key = uuid.uuid4().hex; roots[key] = {'path': requested, 'fd': fd, 'identity': (s.st_dev, s.st_ino)}
        return {'root': key, 'canonicalPath': path}
    if op == 'unbind':
        r = roots.pop(p['root'], None)
        if r: os.close(r['fd'])
        return True
    if op == 'snapshot':
        checked = open_path(p['root'], ''); os.close(checked)
        paths = p.get('paths', [])
        if len(paths) > 512: raise ValueError('Too many watched paths')
        out = []
        for path in paths:
            try:
                fd = open_path(p['root'], path)
                try:
                    s = os.fstat(fd); item = info(s)
                    if stat.S_ISREG(s.st_mode) and s.st_size <= 131072:
                        item['signature'] += ':' + hashlib.sha256(os.read(fd, 131073)).hexdigest()
                    out.append({'path': path, 'signature': item['signature']})
                finally: os.close(fd)
            except FileNotFoundError: out.append({'path': path, 'signature': None})
            except OSError as e: out.append({'path': path, 'signature': 'error:' + str(e.errno)})
        return out
    fd = open_path(p['root'], p.get('path', ''))
    try:
        s = os.fstat(fd)
        if op == 'stat': return info(s)
        if op == 'list':
            if not stat.S_ISDIR(s.st_mode): raise NotADirectoryError('Not a directory')
            entries = []; skipped = 0; scanned = 0
            with os.scandir(fd) as scan:
                for e in scan:
                    scanned += 1
                    if scanned > 20000: raise ValueError('Directory has more than 20000 entries')
                    try: e.name.encode('utf-8')
                    except UnicodeError: skipped += 1; continue
                    try: item = info(e.stat(follow_symlinks=False))
                    except FileNotFoundError: continue
                    entries.append({'name': e.name, **item})
            entries.sort(key=lambda e: (e['type'] != 'directory', e['name'].casefold(), e['name']))
            offset = max(0, int(p.get('offset', 0))); limit = min(500, max(1, int(p.get('limit', 200))))
            end = offset + limit
            return {'entries': entries[offset:end], 'total': len(entries), 'next': end if end < len(entries) else None, 'skipped': skipped}
        if op == 'read':
            if not stat.S_ISREG(s.st_mode): raise PermissionError('Only regular files can be read')
            offset = max(0, int(p.get('offset', 0))); length = min(262144, max(0, int(p.get('length', 262144))))
            os.lseek(fd, offset, os.SEEK_SET)
            return {**info(s), 'data': base64.b64encode(os.read(fd, length)).decode('ascii')}
        raise ValueError('Unsupported read-only operation')
    finally: os.close(fd)

while True:
    try:
        size = struct.unpack('>I', receive(4))[0]
        if size > MAX_FRAME: break
        message = json.loads(receive(size)); ident = message.get('id')
        try: response = {'id': ident, 'result': perform(message)}
        except Exception as e:
            code = 'NotFound' if isinstance(e, FileNotFoundError) else 'NoPermissions' if isinstance(e, PermissionError) else 'NotDirectory' if isinstance(e, NotADirectoryError) else 'Unavailable'
            response = {'id': ident, 'error': {'code': code, 'message': str(e)[:500]}}
        b = json.dumps(response, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('>I', len(b)) + b); sys.stdout.buffer.flush()
    except (EOFError, BrokenPipeError): break
    except Exception: break
for r in roots.values(): os.close(r['fd'])
