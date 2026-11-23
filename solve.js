// solve.js — makefun-site 1.0.0 drop-in, fresh implementation from the prose spec.
// Dependency-free ES module. Exports run(input) -> output tree object.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function esc(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

const MARK_RE = /\p{M}/u;
function slugify(text, cache) {
  let s = cache.get(text);
  if (s !== undefined) return s;
  const norm = text.normalize('NFKD');
  let out = '';
  let pending = false;
  for (const ch of norm) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      if (pending && out.length > 0) out += '-';
      pending = false;
      out += ch;
    } else if (ch >= 'A' && ch <= 'Z') {
      if (pending && out.length > 0) out += '-';
      pending = false;
      out += ch.toLowerCase();
    } else if (MARK_RE.test(ch)) {
      // combining mark: dropped, not a gap
    } else {
      pending = true;
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  if (out.length > 0) {
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    if (e < out.length) out = out.slice(0, e);
  }
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

function uniqueSlug(base, taken) {
  if (!taken.has(base)) { taken.add(base); return base; }
  let k = 2;
  while (taken.has(base + '-' + k)) k++;
  const s = base + '-' + k;
  taken.add(s);
  return s;
}

function dateLong(ds) {
  if (!ds) return '';
  const m = +ds.slice(5, 7);
  const d = +ds.slice(8, 10);
  return d + ' ' + MONTHS[m - 1] + ' ' + ds.slice(0, 4);
}

function readingMinutes(body) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  let r = Math.ceil(n / 200);
  return r < 1 ? 1 : r;
}

// ---------- front matter ----------

const FM_KEY_RE = /^([a-z_]+):(?: (.*))?$/;
const LAYOUT_RE = /^[a-z0-9-]+$/;
const SLUG_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function validDate(v) {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1970 || y > 2099) return false;
  if (mo < 1 || mo > 12) return false;
  let dim = DAYS_IN_MONTH[mo - 1];
  if (mo === 2 && isLeap(y)) dim = 29;
  return d >= 1 && d <= dim;
}

function parseQuoted(k, v) {
  // v starts with '"'. Returns the unescaped string or throws with the reason.
  let out = '';
  let i = 1;
  const n = v.length;
  while (i < n) {
    const c = v[i];
    if (c === '\\') {
      const nx = v[i + 1];
      if (nx === '"' || nx === '\\') { out += nx; i += 2; }
      else throw new Error('key "' + k + '": a quoted string holds an escape other than \\" or \\\\');
    } else if (c === '"') {
      if (i === n - 1) return out;
      throw new Error('key "' + k + '": a quoted string holds a stray quote');
    } else {
      out += c;
      i++;
    }
  }
  throw new Error('key "' + k + '": a quoted string is not closed');
}

function parseStringValue(k, v) {
  if (v.charCodeAt(0) === 34) return parseQuoted(k, v); // '"'
  if (v.charCodeAt(0) === 91) throw new Error('key "' + k + '": a bare string opens on ['); // '['
  return v;
}

function parseTagsValue(v) {
  if (v.length < 2 || v.charCodeAt(0) !== 91 || v.charCodeAt(v.length - 1) !== 93) {
    throw new Error('key "tags": not a list [a, b]');
  }
  const inside = v.slice(1, -1);
  if (inside.trim() === '') return [];
  const parts = inside.split(',');
  const names = [];
  for (let p of parts) {
    p = p.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (p === '' || p.indexOf('"') !== -1 || p.indexOf('[') !== -1 || p.indexOf(']') !== -1) {
      throw new Error('key "tags": an empty tag, or one holding " [ or ]');
    }
    names.push(p);
  }
  return names;
}

