// 极简的 C/C++/Python 着色：注释、字符串、预处理、关键字、数字。输出已转义的 HTML。
const KEYWORDS = new Set(
  'alignas alignof and auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit extern false float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while def elif except finally from import in is lambda None pass raise True False with yield as assert global nonlocal print self'.split(
    ' ',
  ),
);
const TYPES = new Set('vector string map set unordered_map unordered_set pair array deque queue priority_queue stack bitset tuple size_t ll ull i64 u64 i128'.split(' '));
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?[uUlLfF]*\b|\b[A-Za-z_]\w*\b)/g;

const escape = (text) => text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);

export function highlight(source, language = 'C++') {
  const python = /python/i.test(language);
  let html = '';
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    const token = match[0];
    html += escape(source.slice(last, match.index));
    last = match.index + token.length;
    let kind = null;
    if (token.startsWith('//') || token.startsWith('/*') || (python && token.startsWith('#'))) kind = 'comment';
    else if (token.startsWith('#')) kind = 'meta';
    else if (token[0] === '"' || token[0] === "'") kind = 'string';
    else if (/^\d|^0x/.test(token)) kind = 'number';
    else if (KEYWORDS.has(token)) kind = 'keyword';
    else if (TYPES.has(token)) kind = 'type';
    html += kind ? `<span class="tok-${kind}">${escape(token)}</span>` : escape(token);
  }
  return html + escape(source.slice(last));
}
