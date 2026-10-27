const DEFAULT_BODY_LIMIT = 8192;

export function readBody(req, res, onBody, { limit = DEFAULT_BODY_LIMIT } = {}) {
  let chunks = [];
  let size = 0;
  let done = false;
  const reject = (status, error, detail) => {
    if (done) return;
    done = true;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error, detail }));
  };
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    reject(413, 'oversized', '请求体超过 ' + limit + ' 字节上限');
    req.resume();
    return;
  }
  req.on('data', chunk => {
    if (done) return;
    size += chunk.length;
    if (size > limit) {
      reject(413, 'oversized', '请求体超过 ' + limit + ' 字节上限');
      chunks = [];
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (done) return;
    done = true;
    const fail = error => {
      console.error('[http-request] ' + (error?.stack || String(error)));
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal-error' }));
    };
    try {
      const result = onBody(Buffer.concat(chunks, size).toString('utf8'));
      Promise.resolve(result).catch(fail);
    } catch (error) { fail(error); }
  });
  req.on('error', error => reject(400, 'request-body-error', String(error.message || error)));
}