// Parses front matter of one source. `lines` is the source's lines (after
// \r\n normalisation). Returns {data, body} or {error}.
function parseFrontMatter(lines) {
  if (lines.length === 0 || lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let j = 1; j < lines.length; j++) {
    if (lines[j] === '---') { close = j; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const seen = new Set();
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line)) continue; // blank
    if (line.charCodeAt(0) === 35) continue; // comment '#'
    const m = FM_KEY_RE.exec(line);
    if (!m) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const k = m[1];
    if (k !== 'title' && k !== 'summary' && k !== 'date' && k !== 'tags' &&
        k !== 'draft' && k !== 'layout' && k !== 'slug') {
      return { error: 'unknown key "' + k + '"' };
    }
    if (seen.has(k)) return { error: 'key "' + k + '" is given twice' };
    seen.add(k);
    let v = m[2] === undefined ? '' : m[2].replace(/[ \t]+$/, '');
    if (v === '') return { error: 'key "' + k + '" has no value' };
    try {
      if (k === 'title' || k === 'summary') data[k] = parseStringValue(k, v);
      else if (k === 'date') {
        if (!validDate(v)) throw new Error('key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
        data[k] = v;
      } else if (k === 'tags') data[k] = parseTagsValue(v);
      else if (k === 'draft') {
        if (v !== 'true' && v !== 'false') throw new Error('key "draft": true or false');
        data[k] = v === 'true';
      } else if (k === 'layout') {
        if (!LAYOUT_RE.test(v)) throw new Error('key "layout": not a template name');
        data[k] = v;
      } else if (k === 'slug') {
        if (v.length > 64 || !SLUG_KEY_RE.test(v)) throw new Error('key "slug": not a slug');
        data[k] = v;
      }
    } catch (e) {
      return { error: e.message };
    }
  }
  if (!seen.has('title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------- markdown ----------

const FENCE_RE = /^```([A-Za-z0-9_+\-]*)[ \t]*$/;
const CLOSE_FENCE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const BREAK_RE = /^(---|\*\*\*)[ \t]*$/;
const ORDERED_RE = /^(\d{1,9})\. /;
const BLANK_RE = /^[ \t]*$/;
const WS_RE = /\s/;

function isBlank(line) { return BLANK_RE.test(line); }
function trimLine(l) { return l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''); }

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function resolveLink(target, B, srcDir, srcPath) {
  const c0 = target.charCodeAt(0);
  if (SCHEME_RE.test(target) || c0 === 47 || c0 === 35) return target; // scheme, '/', '#'
  const hash = target.indexOf('#');
  const pathPart = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const out = srcDir === '' ? [] : srcDir.split('/');
  const segs = pathPart.split('/');
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) {
        B.broken.add('broken-link ' + srcPath + ' -> ' + target);
        return target;
      }
      out.pop();
    } else out.push(seg);
  }
  const resolved = out.join('/');
  const page = B.sourcePathMap.get(resolved);
  if (page !== undefined) return page.url + frag;
  if (B.staticPathSet.has(resolved)) return B.base + '/' + resolved + frag;
  B.broken.add('broken-link ' + srcPath + ' -> ' + target);
  return target;
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
function isEscapable(c) { return ESCAPABLE.has(c); }

function findStrongClose(s, from) {
  let j = from;
  const n = s.length;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && isEscapable(s[j + 1])) { j += 2; continue; }
    if (c === '*' && s[j + 1] === '*') return j;
    j++;
  }
  return -1;
}

function findEmClose(s, from) {
  let j = from;
  const n = s.length;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && isEscapable(s[j + 1])) { j += 2; continue; }
    if (c === '*') {
      if (s[j + 1] === '*') { j += 2; continue; }
      if (j > from) return j;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

function findBracketClose(s, from) {
  let j = from;
  const n = s.length;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && isEscapable(s[j + 1])) { j += 2; continue; }
    if (c === ']') return j;
    j++;
  }
  return -1;
}

const INLINE_SPECIAL = /[\\`*\[]/g;

function inlineRender(s, B, srcDir, srcPath) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m ? m.index : n;
    if (j > i) { out += esc(s.slice(i, j)); i = j; }
    if (i >= n) break;
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && isEscapable(nx)) { out += esc(nx); i += 2; }
      else { out += '\\'; i += 1; }
    } else if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) { out += '<code>' + esc(s.slice(i + 1, k)) + '</code>'; i = k + 1; }
      else { out += '`'; i += 1; }
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findStrongClose(s, i + 2);
        if (k > i + 2) {
          out += '<strong>' + inlineRender(s.slice(i + 2, k), B, srcDir, srcPath) + '</strong>';
          i = k + 2;
        } else { out += '**'; i += 2; }
      } else {
        const k = findEmClose(s, i + 1);
        if (k > i + 1) {
          out += '<em>' + inlineRender(s.slice(i + 1, k), B, srcDir, srcPath) + '</em>';
          i = k + 1;
        } else { out += '*'; i += 1; }
      }
    } else if (c === '[') {
      const k = findBracketClose(s, i + 1);
      let done = false;
      if (k !== -1 && s[k + 1] === '(') {
        const p = s.indexOf(')', k + 2);
        if (p !== -1) {
          const target = s.slice(k + 2, p);
          if (target !== '' && !WS_RE.test(target)) {
            const href = resolveLink(target, B, srcDir, srcPath);
            out += '<a href="' + esc(href) + '">' + inlineRender(s.slice(i + 1, k), B, srcDir, srcPath) + '</a>';
            i = p + 1;
            done = true;
          }
        }
      }
      if (!done) { out += '['; i += 1; }
    } else {
      out += esc(c);
      i += 1;
    }
  }
  return out;
}

