'use strict';
/**
 * 夹具可解析守卫（批次 48）。
 *
 * 要拦的事：`tools/browser-e2e.js` 的夹具 HTML 里写了一段**浏览器解析不了的程序**。
 * 它是批次 47 实测漏掉的一族 —— `/frame-sig` 那枚空帧的 `src` 被写成
 * `javascript:void(function(){document.open`，因为**现场日志里那 40 个字符是
 * `String(src).slice(0, 40)` 的摘录长度**，不是页面真串。浏览器一解析就是
 * `SyntaxError: Unexpected end of input`。
 *
 * ⚠️ 为什么不能只靠"跑一遍看有没有异常"：批次 47 反向验证给出的正是**否证** ——
 * 把坏形状注回去，沙盒那条「场景结束无未捕获页面异常」读到 3 秒仍是 `pageErrors:0`
 * （那一族导航异常压根没抛，或被随后的 `document.open()` 吞掉），可它在 `--full` 里红过。
 * 所以这一族只能在**发 HTML 的那一刻**量，不能等浏览器回报。
 *
 * 覆盖范围（说清楚，别让人以为它什么都管）：
 *   1. 内联 `<script>` 体（带 `src` 的、`type` 是 json/template 一类的不算程序）；
 *   2. `src=` / `href=` 里协议是 `javascript:` 的属性值（按浏览器那样先解一次实体）。
 * 不覆盖：`document.write` 现场拼出来的脚本、事件处理器属性（`onclick="…"`）里的程序。
 */

var vm = require('vm');

var NAMED_ENTITIES = {
  '&quot;': '"',
  '&#34;': '"',
  '&#x22;': '"',
  '&#X22;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&#x27;': "'",
  '&#X27;': "'",
  '&lt;': '<',
  '&#60;': '<',
  '&gt;': '>',
  '&#62;': '>',
  '&nbsp;': ' '
};

/** 属性值里的实体：浏览器解析属性时会解一次（`&amp;` 放最后，防止二次解码）。 */
function decodeEntities(value) {
  return String(value)
    .replace(/&(?:quot|#34|#x22|apos|#39|#x27|lt|#60|gt|#62|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, function (m) {
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, m)) return NAMED_ENTITIES[m];
      var low = m.toLowerCase();
      if (/^&#x/.test(low)) return String.fromCodePoint(parseInt(low.slice(3, -1), 16));
      return String.fromCodePoint(parseInt(low.slice(2, -1), 10));
    })
    .replace(/&amp;/g, '&');
}

function attrValue(chunk) {
  var first = chunk.charAt(0);
  if ((first === '"' || first === "'") && chunk.charAt(chunk.length - 1) === first) {
    return chunk.slice(1, -1);
  }
  return chunk;
}

/** 试解析一段程序；返回 null（能解析）或错误串。 */
function parseError(body, label) {
  if (!String(body).trim()) return null;
  try {
    new vm.Script(body, { filename: label });
    return null;
  } catch (e) {
    return String(e && e.message ? e.message : e).split('\n')[0].slice(0, 120);
  }
}

/** 内联 `<script>` 体。 */
function inlineScripts(html) {
  var out = [];
  var re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  var m;
  while ((m = re.exec(html))) {
    var attrs = m[1] || '';
    var body = m[2] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    var typeMatch = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    var type = ((typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])) || '').toLowerCase();
    // 没有 type，或明确是 JS 的，才当程序解析；json / ld+json / template 等跳过。
    if (type && !/^(text|application)\/(java|ecma)script$/.test(type)) continue;
    out.push({ kind: 'inline <script>', body: body });
  }
  return out;
}

/** `javascript:` 协议的属性值（夹具用 iframe 的 src 造跨域帧与"真·空帧"）。 */
function javascriptUrls(html) {
  var out = [];
  var re = /\b(?:src|href|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  var m;
  while ((m = re.exec(html))) {
    var value = decodeEntities(attrValue(m[1])).trim();
    if (/^javascript:/i.test(value)) {
      out.push({ kind: 'javascript: URL', body: value.replace(/^javascript:/i, '') });
    }
  }
  return out;
}

/**
 * 扫一份夹具 HTML。
 * @returns {string[]} 问题清单（空数组 = 这一页每个程序都能解析）
 */
function problemsIn(label, html) {
  var text = String(html == null ? '' : html);
  var found = inlineScripts(text).concat(javascriptUrls(text));
  var problems = [];
  found.forEach(function (item, i) {
    var err = parseError(item.body, label + '#' + i);
    if (err) {
      problems.push(label + ' 第 ' + (i + 1) + ' 段' + item.kind +
        ' 浏览器解析不了：' + err + ' —— 程序开头是 ' +
        JSON.stringify(String(item.body).replace(/\s+/g, ' ').slice(0, 70)));
    }
  });
  return problems;
}

/** 扫一整张 MOCK_PAGES 表（path → 生成 HTML 的函数）。 */
function validatePages(pages) {
  var problems = [];
  Object.keys(pages || {}).forEach(function (urlPath) {
    var html = '';
    try {
      html = pages[urlPath]();
    } catch (e) {
      problems.push(urlPath + ' 夹具生成阶段就抛了：' + String((e && e.message) || e).slice(0, 120));
      return;
    }
    problems = problems.concat(problemsIn(urlPath, html));
  });
  return problems;
}

module.exports = { problemsIn: problemsIn, validatePages: validatePages, parseError: parseError };
