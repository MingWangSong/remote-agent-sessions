# Descriptor-relative file service over a private OpenSSH stdio channel.
import os, sys, stat, json, struct, base64, uuid, hashlib, signal
MAX_FILE = 16 * 1024 * 1024
MAX_FRAME = 24 * 1024 * 1024
roots = {}
if os.name != 'posix':
    sys.stderr.write('Session Files requires a Linux or macOS host with Python 3.\n'); sys.exit(1)
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
DIR = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

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

def parent_path(p):
    ps = parts(p.get('path', ''))
    if not ps: raise PermissionError('The workspace root cannot be replaced')
    fd = open_path(p['root'], '/'.join(ps[:-1]))
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        os.close(fd); raise NotADirectoryError('The parent is not a directory')
    return fd, ps[-1]

def identity(s):
    return (s.st_dev, s.st_ino, s.st_mtime_ns, s.st_ctime_ns, s.st_size)

def write_file(p):
    data = base64.b64decode(p['data'], validate=True)
    if len(data) > MAX_FILE: raise ValueError('Files larger than 16 MiB cannot be saved')
    fd, name = parent_path(p)
    temporary = '.tmuxdock-write-' + uuid.uuid4().hex
    created = False
    try:
        try: before = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError: before = None
        if before:
            if not stat.S_ISREG(before.st_mode): raise PermissionError('Only regular files can be saved; symbolic links are not followed')
            if not p.get('overwrite'): raise FileExistsError('A file or directory with this name already exists')
            # Check actual write permission without truncating the original file.
            checked = os.open(name, os.O_WRONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                if identity(os.fstat(checked)) != identity(before): raise PermissionError('The file changed; reload it before saving')
            finally: os.close(checked)
        elif not p.get('create'): raise FileNotFoundError('The file no longer exists')
        target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o666, dir_fd=fd)
        created = True
        try:
            if before: os.fchmod(target, stat.S_IMODE(before.st_mode) & 0o777)
            remaining = memoryview(data)
            while remaining:
                count = os.write(target, remaining)
                if count <= 0: raise OSError('Unable to finish writing the temporary file')
                remaining = remaining[count:]
            os.fsync(target)
        finally: os.close(target)
        # Detect an Agent replacing or modifying the original while data was written.
        try: current = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError: current = None
        if before:
            if not current or identity(current) != identity(before): raise PermissionError('The file changed while saving; reload it before trying again')
            os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
            created = False
        else:
            # link is an atomic no-overwrite commit, including a concurrent create.
            os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        return {**info(os.stat(name, dir_fd=fd, follow_symlinks=False)), 'created': before is None}
    finally:
        if created:
            try: os.unlink(temporary, dir_fd=fd)
            except FileNotFoundError: pass
        os.close(fd)

def create_entry(p):
    if p.get('kind') not in ('file', 'directory'): raise ValueError('Unknown entry type')
    fd, name = parent_path(p)
    try:
        if p['kind'] == 'directory': os.mkdir(name, dir_fd=fd)
        else:
            target = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o666, dir_fd=fd)
            os.close(target)
        return info(os.stat(name, dir_fd=fd, follow_symlinks=False))
    finally: os.close(fd)

def make_directories(p):
    fd = open_path(p['root'], '')
    created = []; prefix = []
    try:
        for name in parts(p.get('path', '')):
            prefix.append(name)
            try:
                os.mkdir(name, dir_fd=fd); created.append('/'.join(prefix))
            except FileExistsError: pass
            child = os.open(name, DIR, dir_fd=fd)
            os.close(fd); fd = child
        return {**info(os.fstat(fd)), 'createdPaths': created}
    finally: os.close(fd)

def perform(m):
    op = m['op']; p = m.get('params', {})
    if op == 'hello': return {'version': 2, 'capabilities': {'read': True, 'create': True, 'write': True}}
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
    if op == 'create': return create_entry(p)
    if op == 'write': return write_file(p)
    if op == 'mkdir': return make_directories(p)
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
        raise ValueError('Unsupported file operation')
    finally: os.close(fd)

while True:
    try:
        size = struct.unpack('>I', receive(4))[0]
        if size > MAX_FRAME: break
        message = json.loads(receive(size)); ident = message.get('id')
        try: response = {'id': ident, 'result': perform(message)}
        except Exception as e:
            code = 'NotFound' if isinstance(e, FileNotFoundError) else 'FileExists' if isinstance(e, FileExistsError) else 'NoPermissions' if isinstance(e, PermissionError) else 'NotDirectory' if isinstance(e, NotADirectoryError) else 'Unavailable'
            response = {'id': ident, 'error': {'code': code, 'message': str(e)[:500]}}
        b = json.dumps(response, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('>I', len(b)) + b); sys.stdout.buffer.flush()
    except (EOFError, BrokenPipeError): break
    except Exception: break
for r in roots.values(): os.close(r['fd'])