function endsParagraph(l) {
  if (isBlank(l)) return true;
  const d0 = l.charCodeAt(0);
  if (d0 === 96 && l.charCodeAt(1) === 96 && l.charCodeAt(2) === 96 && FENCE_RE.test(l)) return true;
  if (d0 === 35) {
    const m = HEADING_RE.exec(l);
    if (m && m[2].replace(/[ \t]+$/, '') !== '') return true;
  }
  if ((d0 === 45 || d0 === 42) && BREAK_RE.test(l)) return true;
  return false;
}

function tryList(lines, start, B, srcDir, srcPath) {
  const first = lines[start];
  let kind;
  let startNum = 0;
  let text;
  const c0 = first.charCodeAt(0);
  if (c0 === 45 || c0 === 42) {
    if (first.charCodeAt(1) !== 32) return null;
    kind = 'ul';
    text = first.slice(2);
  } else {
    const m = ORDERED_RE.exec(first);
    if (!m) return null;
    kind = 'ol';
    startNum = parseInt(m[1], 10);
    text = first.slice(m[0].length);
  }
  const items = [[text]];
  let i = start + 1;
  const n = lines.length;
  while (i < n) {
    const l = lines[i];
    if (kind === 'ul') {
      const c = l.charCodeAt(0);
      if ((c === 45 || c === 42) && l.charCodeAt(1) === 32) {
        items.push([l.slice(2)]);
        i++;
        continue;
      }
    } else {
      const m = ORDERED_RE.exec(l);
      if (m) {
        items.push([l.slice(m[0].length)]);
        i++;
        continue;
      }
    }
    if (/^ {2,}[^ \t]/.test(l)) {
      items[items.length - 1].push(trimLine(l));
      i++;
      continue;
    }
    break;
  }
  let html = kind === 'ul' ? '<ul>\n' : (startNum === 1 ? '<ol>\n' : '<ol start="' + startNum + '">\n');
  for (let k = 0; k < items.length; k++) {
    html += '<li>' + inlineRender(items[k].join('\n'), B, srcDir, srcPath) + '</li>\n';
  }
  html += kind === 'ul' ? '</ul>\n' : '</ol>\n';
  return { html, next: i };
}

function renderMarkdown(body, B, srcPath, srcDir) {
  const lines = body.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const headingIds = new Set();
  let excerpt = '';
  let excerptDone = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const c0 = line.charCodeAt(0);
    // fence
    if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      const m = FENCE_RE.exec(line);
      if (m) {
        const lang = m[1];
        let code = '<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>';
        i++;
        while (i < n && !CLOSE_FENCE_RE.test(lines[i])) { code += esc(lines[i]) + '\n'; i++; }
        if (i < n) i++;
        code += '</code></pre>\n';
        out.push(code);
        continue;
      }
    }
    // heading
    if (c0 === 35) {
      const m = HEADING_RE.exec(line);
      if (m) {
        const text = m[2].replace(/[ \t]+$/, '');
        if (text !== '') {
          const level = m[1].length;
          const id = uniqueSlug(slugify(text, B.slugCache), headingIds);
          const html = inlineRender(text, B, srcDir, srcPath);
          out.push('<h' + level + ' id="' + id + '">' + html + '</h' + level + '>\n');
          if (level === 2 || level === 3) toc.push({ level, id, html });
          i++;
          continue;
        }
      }
    }
    // thematic break
    if ((c0 === 45 || c0 === 42) && BREAK_RE.test(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    // blockquote
    if (c0 === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') parts.push(l);
        i++;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>' + inlineRender(parts.join('\n'), B, srcDir, srcPath) + '</p>\n</blockquote>\n');
      continue;
    }
    // list
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const list = tryList(lines, i, B, srcDir, srcPath);
      if (list) { out.push(list.html); i = list.next; continue; }
    }
    // paragraph
    const parts = [];
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const html = inlineRender(parts.join('\n'), B, srcDir, srcPath);
    out.push('<p>' + html + '</p>\n');
    if (!excerptDone) { excerpt = html; excerptDone = true; }
  }
  return { html: out.join(''), toc, excerpt };
}

// ---------- templates ----------

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
function isValidPath(p) { return PATH_RE.test(p); }

function tokenizeTemplate(name, src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  let textBuf = '';
  const flush = () => {
    if (textBuf !== '') { tokens.push({ t: 'text', s: textBuf }); textBuf = ''; }
  };
  while (i < n) {
    const ch = src[i];
    if (ch !== '{') { textBuf += ch; i++; continue; }
    const nx = src[i + 1];
    if (nx !== '{' && nx !== '%') { textBuf += ch; i++; continue; }
    if (nx === '{') {
      const raw = src[i + 2] === '{';
      const openLen = raw ? 3 : 2;
      const close = raw ? '}}}' : '}}';
      const k = src.indexOf(close, i + openLen);
      if (k === -1) {
        throw new Error('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      }
      const pathText = src.slice(i + openLen, k).trim();
      flush();
      tokens.push({ t: 'var', path: pathText, raw });
      i = k + close.length;
    } else {
      const k = src.indexOf('%}', i + 2);
      if (k === -1) throw new Error('template "' + name + '": a {% is not closed');
      const tagText = src.slice(i + 2, k).trim();
      const lineStart = src.lastIndexOf('\n', i - 1) + 1;
      const beforePart = src.slice(lineStart, i);
      const nlAfter = src.indexOf('\n', k + 2);
      const afterPart = nlAfter === -1 ? src.slice(k + 2) : src.slice(k + 2, nlAfter);
      const standalone = /^[ \t]*$/.test(beforePart) && /^[ \t]*$/.test(afterPart);
      if (standalone) {
        const lastNl = textBuf.lastIndexOf('\n');
        textBuf = lastNl === -1 ? '' : textBuf.slice(0, lastNl + 1);
        flush();
        tokens.push({ t: 'tag', text: tagText });
        i = nlAfter === -1 ? n : nlAfter + 1;
      } else {
        flush();
        tokens.push({ t: 'tag', text: tagText });
        i = k + 2;
      }
    }
  }
  flush();
  return tokens;
}

function parseTemplate(name, tokens) {
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  const cur = () => stack[stack.length - 1].body;
  for (const tok of tokens) {
    if (tok.t === 'text') { cur().push({ t: 'text', s: tok.s }); continue; }
    if (tok.t === 'var') {
      if (!isValidPath(tok.path)) {
        throw new Error('template "' + name + '": ' + JSON.stringify(tok.path) + ' is not a path');
      }
      cur().push({ t: 'var', parts: tok.path.split('.'), raw: tok.raw });
      continue;
    }
    const text = tok.text;
    let m = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)$/.exec(text);
    if (m) {
      const node = { t: 'for', name: m[1], parts: m[2].split('.'), body: [] };
      cur().push(node);
      stack.push({ kind: 'for', node, body: node.body });
      continue;
    }
    m = /^if\s+(not\s+)?([A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)$/.exec(text);
    if (m) {
      const node = { t: 'if', parts: m[2].split('.'), neg: !!m[1], then: [], els: null };
      cur().push(node);
      stack.push({ kind: 'if', node, body: node.then, inElse: false });
      continue;
    }
    if (text === 'else') {
      const f = stack[stack.length - 1];
      if (f.kind !== 'if' || f.inElse) {
        throw new Error('template "' + name + '": an else outside an if');
      }
      f.node.els = [];
      f.body = f.node.els;
      f.inElse = true;
      continue;
    }
    if (text === 'endfor') {
      const f = stack[stack.length - 1];
      if (f.kind !== 'for') throw new Error('template "' + name + '": an endfor with no open for');
      stack.pop();
      continue;
    }
    if (text === 'endif') {
      const f = stack[stack.length - 1];
      if (f.kind !== 'if') throw new Error('template "' + name + '": an endif with no open if');
      stack.pop();
      continue;
    }
    m = /^include\s+"([^"]*)"$/.exec(text);
    if (m) { cur().push({ t: 'include', name: m[1] }); continue; }
    throw new Error('template "' + name + '": {% ' + text + ' %} is not a tag');
  }
  if (stack.length > 1) {
    const f = stack[stack.length - 1];
    if (f.kind === 'for') throw new Error('template "' + name + '": a for is not closed');
    throw new Error('template "' + name + '": a if is not closed');
  }
  return root;
}

function g2(o, p) {
  return (o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, p)) ? o[p] : undefined;
}

function g3(o, p, q) {
  const v = g2(o, p);
  return (v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, q)) ? v[q] : undefined;
}

function gAll(ctx, parts) {
  let v = ctx[parts[0]];
  for (let k = 1; k < parts.length; k++) {
    if (v === null || typeof v !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(v, parts[k])) return undefined;
    v = v[parts[k]];
  }
  return v;
}

function writeValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += writeValue(v[k]);
    }
    return s;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const HELPERS = { esc, writeValue, truthy, g2, g3, gAll };

function pathExpr(parts) {
  const first = JSON.stringify(parts[0]);
  if (parts.length === 1) return 'ctx[' + first + ']';
  if (parts.length === 2) return 'H.g2(ctx[' + first + '],' + JSON.stringify(parts[1]) + ')';
  if (parts.length === 3) return 'H.g3(ctx[' + first + '],' + JSON.stringify(parts[1]) + ',' + JSON.stringify(parts[2]) + ')';
  return 'H.gAll(ctx,' + JSON.stringify(parts) + ')';
}

// Compiles a parsed template (node tree) into a render function once per
// case. The generated code uses direct property access on a flat scope
// object (for-bodies mutate it, saving and restoring shadowed names).
function compileTemplate(nodes) {
  let code = '';
  const gen = (list) => {
    for (let n = 0; n < list.length; n++) {
      const node = list[n];
      if (node.t === 'text') {
        code += 'out.push(' + JSON.stringify(node.s) + ');\n';
      } else if (node.t === 'var') {
        const e = pathExpr(node.parts);
        code += node.raw
          ? 'out.push(H.writeValue(' + e + '));\n'
          : 'out.push(H.esc(H.writeValue(' + e + ')));\n';
      } else if (node.t === 'for') {
        const arr = pathExpr(node.parts);
        const nm = JSON.stringify(node.name);
        code += '{\nconst __a=' + arr + ';\nif(Array.isArray(__a)){\n';
        code += 'const __hp=' + nm + ' in ctx;const __pp=ctx[' + nm + '];\n';
        code += 'const __hl="loop" in ctx;const __pl=ctx["loop"];\n';
        code += 'const __loop={index:0,first:false,last:false,length:__a.length};\n';
        code += 'for(let __k=0;__k<__a.length;__k++){\n';
        code += 'ctx[' + nm + ']=__a[__k];ctx["loop"]=__loop;';
        code += '__loop.index=__k+1;__loop.first=__k===0;__loop.last=__k===__a.length-1;\n';
        gen(node.body);
        code += '}\n';
        code += 'if(__hp)ctx[' + nm + ']=__pp;else delete ctx[' + nm + '];\n';
        code += 'if(__hl)ctx["loop"]=__pl;else delete ctx["loop"];\n';
        code += '}\n}\n';
      } else if (node.t === 'if') {
        const e = pathExpr(node.parts);
        code += 'if(' + (node.neg ? '!' : '') + 'H.truthy(' + e + ')){\n';
        gen(node.then);
        code += '}';
        if (node.els) { code += 'else{\n'; gen(node.els); code += '}'; }
        code += '\n';
      } else if (node.t === 'include') {
        code += 'if(depth<8){const __t=B.compiled.get(' + JSON.stringify(node.name) + ');if(__t)__t(ctx,out,B,depth+1,H);}\n';
      }
    }
  };
  gen(nodes);
  return new Function('ctx', 'out', 'B', 'depth', 'H', code);
}

// ---------- build ----------

function dirOf(path) {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
}

export function run(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');
  const B = {
    base,
    report: [],
    broken: new Set(),
    parsedTemplates: new Map(),
    compiled: new Map(),
    sourcePathMap: new Map(),
    staticPathSet: new Set(),
    slugCache: new Map(),
  };

  // 1. sources, sorted by path in code-unit order
  const files = input.files.slice();
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, content: f.content.replace(/\r\n?/g, '\n') });
    } else {
      statics.push(f);
      B.staticPathSet.add(f.path);
    }
  }

  // 2. templates, in code-unit order of name
  const tNames = Object.keys(input.templates).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of tNames) {
    try {
      const nodes = parseTemplate(name, tokenizeTemplate(name, input.templates[name]));
      B.parsedTemplates.set(name, nodes);
      B.compiled.set(name, compileTemplate(nodes));
    } catch (e) {
      B.report.push(e.message);
    }
  }

  // 3. front matter + checks, in sorted-path order
  const kept = [];
  for (const src of sources) {
    const lines = src.content.split('\n');
    const fm = parseFrontMatter(lines);
    if (fm.error) {
      B.report.push('refused ' + src.path + ': ' + fm.error);
      continue;
    }
    const isPost = src.path.startsWith('posts/');
    const data = fm.data;
    if (src.path.startsWith('tags/')) {
      B.report.push('refused ' + src.path + ': tags/ is the generator\'s own');
      continue;
    }
    if (src.path.startsWith('page/')) {
      B.report.push('refused ' + src.path + ': page/ is the generator\'s own');
      continue;
    }
    if (isPost && !data.date) {
      B.report.push('refused ' + src.path + ': a post needs a date');
      continue;
    }
    const layout = data.layout || (isPost ? 'post' : 'page');
    if (!B.parsedTemplates.has(layout)) {
      B.report.push('refused ' + src.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    if (data.draft === true) {
      B.report.push('draft ' + src.path);
      continue;
    }
    kept.push({
      path: src.path,
      isPost,
      dir: isPost ? 'posts' : dirOf(src.path),
      title: data.title,
      summary: data.summary || '',
      date: data.date || '',
      tagNames: data.tags || [],
      layout,
      slugKey: data.slug || '',
      body: fm.body,
    });
  }

  // 4. permalinks, in source order
  const takenByDir = new Map();
  takenByDir.set('', new Set(['posts', 'tags', 'page']));
  for (const p of kept) {
    let taken = takenByDir.get(p.dir);
    if (!taken) { taken = new Set(); takenByDir.set(p.dir, taken); }
    const baseSlug = p.slugKey !== '' ? p.slugKey : slugify(p.title, B.slugCache);
    p.slug = uniqueSlug(baseSlug, taken);
    p.outPath = p.dir === '' ? p.slug + '/index.html' : p.dir + '/' + p.slug + '/index.html';
    p.url = p.dir === '' ? base + '/' + p.slug + '/' : base + '/' + p.dir + '/' + p.slug + '/';
    B.sourcePathMap.set(p.path, p);
  }

  // 5. markdown
  for (const p of kept) {
    const md = renderMarkdown(p.body, B, p.path, dirOf(p.path));
    p.content = md.html;
    p.toc = md.toc;
    p.excerpt = md.excerpt;
    p.readingMinutes = readingMinutes(p.body);
  }

  // 6. collections
  const posts = [];
  for (const p of kept) if (p.isPost) posts.push(p);
  posts.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
    return 0;
  });
  // each source's tags, deduped by slug, first spelling kept, own order
  for (const p of kept) {
    const seen = new Set();
    const list = [];
    for (const name of p.tagNames) {
      const slug = slugify(name, B.slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      list.push({ name, slug });
    }
    p.tagList = list;
  }
  // tag map from posts in collection order
  const tagMap = new Map();
  for (const post of posts) {
    for (const t of post.tagList) {
      let tag = tagMap.get(t.slug);
      if (!tag) {
        tag = { name: t.name, slug: t.slug, url: base + '/tags/' + t.slug + '/', posts: [] };
        tagMap.set(t.slug, tag);
      }
      tag.posts.push(post);
    }
  }
  const tags = [...tagMap.values()];
  tags.sort((a, b) => {
    if (a.posts.length !== b.posts.length) return b.posts.length - a.posts.length;
    if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
    return 0;
  });
  const tagsList = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  // cards (8 fields)
  const cardCache = new Map();
  function cardOf(p) {
    let c = cardCache.get(p.path);
    if (!c) {
      c = {
        title: p.title,
        url: p.url,
        date: p.date,
        date_long: dateLong(p.date),
        summary: p.summary,
        excerpt: p.excerpt,
        reading_minutes: p.readingMinutes,
        tags: p.tagList.map((t) => {
          const tag = tagMap.get(t.slug);
          return { name: tag ? tag.name : t.name, slug: t.slug, url: tag ? tag.url : '' };
        }),
      };
      cardCache.set(p.path, c);
    }
    return c;
  }
  // page objects (card + extras)
  const pageObj = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const newer = i > 0 ? posts[i - 1] : null;
    const older = i < posts.length - 1 ? posts[i + 1] : null;
    const po = Object.assign({}, cardOf(p), {
      slug: p.slug,
      content: p.content,
      toc: p.toc,
      newer: newer ? { title: newer.title, url: newer.url, date: newer.date, date_long: dateLong(newer.date) } : null,
      older: older ? { title: older.title, url: older.url, date: older.date, date_long: dateLong(older.date) } : null,
      is_post: true,
    });
    pageObj.set(p.path, po);
  }
  for (const p of kept) {
    if (p.isPost) continue;
    const po = Object.assign({}, cardOf(p), {
      slug: p.slug,
      content: p.content,
      toc: p.toc,
      newer: null,
      older: null,
      is_post: false,
    });
    pageObj.set(p.path, po);
  }
  const recentCards = posts.slice(0, site.recent).map(cardOf);
  const siteObj = { title: site.title, base_url: base };

  // 7. render pages
  const out = {};
  for (const p of kept) {
    const fn = B.compiled.get(p.layout);
    const scope = Object.create(null);
    scope.site = siteObj;
    scope.tags = tagsList;
    scope.recent = recentCards;
    scope.page = pageObj.get(p.path);
    const buf = [];
    fn(scope, buf, B, 0, HELPERS);
    out[p.outPath] = buf.join('');
  }
  // index pages
  const perPage = site.per_page;
  const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
  const indexFn = B.compiled.get('index');
  if (indexFn) {
    for (let k = 1; k <= totalPages; k++) {
      const chunk = posts.slice((k - 1) * perPage, k * perPage);
      const pager = {
        number: k,
        total: totalPages,
        url: k === 1 ? base + '/' : base + '/page/' + k + '/',
        newer_url: k === 1 ? '' : (k === 2 ? base + '/' : base + '/page/' + (k - 1) + '/'),
        older_url: k === totalPages ? '' : base + '/page/' + (k + 1) + '/',
      };
      const scope = Object.create(null);
      scope.site = siteObj;
      scope.tags = tagsList;
      scope.recent = recentCards;
      scope.posts = chunk.map(cardOf);
      scope.pager = pager;
      const buf = [];
      indexFn(scope, buf, B, 0, HELPERS);
      out[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = buf.join('');
    }
  }
  // tag pages
  const tagFn = B.compiled.get('tag');
  if (tagFn) {
    for (const t of tags) {
      const scope = Object.create(null);
      scope.site = siteObj;
      scope.tags = tagsList;
      scope.recent = recentCards;
      scope.tag = {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map(cardOf),
      };
      const buf = [];
      tagFn(scope, buf, B, 0, HELPERS);
      out['tags/' + t.slug + '/index.html'] = buf.join('');
    }
  }
  // tags index
  const tagsFn = B.compiled.get('tags');
  if (tagsFn) {
    const scope = Object.create(null);
    scope.site = siteObj;
    scope.tags = tagsList;
    scope.recent = recentCards;
    const buf = [];
    tagsFn(scope, buf, B, 0, HELPERS);
    out['tags/index.html'] = buf.join('');
  }

  // 8. statics
  const builtPaths = new Set(Object.keys(out));
  let pageCount = 0;
  let postCount = 0;
  for (const p of kept) { if (p.isPost) postCount++; else pageCount++; }
  for (const f of statics) {
    if (builtPaths.has(f.path)) {
      B.report.push('shadowed ' + f.path + ': a built page has its path');
      continue;
    }
    out[f.path] = f.content;
  }

  // 9. report
  const lines = B.report.concat([...B.broken]);
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const counts = 'built ' + pageCount + ' pages, ' + postCount + ' posts, ' + tags.length +
    ' tags and ' + statics.length + ' static files';
  out['build-report.txt'] = (lines.length ? lines.map((l) => l + '\n').join('') : '') + counts + '\n';
  return out;
}
