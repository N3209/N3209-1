'use strict';

/* =========================================================================
   六法 — e-Gov 法令API を直接読む、端末内完結の法令ビューア

   アンカー（注釈の位置識別子）の形:
     <scope>/<条>/<項>/<号>       末尾の空要素は省略する
     scope は本則が "M"、附則が "S1" "S2" …
     条番号は e-Gov の Article@Num をそのまま使う（枝番は "3_2" = 第三条の二）
   例: M/709      民法709条
       M/709/1    同1項
       M/398_2/2/3  第三百九十八条の二 第2項 第3号
       S1//3      附則1 第3項（条を介さず項が並ぶ場合は条の位置を空にする）
   ========================================================================= */

const API = 'https://laws.e-gov.go.jp/api/2';

/* ---------------------------------------------------------------- 小道具 */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/** 検索用の正規化。全角・半角や大小の違いを吸収する。 */
function normalize(s) {
  return String(s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

const KANJI_DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNIT = { 十: 10, 百: 100, 千: 1000 };
const NUM_SRC = '(\\d+|[〇零一二三四五六七八九十百千]+)';

/** 漢数字を算用数字に。「七百九」も「七〇九」も通す。 */
function kanjiToNum(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (!s || [...s].some(c => !(c in KANJI_DIGIT) && !(c in KANJI_UNIT))) return NaN;
  if (![...s].some(c => c in KANJI_UNIT)) {
    let n = 0;                       // 位取り表記（七〇九）
    for (const c of s) n = n * 10 + KANJI_DIGIT[c];
    return n;
  }
  let total = 0, cur = 0;
  for (const c of s) {
    if (c in KANJI_DIGIT) cur = cur * 10 + KANJI_DIGIT[c];
    else { total += (cur || 1) * KANJI_UNIT[c]; cur = 0; }
  }
  return total + cur;
}

/**
 * 枝番は「第398条の2」の語順にする（「第398の2条」では読みにくい）。
 * e-Gov は削除された条の範囲を "170:174" の形で表すので、それも展開する。
 */
function numLabel(num, unit) {
  const s = String(num);
  if (s.includes(':')) return s.split(':').map(x => numLabel(x, unit)).join('〜');
  const parts = s.split('_');
  return '第' + parts[0] + unit + parts.slice(1).map(p => 'の' + p).join('');
}

const FULLWIDTH_DIGITS = '０１２３４５６７８９';
const toFullWidth = n => String(n).replace(/\d/g, d => FULLWIDTH_DIGITS[+d]);

/** ①〜㊿。範囲外は null。 */
function circledNum(n) {
  if (n >= 1 && n <= 20) return String.fromCharCode(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCharCode(0x3251 + n - 21);
  if (n >= 36 && n <= 50) return String.fromCharCode(0x32b1 + n - 36);
  return null;
}

/**
 * 項番号の表示文字を決める。第1項は表示しないのが慣例。
 *
 * e-Gov の <ParagraphNum> は法令によって空になる。空になるのは Paragraph@OldNum="true"
 * が付いた古い法令で、その場合の正式な表記は丸数字（②③④）である。
 * 公的機関が配布している法令集の印刷物と突き合わせて確認した：
 *   刑訴220条・憲法9条・労基法32条 → ②③④
 *   民法715条・刑法36条・会社法423条 → ２３４（ParagraphNum に文字が入っている）
 * <ParagraphNum> に文字がある場合は常に全角数字で、丸数字が入ることはない。
 */
function paragraphNumLabel(pnumText, num, oldNum) {
  if (pnumText) return pnumText;
  const n = parseInt(num, 10);
  if (!Number.isFinite(n) || n < 2) return '';
  return oldNum ? (circledNum(n) || toFullWidth(n)) : toFullWidth(n);
}

/**
 * "170:174" のような範囲に n が含まれるか。
 * 枝番（"174_2"）は範囲に含めない。parseInt だと "174_2" が 174 になり、
 * 存在しない第174条の2を「削除された範囲」へ誤って案内してしまう。
 */
function numInRange(num, n) {
  const parts = String(num).split(':');
  if (parts.length !== 2) return false;
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(String(n))) return false;
  const v = Number(n);
  return v >= Number(parts[0]) && v <= Number(parts[1]);
}

function anchorLabel(anchor) {
  const parts = anchor.split('/');
  const units = ['条', '項', '号'];
  if (/^AP\d+$/.test(parts[0])) return '別表' + parts[0].slice(2);
  if (parts[0] === 'M/前文' || anchor === 'M/前文') return '前文';
  let s = parts[0] === 'M' ? '' : '附則' + parts[0].slice(1) + ' ';
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i]) continue;
    s += numLabel(parts[i], units[i - 1] || '');
  }
  return s;
}

/* ------------------------------------------------------------ IndexedDB */

const DB_NAME = 'roppo';
const DB_VER = 2;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('laws')) {
        db.createObjectStore('laws', { keyPath: 'lawId' });
      }
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'key' });
        s.createIndex('lawId', 'lawId', { unique: false });
        s.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      }
      // v2: 文言そのものに付ける注釈
      if (!db.objectStoreNames.contains('ranges')) {
        const s = db.createObjectStore('ranges', { keyPath: 'id' });
        s.createIndex('lawId', 'lawId', { unique: false });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function idbReq(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function txDone(t) {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onabort = t.onerror = () => rej(t.error || new Error('保存が中断されました'));
  });
}

async function read(name, fn) {
  const db = await openDB();
  return idbReq(fn(db.transaction(name, 'readonly').objectStore(name)));
}

/** 書き込みはトランザクションの完了まで待つ。リクエスト成功だけでは確定ではない。 */
async function write(name, fn) {
  const db = await openDB();
  const t = db.transaction(name, 'readwrite');
  const r = fn(t.objectStore(name));
  const [val] = await Promise.all([idbReq(r), txDone(t)]);
  return val;
}

const store = {
  allLaws: () => read('laws', s => s.getAll()),
  getLaw: id => read('laws', s => s.get(id)),
  putLaw: rec => write('laws', s => s.put(rec)),
  delLaw: id => write('laws', s => s.delete(id)),
  allNotes: () => read('notes', s => s.getAll()),
  putNote: rec => write('notes', s => s.put(rec)),
  delNote: key => write('notes', s => s.delete(key)),
  allRanges: () => read('ranges', s => s.getAll()),
  putRange: rec => write('ranges', s => s.put(rec)),
  delRange: id => write('ranges', s => s.delete(id)),
};

/* -------------------------------------------------------------- e-Gov API */

async function apiSearchLaws(title) {
  const r = await fetch(`${API}/laws?law_title=${encodeURIComponent(title)}&limit=50`);
  if (!r.ok) throw new Error('検索に失敗しました (' + r.status + ')');
  const d = await r.json();
  return (d.laws || d.items || []).map(it => ({
    lawId: (it.law_info || {}).law_id,
    lawNum: (it.law_info || {}).law_num,
    promulgationDate: (it.law_info || {}).promulgation_date,
    lawTitle: (it.revision_info || {}).law_title,
    lawTitleKana: (it.revision_info || {}).law_title_kana,
    abbrev: (it.revision_info || {}).abbrev,
    category: (it.revision_info || {}).category,
    updated: (it.revision_info || {}).updated,
    enforcementDate: (it.revision_info || {}).amendment_enforcement_date,
    lawRevisionId: (it.revision_info || {}).law_revision_id,
  })).filter(x => x.lawId);
}

/*
 * その法令の版の一覧。まだ施行されていない改正も入っている。
 * 例：民法は 2029-06-23 施行予定の改正が、いまの時点で返ってくる。
 */
async function apiRevisions(lawId) {
  const r = await fetch(`${API}/law_revisions/${encodeURIComponent(lawId)}`);
  if (!r.ok) throw new Error('版の一覧を取得できません (' + r.status + ')');
  const d = await r.json();
  return d.revisions || [];
}

async function apiFetchLaw(lawId) {
  const r = await fetch(`${API}/law_data/${encodeURIComponent(lawId)}?response_format=xml`);
  if (!r.ok) throw new Error('取得に失敗しました (' + r.status + ')');
  return await r.text();
}

function parseXML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XMLを解釈できませんでした');
  return doc;
}

function textOf(el, tag) {
  const c = el ? el.querySelector(':scope > ' + tag) : null;
  return c ? c.textContent.trim() : '';
}

/* ------------------------------------------------------------ 本文の描画 */

/** ルビの読み(Rt)を除いた素のテキスト。索引はHTMLからではなくXMLから作る。 */
function plainText(node, skip) {
  let s = '';
  for (const n of node.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { s += n.nodeValue; continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    if (n.tagName === 'Rt') continue;
    if (skip && skip.has(n.tagName)) continue;
    s += plainText(n, skip);
  }
  return s;
}

/* ------------------------------------------------------- 条文参照のリンク */

/*
 * 本文中の「第七百九条」などをリンクにする。
 * 間違ったリンクは、黙って違う条文へ飛ばすぶん、リンクが無いより有害である。
 * そこでここでは候補に印を付けるだけにして、実在の確認と行き先の決定は
 * 描画後の resolveRefs() で行う。解決できなかったものはリンクを外す。
 *
 * 「同条」「同法」「同項」は直前の文脈に依存し、取り違えの危険が大きいので扱わない。
 */
const KN = '[〇零一二三四五六七八九十百千]';
// 法令名らしき並び。これが直前にあれば他法令への参照とみなす（「同法」もここに入る）
// 「〜に関する法律」が最も多い形。法律 を先に置かないと「法」で切れて名前を取り逃す。
const LAWNAME_SRC = '[一-龥ぁ-んァ-ヶー々]{1,40}?(?:法律|法|政令|勅令|省令|府令|令|規則|条例|憲法)';
// 法令名と条番号のあいだには「（昭和五十四年法律第四号）」のような法令番号が入る。
// これを読み飛ばさないと、他法令への参照を自法令の条だと取り違える。
const REF_RE = new RegExp(
  `(${LAWNAME_SRC})?(（[^（）]{0,48}）)?第(${KN}+)条(?:の(${KN}+))?(?:の(${KN}+))?`
  + `(?:第(${KN}+)項)?(?:第(${KN}+)号)?`, 'g');
/*
 * 条番号を伴わない参照。
 *   前条第二項 / 前項第二号 / 第一項 / 第一項第二号
 * 「第二号」単独は入れない。「昭和五十四年法律第四号」のような法令番号に当たるため。
 */
/*
 * 文脈に依存して行き先を決められない参照。ここに当たる範囲は、
 * 条だけでなく後続の項・号まで丸ごとリンクの対象から外す。
 * 「附則第三条第二項」の「第二項」だけを拾って現在の条に結び付けてしまうため。
 */
const BLOCK_RE = new RegExp(
  `(?:附則|同条|同項|同号|同法|同令|同規則)`
  + `(?:第${KN}+条(?:の${KN}+)*)?(?:第${KN}+項)?(?:第${KN}+号)?`, 'g');

const DOUJOU_RE = new RegExp(`同条(?:第(${KN}+)項)?(?:第(${KN}+)号)?`, 'g');

/** 各文字が括弧の何重目にあるか。引用や括弧の出入りを見るのに使う。 */
function quoteDepth(text, open, close) {
  const d = new Array(text.length).fill(0);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === open) n++;
    d[i] = n;
    if (text[i] === close) n = Math.max(0, n - 1);
  }
  return d;
}

const REL_RE = new RegExp(
  `(前条|次条)(?:第(${KN}+)項)?(?:第(${KN}+)号)?`
  + `|(前項|次項)(?:第(${KN}+)号)?`
  + `|第(${KN}+)項(?:第(${KN}+)号)?`, 'g');

/** 参照らしき箇所に印を付けた HTML を返す。ctx は描画中の位置。 */
function linkifyText(raw, ctx) {
  const out = [];
  let last = 0;

  const marks = [];

  // 先に「触らない範囲」を決めておく
  const blocked = [];
  BLOCK_RE.lastIndex = 0;
  for (let m; (m = BLOCK_RE.exec(raw));) {
    blocked.push([m.index, m.index + m[0].length]);
  }
  const isBlocked = (a, b) => blocked.some(([s2, e2]) => a < e2 && s2 < b);

  REF_RE.lastIndex = 0;
  for (let m; (m = REF_RE.exec(raw));) {
    const [all, law, , art, br1, br2, par, item] = m;
    const parts = [kanjiToNum(art), br1 && kanjiToNum(br1), br2 && kanjiToNum(br2)]
      .filter(x => Number.isFinite(x));
    if (!parts.length) continue;
    if (!law && isBlocked(m.index, m.index + all.length)) continue;
    // 「において準用する商業登記法」から法令名の部分だけを切り出す
    const name = law ? trimLawName(law) : '';
    const cut = law ? law.length - name.length : 0;
    marks.push({
      start: m.index + cut, end: m.index + all.length, text: all.slice(cut),
      law: name,
      ref: [ctx.scope || 'M', parts.join('_'),
        par ? kanjiToNum(par) : '', item ? kanjiToNum(item) : ''].join('/'),
    });
  }
  REL_RE.lastIndex = 0;
  for (let m; (m = REL_RE.exec(raw));) {
    // 条番号の一部として既に拾っている箇所、文脈依存で外した箇所とは重ねない
    if (marks.some(k => m.index < k.end && k.start < m.index + m[0].length)) continue;
    if (isBlocked(m.index, m.index + m[0].length)) continue;
    let rel, par = '', item = '';
    if (m[1]) { rel = m[1]; par = m[2] ? kanjiToNum(m[2]) : ''; item = m[3] ? kanjiToNum(m[3]) : ''; }
    else if (m[4]) { rel = m[4]; item = m[5] ? kanjiToNum(m[5]) : ''; }
    else { rel = '項'; par = kanjiToNum(m[6]); item = m[7] ? kanjiToNum(m[7]) : ''; }
    marks.push({ start: m.index, end: m.index + m[0].length, text: m[0], rel, par, item });
  }
  if (!marks.length) return esc(raw);

  marks.sort((a, b) => a.start - b.start);

  /*
   * 列挙では2件目以降の法令名が省略される。
   *   「刑法第百三条、第百四条若しくは第百五条の二」→ 後ろ2つも刑法
   * これを引き継がないと、自法令に同じ番号があった場合に黙って別の法律へ飛ばす。
   * 引き継ぐのは、あいだに区切りらしい文字しか無いあいだだけにする。
   */
  for (let i = 1; i < marks.length; i++) {
    const cur = marks[i], prev = marks[i - 1];
    if (cur.rel || cur.law || !prev.law) continue;
    const between = raw.slice(prev.end, cur.start);
    if (!/^[、，及びならびに又はもしくは若しくは並びに・からまで乃至\s]*$/.test(between)) continue;
    cur.law = prev.law;
    cur.inherited = true;
  }


  /*
   * 「同条」を、本則に限って解決する。
   *
   *   第三十一条の二第一項の申出を受けた弁護士会は、同条第三項の…  → 31条の2
   *
   * 次のときは解決しない。誤って別の条へ飛ばすより出さない方がよい。
   *   ・附則の中（改正規定の裸の条番号は、改正対象の別法令を指す）
   *   ・直前の参照が他法令、または文脈依存で外した範囲（さらに前には戻らない）
   *   ・先行参照が引用「…」の中（読み替え規定は初版では扱わない）
   *   ・同じ Sentence の中に先行参照が無い
   */
  if ((ctx.scope || 'M') === 'M') {
    const qd = quoteDepth(raw, '「', '」');
    const pd = quoteDepth(raw, '（', '）');
    DOUJOU_RE.lastIndex = 0;
    for (let m; (m = DOUJOU_RE.exec(raw));) {
      const [all, par, item] = m;
      const pos = m.index;

      // 直前の条参照（法令名の引き継ぎ後の判定を使う）
      let ante = null;
      for (const k of marks) if (!k.rel && k.end <= pos && (!ante || k.end > ante.end)) ante = k;
      // 直前の「触らない範囲」。前条・次条も、解決先が別なので障壁として扱う。
      let bar = null;
      const raise = e => { if (e <= pos && (bar === null || e > bar)) bar = e; };
      for (const [, b1] of blocked) raise(b1);
      for (const k of marks) if (k.rel) raise(k.end);

      let src = ante;
      if (src && src.law) src = null;                       // 他法令を引き継いだ列挙
      if (src && bar !== null && bar > src.end) src = null;  // あいだに附則・前条などがある
      if (src && qd[src.start]) src = null;                  // 引用の中の条は使わない
      // 括弧の中で閉じた参照は外へ持ち出さない。外から中へ入るのは許す。
      if (src && pd[src.start] > pd[pos]) src = null;
      if (!src) continue;

      const art = String(src.ref || '').split('/')[1];
      if (!art) continue;
      marks.push({
        start: pos, end: pos + all.length, text: all, doujou: true,
        ref: ['M', art, par ? kanjiToNum(par) : '', item ? kanjiToNum(item) : ''].join('/'),
      });
    }
  }

  marks.sort((a, b) => a.start - b.start);

  for (const k of marks) {
    if (k.start < last) continue;
    out.push(esc(raw.slice(last, k.start)));
    const attrs = k.rel
      ? ` data-rel="${esc(k.rel)}" data-from="${esc(ctx.self || '')}"`
        + (k.par ? ` data-par="${k.par}"` : '') + (k.item ? ` data-item="${k.item}"` : '')
      : ` data-ref="${esc(k.ref)}"${k.law ? ` data-law="${esc(k.law)}"` : ''}`;
    out.push(`<a class="ref"${attrs}>${esc(k.text)}</a>`);
    last = k.end;
  }
  out.push(esc(raw.slice(last)));
  return out.join('');
}

/** インライン要素を HTML 化する。Line などの入れ子でもルビ・上付きを保つ。 */
function inlineHTML(node, ctx) {
  let html = '';
  for (const n of node.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      html += ctx ? linkifyText(n.nodeValue, ctx) : esc(n.nodeValue);
      continue;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    switch (n.tagName) {
      case 'Ruby': {
        const rt = n.querySelector('Rt');
        const base = Array.from(n.childNodes)
          .filter(x => x.nodeType === Node.TEXT_NODE).map(x => x.nodeValue).join('');
        html += '<ruby>' + esc(base) + '<rt>' + esc(rt ? rt.textContent : '') + '</rt></ruby>';
        break;
      }
      case 'Rt': break;
      case 'Sup': html += '<sup>' + inlineHTML(n, ctx) + '</sup>'; break;
      case 'Sub': html += '<sub>' + inlineHTML(n, ctx) + '</sub>'; break;
      case 'Fig': html += `<span class="fig">［図: ${esc(n.getAttribute('src') || '')}］</span>`; break;
      case 'Sentence':
        html += n.getAttribute('Function') === 'proviso'
          ? '<span class="proviso">' + inlineHTML(n, ctx) + '</span>' : inlineHTML(n, ctx);
        break;
      case 'Column': html += '<span class="column">' + inlineHTML(n, ctx) + '</span>'; break;
      default: html += inlineHTML(n, ctx);
    }
  }
  return html;
}

const CONTAINER_TITLE = {
  Part: 'PartTitle', Chapter: 'ChapterTitle', Section: 'SectionTitle',
  Subsection: 'SubsectionTitle', Division: 'DivisionTitle',
};
const CONTAINER_CLASS = {
  Part: 'h-part', Chapter: 'h-chapter', Section: 'h-section',
  Subsection: 'h-subsection', Division: 'h-division',
};
const CONTAINER_LEVEL = { Part: 1, Chapter: 2, Section: 3, Subsection: 4, Division: 5 };

/** 条・項・号に付けられる色マーク */
const MARK_COLORS = [
  { key: 'yellow', label: '黄' }, { key: 'green', label: '緑' }, { key: 'blue', label: '青' },
  { key: 'red', label: '赤' }, { key: 'orange', label: '橙' }, { key: 'purple', label: '紫' },
];

/** 親が自分で描画済みの要素。renderBlocks はこれらを飛ばす。 */
const HANDLED_BY_PARENT = new Set([
  'LawTitle', 'LawNum', 'TOC',
  // 編章節款目の見出しは容器側で描くので、子の巡回では必ず飛ばす。
  // これを入れ忘れると renderBlock の /Title$/ 分岐が拾って二重描画になる。
  'PartTitle', 'ChapterTitle', 'SectionTitle', 'SubsectionTitle', 'DivisionTitle',
  'ArticleCaption', 'ArticleTitle',
  'ParagraphCaption', 'ParagraphNum', 'ParagraphSentence',
  'ItemTitle', 'ItemSentence',
  'SupplProvisionLabel',
]);

const TABLE_LIKE = new Set([
  'TableStruct', 'Table', 'AppdxTable', 'AppdxNote', 'AppdxStyle',
  'Appdx', 'AppdxFig', 'AppdxFormat', 'NoteStruct', 'StyleStruct',
  'FigStruct', 'FormatStruct', 'ArithFormula', 'List', 'Remarks', 'SupplNote',
]);

/**
 * 法令XMLを HTML と検索用インデックスに変換する。
 * 未知の要素は捨てずに再帰して本文を出す。取りこぼしは表示の正確さを直接損なう。
 */
function renderLaw(lawEl) {
  const out = [];
  const index = [];
  const toc = [];             // { id, level, title, first, last }
  const tocStack = [];
  let hseq = 0;
  let scope = 'M';

  function pushToc(entry) {
    entry.id = 'h' + (++hseq);
    toc.push(entry);
    return entry.id;
  }

  function pushIndex(anchor, text) {
    const t = String(text).replace(/\s+/g, '');
    if (t) index.push({ anchor, text: t, norm: normalize(t) });
  }

  /* --- 表・別表・図など --- */

  function renderTable(tbl) {
    out.push('<table class="law-table"><tbody>');
    for (const row of tbl.children) {
      if (!/Row$/.test(row.tagName)) continue;
      const header = row.tagName === 'TableHeaderRow';
      out.push('<tr>');
      for (const cell of row.children) {
        if (!/Column$/.test(cell.tagName)) continue;
        const cs = cell.getAttribute('colspan') || cell.getAttribute('ColSpan');
        const rs = cell.getAttribute('rowspan') || cell.getAttribute('RowSpan');
        const tag = header || /Header/.test(cell.tagName) ? 'th' : 'td';
        out.push(`<${tag}${cs ? ` colspan="${esc(cs)}"` : ''}${rs ? ` rowspan="${esc(rs)}"` : ''}>`
          + inlineHTML(cell) + `</${tag}>`);
      }
      out.push('</tr>');
    }
    out.push('</tbody></table>');
  }

  /**
   * 別表・別記・図・備考など。子を元の順序どおり一度ずつ描く。
   * 以前は子孫の Table をまとめて先に描いてから残りを巡回していたため、
   * 表の題名や備考が落ち、入れ子の表は二重に出ていた。
   */
  function renderTableLike(el) {
    if (el.tagName === 'Table') { renderTable(el); return; }

    let drew = false;
    for (const ch of el.children) {
      const t = ch.tagName;
      if (/(?:Title|Label)$/.test(t)) {
        const s2 = ch.textContent.trim();
        if (s2) { out.push(`<div class="h-section">${esc(s2)}</div>`); drew = true; }
        continue;
      }
      if (t === 'Table') { renderTable(ch); drew = true; continue; }
      if (t === 'Sentence') {
        out.push(`<div class="para">${inlineHTML(ch)}</div>`);
        drew = true;
        continue;
      }
      renderBlock(ch);
      drew = true;
    }
    if (!drew) {
      const t = el.textContent.trim();
      if (t) out.push(`<div class="para">${esc(t)}</div>`);
    }
  }

  /* --- 条・項・号 --- */

  /**
   * 号とその細分（イ・ロ）を描く。別表の直下など、項の外に現れる号もここを通す。
   * その場合は条項の文脈が無いのでアンカーは付けない。
   */
  function renderItemNode(el, depth, anchor) {
    const tag = el.tagName;                        // Item / Subitem1 / Subitem2 …
    const titleTag = tag + 'Title';
    const sentTag = tag + 'Sentence';
    const title = textOf(el, titleTag);
    const sent = el.querySelector(':scope > ' + sentTag);

    out.push(`<div class="item${depth ? ' subitem' + depth : ''}"`
      + `${anchor ? ` data-anchor="${esc(anchor)}"` : ''}>`);
    if (title) out.push(`<span class="item-title">${esc(title)}</span>`);
    if (sent) out.push(inlineHTML(sent, { scope, self: anchor || '' }));
    for (const ch of el.children) {
      // 自分で描いた見出しと本文は固定リストではなく、この呼び出しの名前で除く。
      // スキーマは Subitem10 まであるので、列挙だと取りこぼす。
      if (ch.tagName === titleTag || ch.tagName === sentTag) continue;
      if (/^Subitem\d+$/.test(ch.tagName)) renderItemNode(ch, depth + 1, null);
      else if (!HANDLED_BY_PARENT.has(ch.tagName)) renderBlock(ch);
    }
    out.push('</div>');
  }

  function renderItem(item, art, par) {
    const anchor = `${scope}/${art}/${par}/${item.getAttribute('Num') || ''}`;
    renderItemNode(item, 0, anchor);
    // 号の索引にはイ・ロ以下の本文も含める（細分には別アンカーを与えない）
    pushIndex(anchor, plainText(item));
  }

  /**
   * 項を描画する。条の下の項も、附則直下の項も同じ経路を通す。
   * 条が無い場合は art を空にする（アンカーは "S1//3" の形）。
   */
  function renderParagraph(p, art, idx, leadHTML) {
    const par = p.getAttribute('Num') || String(idx + 1);
    const anchor = `${scope}/${art}/${par}`;
    const pnum = paragraphNumLabel(
      textOf(p, 'ParagraphNum'), par, p.getAttribute('OldNum') === 'true');
    const pcap = textOf(p, 'ParagraphCaption');
    const sent = p.querySelector(':scope > ParagraphSentence');

    out.push(`<div class="para" data-anchor="${esc(anchor)}">`);
    if (pcap) out.push(`<div class="article-caption">${esc(pcap)}</div>`);
    if (leadHTML) out.push(leadHTML);
    else if (pnum) out.push(`<span class="para-num">${esc(pnum)}</span>　`);
    if (sent) out.push(inlineHTML(sent, { scope, self: anchor }));

    for (const ch of p.children) {
      if (ch.tagName === 'Item') renderItem(ch, art, par);
      else if (!HANDLED_BY_PARENT.has(ch.tagName)) renderBlock(ch, null);
    }
    out.push('</div>');

    // 項の索引には号・細分・表まで含める。項番号だけは除く。
    const text = plainText(p, new Set(['ParagraphNum']));
    pushIndex(anchor, text);
    return text;
  }

  function renderArticle(articleEl) {
    const art = articleEl.getAttribute('Num') || '';
    const caption = textOf(articleEl, 'ArticleCaption');
    const title = textOf(articleEl, 'ArticleTitle');
    const paras = Array.from(articleEl.children).filter(c => c.tagName === 'Paragraph');
    const anchor = `${scope}/${art}`;

    // 目次に条の範囲（第1条〜第10条）を記録する
    for (const e of tocStack) {
      if (e.first === null) e.first = art;
      e.last = art;
    }

    out.push(`<div class="article" data-anchor="${esc(anchor)}">`);
    if (caption) out.push(`<div class="article-caption">${esc(caption)}</div>`);

    paras.forEach((p, i) => {
      const lead = (i === 0 && title) ? `<span class="article-title">${esc(title)}</span>　` : '';
      renderParagraph(p, art, i, lead);
    });

    for (const ch of articleEl.children) {
      if (ch.tagName === 'Paragraph' || HANDLED_BY_PARENT.has(ch.tagName)) continue;
      renderBlock(ch, null);
    }

    if (!paras.length) {
      const txt = plainText(articleEl, new Set(['ArticleTitle', 'ArticleCaption']));
      out.push(`<div class="para">${title ? `<span class="article-title">${esc(title)}</span>　` : ''}${esc(txt.trim())}</div>`);
      pushIndex(anchor, (caption || '') + txt);
    } else {
      // 条の索引は見出しだけ。本文は項の索引が持つので重複させない。
      pushIndex(anchor, (caption || '') + (title || ''));
    }
    out.push('</div>');
  }

  /* --- 汎用の振り分け --- */

  function renderBlock(el) {
    const tag = el.tagName;
    if (HANDLED_BY_PARENT.has(tag)) return;

    if (tag in CONTAINER_TITLE) {
      const t = textOf(el, CONTAINER_TITLE[tag]);
      let entry = null;
      if (t) {
        entry = { level: CONTAINER_LEVEL[tag], title: t, first: null, last: null };
        const id = pushToc(entry);
        tocStack.push(entry);
        out.push(`<div class="${CONTAINER_CLASS[tag]}" id="${id}">${esc(t)}</div>`);
      }
      renderBlocks(el);
      if (entry) tocStack.pop();
      return;
    }
    if (tag === 'Article') { renderArticle(el); return; }
    if (tag === 'Paragraph') { renderParagraph(el, '', 0, ''); return; }
    // 別表の直下などに現れる号。項を介さないのでアンカーは付けない。
    if (tag === 'Item' || /^Subitem\d+$/.test(tag)) { renderItemNode(el, 0, null); return; }
    // 図は本文を持たない。放っておくと文字が無いので黙って消える。
    if (tag === 'Fig') {
      out.push(`<div class="para"><span class="fig">［図: ${esc(el.getAttribute('src') || '')}］</span></div>`);
      return;
    }
    if (TABLE_LIKE.has(tag)) { renderTableLike(el); return; }
    if (/Title$/.test(tag)) {
      const t = el.textContent.trim();
      if (t) out.push(`<div class="h-section">${esc(t)}</div>`);
      return;
    }
    if (el.children.length) { renderBlocks(el); return; }
    const t = el.textContent.trim();
    if (t) out.push(`<div class="para">${esc(t)}</div>`);
  }

  function renderBlocks(el) {
    for (const ch of el.children) renderBlock(ch);
  }

  /* --- 全体 --- */

  const body = lawEl.querySelector('LawBody');
  if (!body) return { html: '', index, toc };

  let sn = 0, apn = 0;
  for (const ch of body.children) {
    const tag = ch.tagName;
    if (tag === 'LawTitle' || tag === 'TOC') continue;           // 題名は見出し欄、目次は省略
    if (tag === 'EnactStatement') {
      out.push(`<div class="enact">${inlineHTML(ch)}</div>`);
      continue;
    }
    if (tag === 'Preamble') {
      // 索引に載せる以上、飛び先のアンカーも付けておく（検索結果から移動できるように）
      out.push('<div class="preamble" data-anchor="M/前文">');
      for (const p of ch.querySelectorAll('Paragraph')) {
        const sent = p.querySelector(':scope > ParagraphSentence');
        out.push('<div class="para">' + (sent ? inlineHTML(sent) : '') + '</div>');
      }
      out.push('</div>');
      pushIndex('M/前文', plainText(ch));
      continue;
    }
    if (tag === 'SupplProvision') {
      sn += 1;
      scope = 'S' + sn;
      const label = textOf(ch, 'SupplProvisionLabel');
      const amend = ch.getAttribute('AmendLawNum');
      const title = (label || '附則') + (amend ? '（' + amend + '）' : '');
      const id = pushToc({ level: 0, title, kind: 'suppl' });
      out.push(`<div class="suppl-label" id="${id}">${esc(label || '附則')}${amend ? '　' + esc(amend) : ''}</div>`);
      renderBlocks(ch);
      continue;
    }
    if (/^Appdx/.test(tag)) {                 // 別表・別記・別図など
      apn += 1;
      scope = 'M';
      const anchor = 'AP' + apn;
      const t = Array.from(ch.children).find(c => /Title$/.test(c.tagName));
      const id = pushToc({ level: 0, title: (t ? t.textContent.trim() : '別表' + apn), kind: 'appdx' });
      out.push(`<div class="appdx" id="${id}" data-anchor="${esc(anchor)}">`);
      renderBlock(ch);
      out.push('</div>');
      pushIndex(anchor, plainText(ch));
      continue;
    }
    scope = 'M';
    renderBlock(ch);                          // MainProvision はここを通る
  }

  return { html: out.join(''), index, toc };
}

/* --------------------------------------------------- アンカー → XML要素 */

/**
 * アンカー（M/709/1 など）が指す XML 要素を返す。
 * 注釈付きXMLの書き出しと、将来の文言メモの位置解決で使う。
 */
function elementForAnchor(lawEl, anchor) {
  const body = lawEl.querySelector('LawBody');
  if (!body) return null;
  const parts = String(anchor).split('/');

  if (anchor === 'M/前文') return body.querySelector(':scope > Preamble');

  if (/^AP\d+$/.test(parts[0])) {
    const list = Array.from(body.children).filter(c => /^Appdx/.test(c.tagName));
    return list[Number(parts[0].slice(2)) - 1] || null;
  }

  let root;
  if (parts[0] === 'M') {
    root = body.querySelector(':scope > MainProvision');
  } else {
    const list = Array.from(body.children).filter(c => c.tagName === 'SupplProvision');
    root = list[Number(parts[0].slice(1)) - 1];
  }
  if (!root) return null;

  const [, art, par, item] = parts;
  let cur = root;

  if (art) {
    cur = Array.from(root.querySelectorAll('Article')).find(a => a.getAttribute('Num') === art);
    if (!cur) return null;
  }
  if (par) {
    const paras = art
      ? Array.from(cur.children).filter(c => c.tagName === 'Paragraph')
      : Array.from(root.children).filter(c => c.tagName === 'Paragraph');
    cur = paras.find(p => (p.getAttribute('Num') || '') === par);
    if (!cur) return null;
  }
  if (item) {
    cur = Array.from(cur.children).filter(c => c.tagName === 'Item')
      .find(i => (i.getAttribute('Num') || '') === item);
    if (!cur) return null;
  }
  return cur;
}

/* ------------------------------------------------- 文言の位置（範囲注釈） */

/*
 * 文言へのメモは、条項号より細かい位置を指す。
 * ただし素の文字位置だけで持つと、改正で一文字変わった瞬間に全部ずれる。
 * そこで「どの条項号の中の、どの文言の、何番目の出現か」で持つ。
 *   { anchor: "M/709/1", text: "故意又は過失", nth: 1 }
 * 取り込み直したときは文言を探し直す。見つからなければ捨てずに「要確認」にする。
 *
 * ただし探し直すのは、いま描画している法令だけである。開いていない法令の
 * 文言メモは、開くまで見失ったことが分からない。件数の横にその旨を添えてある。
 * 全法令をまとめて調べるには、全法令を描画し直す必要がある。
 */

/**
 * 条文ブロックの中の文字列と、その文字が属するテキストノードの対応表を作る。
 * 入れ子の別アンカー（号など）、ルビの読み、注釈の付属表示は数に入れない。
 */
function textMapOf(el) {
  const nodes = [];
  let text = '';
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      // 自分で書いた文字は本文ではない。数に入れると文言メモの位置がずれる。
      if (p.closest('.memo-inline, .inline-tags, .note-summary')) return NodeFilter.FILTER_REJECT;
      if (p.closest('rt')) return NodeFilter.FILTER_REJECT;
      if (p.closest('[data-anchor]') !== el) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walk.nextNode())) {
    const v = n.nodeValue || '';
    if (!v) continue;
    nodes.push({ node: n, start: text.length, end: text.length + v.length });
    text += v;
  }
  return { nodes, text };
}

/** 対応表の中で (node, offset) が何文字目にあたるか */
function posInMap(map, node, offset) {
  for (const seg of map.nodes) if (seg.node === node) return seg.start + offset;
  return -1;
}

/** text の nth 番目（1始まり）の出現位置。無ければ -1。 */
function nthIndexOf(hay, needle, nth) {
  let i = -1;
  for (let k = 0; k < nth; k++) {
    i = hay.indexOf(needle, i + 1);
    if (i < 0) return -1;
  }
  return i;
}

/**
 * [s, e) を包む。要素をまたぐ場合はテキストノードごとに分けて包む。
 * tag を変えられるようにしてあるのは、文言メモ（mark）と括弧書き（span）を
 * 別物として扱い、片方の塗り直しでもう片方を巻き込まないようにするため。
 */
function wrapInMap(el, s, e, cls, id, tag) {
  const map = textMapOf(el);           // 直前の加工で位置が動くので毎回作り直す
  const hits = map.nodes.filter(seg => Math.max(s, seg.start) < Math.min(e, seg.end));
  for (const seg of hits) {
    const a = Math.max(s, seg.start), b = Math.min(e, seg.end);
    let node = seg.node;
    if (b < seg.end) node.splitText(b - seg.start);
    if (a > seg.start) node = node.splitText(a - seg.start);
    const m = document.createElement(tag || 'mark');
    m.className = cls;
    if (tag) m.dataset.mark = id; else m.dataset.rangeId = id;
    node.parentNode.insertBefore(m, node);
    m.appendChild(node);
  }
  return hits.length > 0;
}

/* ------------------------------------------------------------- アプリ状態 */

/*
 * 表示面（ペイン）。法令を並べて見比べられるように2つ持つ。
 * 操作の対象は「いま触っている面」で、P() で取る。
 */
function makePane(idx) {
  const root = $(`.lawpane[data-pane="${idx}"]`);
  return {
    idx, root,
    el: $('.content', root),
    header: $('.law-header', root),
    title: $('.law-title', root),
    meta: $('.law-meta', root),
    crumb: $('.crumb', root),
    current: null,
    filter: null,          // { tag } か { marked: true }。保存しない（下の注記を見よ）
    index: [],
    toc: [],
    headOffsets: [],
    articleOffsets: [],
  };
}

const state = {
  laws: [],
  panes: [],
  active: 0,
  split: false,
  indexCache: new Map(),
  notes: new Map(),
  ranges: new Map(),
  orphanRanges: [],
  selected: null,
};

/** 要素がどの面にあるか */
function paneOf(el) {
  const root = el && el.closest && el.closest('.lawpane');
  return root ? state.panes[Number(root.dataset.pane)] : null;
}

/** いま操作している面 */
const P = () => state.panes[state.active];
/** 表示中の面すべて */
const livePanes = () => state.panes.filter(p => state.split || p.idx === 0);

const noteKey = (lawId, anchor) => lawId + ':' + anchor;

/* ------------------------------------------- メモの遅延保存（取りこぼし防止） */

let pendingSave = null;      // 条項号のメモ { note, timer }
let pendingRange = null;     // 文言メモ { rec, timer }

function scheduleSave(note) {
  if (pendingSave && pendingSave.note !== note) flushSave();
  if (pendingSave) clearTimeout(pendingSave.timer);
  pendingSave = { note, timer: setTimeout(() => { const n = pendingSave.note; pendingSave = null; saveNote(n); }, 500) };
}

function scheduleRangeSave(rec) {
  if (pendingRange && pendingRange.rec !== rec) flushSave();
  if (pendingRange) clearTimeout(pendingRange.timer);
  pendingRange = {
    rec,
    timer: setTimeout(() => { const r = pendingRange.rec; pendingRange = null; saveRange(r); }, 500),
  };
}

/**
 * 保留中の保存を今すぐ行う。条文や法令を切り替える前、離脱の前に必ず呼ぶ。
 * 条項号のメモと文言メモは別々に遅延させているので、両方をここで面倒を見る。
 * 片方だけ見ていると、見ていない側の書きかけが消える。
 */
function flushSave() {
  const jobs = [];
  if (pendingSave) {
    clearTimeout(pendingSave.timer);
    const note = pendingSave.note;
    pendingSave = null;
    jobs.push(saveNote(note));
  }
  if (pendingRange) {
    clearTimeout(pendingRange.timer);
    const rec = pendingRange.rec;
    pendingRange = null;
    jobs.push(saveRange(rec));
  }
  return jobs.length ? Promise.all(jobs) : Promise.resolve();
}

/* --------------------------------------------------------------- 法令一覧 */

async function refreshLawList() {
  state.laws = (await store.allLaws())
    .map(({ xml, ...meta }) => meta)
    .sort((a, b) => (a.lawTitle || '').localeCompare(b.lawTitle || '', 'ja'));
  renderLawList();
}

function renderLawList() {
  const kw = normalize($('#law-filter').value || '');
  const ul = $('#law-list');
  ul.innerHTML = '';
  const list = state.laws.filter(l => !kw ||
    normalize(l.lawTitle || '').includes(kw) ||
    normalize(l.lawTitleKana || '').includes(kw) ||
    normalize(l.abbrev || '').includes(kw));

  if (!list.length) {
    ul.innerHTML = '<li style="color:var(--fg-faint);cursor:default">該当なし</li>';
    return;
  }
  for (const l of list) {
    const li = document.createElement('li');
    li.className = P().current && P().current.lawId === l.lawId ? 'active' : '';
    const a = amendOf(l);
    li.innerHTML = `<span class="law-name" title="${esc(l.lawTitle)}">${esc(l.lawTitle)}</span>`
      + (isUnenforced(l) ? '<span class="rev-badge">未施行</span>' : '')
      + (a ? `<span class="amend-dot ${a.kind === 'upcoming' ? 'upcoming' : ''}" title="${esc(amendTitle(a))}　押すと版を選べます"></span>` : '')
      + `<button class="del" title="削除">×</button>`;
    li.querySelector('.law-name').onclick = () => navigate(l.lawId);
    const dotEl = li.querySelector('.amend-dot');
    if (dotEl) dotEl.onclick = e => { e.stopPropagation(); openRevisions(l.lawId); };
    li.querySelector('.del').onclick = async e => {
      e.stopPropagation();
      if (!confirm(`「${l.lawTitle}」を削除します。\nこの法令に付けたタグ・メモは残ります。よろしいですか？`)) return;
      await flushSave();
      await store.delLaw(l.lawId);
      state.indexCache.delete(l.lawId);
      if (P().current && P().current.lawId === l.lawId) {
        P().current = null;
        state.selected = null;
        P().header.hidden = true;
        P().el.innerHTML = '<div class="empty"><p>法令を選択してください。</p></div>';
        closePopover();
      }
      await refreshLawList();
      toast('削除しました');
    };
    ul.appendChild(li);
  }
}

/* ------------------------------------------------------------- 法令の表示 */

async function openLaw(lawId, anchor, scrollTop, pane) {
  pane = pane || P();
  await flushSave();
  const rec = await store.getLaw(lawId);
  if (!rec) { toast('法令が見つかりません'); return; }

  const doc = parseXML(rec.xml);
  const lawEl = doc.querySelector('Law');
  if (!lawEl) { toast('法令本体が見つかりません'); return; }

  const { html, index, toc } = renderLaw(lawEl);
  pane.current = rec;
  pane.index = index;
  pane.toc = toc;
  buildJumpTables(pane, index);
  state.indexCache.set(lawId, index);
  state.selected = null;                 // 前の法令の選択を持ち越さない

  pane.title.textContent = rec.lawTitle;
  // 分類と条文の件数は読むのに要らない。名前と、いつの版かだけ残す。
  pane.meta.textContent = [
    rec.lawNum,
    rec.enforcementDate ? '施行: ' + rec.enforcementDate : '',
  ].filter(Boolean).join('　/　');
  const warn = $('.law-warn', pane.root);
  const unenforced = isUnenforced(rec);
  warn.hidden = !unenforced;
  warn.textContent = unenforced
    ? '未施行　' + rec.enforcementDate + ' 施行予定'
      + (rec.amendLawTitle ? '（' + rec.amendLawTitle + '）' : '')
    : '';

  pane.header.hidden = false;
  pane.el.innerHTML = html;
  syncTopbarLaw();
  indexAnchorEls(pane);

  renderLawList();
  renderToc();
  resolveRefs(pane);
  paintParens(pane);
  paintNotesIn(pane);
  paintRangesIn(pane);
  closePopover();                        // 前の法令の注釈パネルは閉じる
  // 絞り込みは法令をまたいでも保つ。同じタグを別の法令で続けて見たいため。
  applyFilter(pane);
  renderFilterPicker();
  measureHeadings(pane);

  if (anchor) scrollToAnchor(anchor, false, pane);
  else if (typeof scrollTop === 'number') pane.el.scrollTop = scrollTop;
  else pane.el.scrollTop = lastPos.get(lawId) || 0;   // 前回の続きから

  updateCrumb(pane);
  // 「この法令」を対象にしているなら、結果も新しい法令のものに入れ替える
  if (find.q && find.where === 'law' && find.scopeLawId !== lawId) doFind();
  else renderFindList();
  try { localStorage.setItem('roppo.last', lawId); } catch (e) { /* 使えなくても支障ない */ }
}

/* ------------------------------------------------- 条文参照の行き先を決める */

function unwrapRef(a) {
  const parent = a.parentNode;
  while (a.firstChild) parent.insertBefore(a.firstChild, a);
  a.remove();
  parent.normalize();
}

/**
 * 参照に書かれた法令名から取込済みの法令を探す。
 * 「において準用する商業登記法」のように前に文がくっつくので、末尾一致も見る。
 * ただし「新民法」「旧法」は改正前後の別の版を指すので、一致とみなさない。
 */
function lawByName(name) {
  if (!name) return null;
  // 別の版として取り込んだものは、名前で引く対象にしない。
  // 本文に「民法」と書いてあるリンクが未施行の版へ飛んだら、取り違えに気づけない。
  const pool = state.laws.filter(l => !l.revisionOf);
  const exact = pool.find(l => l.lawTitle === name || l.abbrev === name);
  if (exact) return exact;
  let best = null;
  for (const l of pool) {
    if (!l.lawTitle || !name.endsWith(l.lawTitle)) continue;
    const before = name.slice(0, name.length - l.lawTitle.length);
    // 「地方法人税法」を「法人税法」と取り違えないよう、直前が漢字・カタカナなら採らない。
    // 「において準用する商業登記法」のように、ひらがなや記号で切れている場合だけ許す。
    if (before && /[一-鿿゠-ヿ]$/.test(before)) continue;
    if (!best || l.lawTitle.length > best.lawTitle.length) best = l;
  }
  return best;
}

/** 参照に書かれた法令名のうち、実際の法令名にあたる部分だけを返す */
function trimLawName(name) {
  const law = lawByName(name);
  if (!law) return name;
  for (const t of [law.lawTitle, law.abbrev]) {
    if (t && name.endsWith(t)) return t;
  }
  return name;
}

/**
 * 指定の条項号に一番近い、実在するアンカーを返す。
 * 号だけ指定されて項が無い場合は、その条の下から号を探す。
 */
/*
 * 参照の行き先を決める。書いてあるとおりの場所が無ければ諦める。
 * 「第99号」と書いてあるのに条へ飛ばす、という黙った読み替えをしない。
 * 飛んだ先が違うことには、読んでいる側は気づけない。
 */
function bestAnchor(index, scope, art, par, item) {
  const has = a => index.some(e => e.anchor === a);
  if (par && item && has(`${scope}/${art}/${par}/${item}`)) return `${scope}/${art}/${par}/${item}`;
  if (!par && item) {
    // 項を書かずに号だけ指す書き方。同じ号が複数の項にあると決め手が無い。
    // 最初の1件を選ぶと、黙って別の項へ連れて行くことになる。
    const hits = index.filter(e => {
      const p = e.anchor.split('/');
      return p.length === 4 && p[0] === scope && p[1] === art && p[3] === item;
    });
    return hits.length === 1 ? hits[0].anchor : null;
  }
  if (item) return null;
  if (par && has(`${scope}/${art}/${par}`)) return `${scope}/${art}/${par}`;
  if (par) return null;
  if (has(`${scope}/${art}`)) return `${scope}/${art}`;
  return null;
}

/**
 * 条番号を伴わない参照を、いまの位置から解く。
 *   前条 / 次条 / 前項 / 次項 / 第N項 と、それに付く項・号
 */
function resolveRelative(a, pane) {
  const from = a.dataset.from;
  if (!from) return null;
  const rel = a.dataset.rel;
  const [scope, art, par] = from.split('/');
  const wantPar = a.dataset.par || '';
  const wantItem = a.dataset.item || '';

  let targetArt = art;
  if (rel === '前条' || rel === '次条') {
    // 条は枝番があるので番号の足し算では解けない。並び順で隣を取る。
    const arts = pane.index
      .filter(e => { const p = e.anchor.split('/'); return p.length === 2 && p[0] === scope; })
      .map(e => e.anchor.split('/')[1]);
    const i = arts.indexOf(art);
    if (i < 0) return null;
    targetArt = arts[i + (rel === '前条' ? -1 : 1)];
    if (!targetArt) return null;
  }

  let targetPar = wantPar;
  if (rel === '前項' || rel === '次項') {
    const n = Number(par) + (rel === '前項' ? -1 : 1);
    if (!Number.isFinite(n) || n < 1) return null;
    targetPar = String(n);
  }

  return bestAnchor(pane.index, scope, targetArt, targetPar, wantItem);
}

/**
 * 描画後に参照の行き先を確定する。
 * 実在を確かめられなかったものはリンクを外し、ただの文字に戻す。
 */
function resolveRefs(pane) {
  if (!pane.current) return;
  let live = 0, dropped = 0;

  for (const a of $$('a.ref', pane.el)) {
    let lawId = pane.current.lawId;
    let target = null;

    if (a.dataset.rel) {
      target = resolveRelative(a, pane);
    } else if (a.dataset.law) {
      // 他法令。取り込んでいないものは行き先を確かめられないのでリンクにしない。
      const law = lawByName(a.dataset.law);
      const idx = law && state.indexCache.get(law.lawId);
      if (law && idx) {
        // 附則の番号は法令をまたいで対応しない。他法令の参照は必ず本則で探す。
        const [, art, par, item] = a.dataset.ref.split('/');
        target = bestAnchor(idx, 'M', art, par, item);
        lawId = law.lawId;
      }
    } else {
      const [scope, art, par, item] = a.dataset.ref.split('/');
      target = bestAnchor(pane.index, scope, art, par, item);
      if (scope !== 'M') {
        // 附則の中の裸の「第七百三十八条」は、その附則の条とも本則の条とも読める。
        // 両方にあるなら決め手が無いのでリンクしない。片方だけならそれを指す。
        const inMain = bestAnchor(pane.index, 'M', art, par, item);
        if (target && inMain) target = null;
        else target = target || inMain;
      }
    }

    if (!target) { unwrapRef(a); dropped++; continue; }
    a.dataset.target = lawId + '|' + target;
    a.title = (lawId === pane.current.lawId ? '' : (lawByName(a.dataset.law) || {}).lawTitle + ' ')
      + anchorLabel(target) + '　（Ctrl+クリックで隣の面に開く）';
    live++;
  }
  if (dropped) console.debug(`参照リンク: ${live}件を有効化、${dropped}件は行き先不明のため解除`);
}

/** 参照をたどる。Ctrl/⌘ を押していればもう一方の面に開く。 */
async function followRef(a, toOtherPane) {
  const [lawId, anchor] = (a.dataset.target || '').split('|');
  if (!lawId || !anchor) return;

  if (toOtherPane) {
    if (!state.split) setSplit(true);
    const other = state.panes[P().idx === 0 ? 1 : 0];
    setActivePane(other.idx);
  }
  await navigate(lawId, anchor);
}

/* ----------------------------------------------------------- 2面の操作 */

/* 狭い画面では上段に ☰ と法令名を並べる。面を切り替えたら name も入れ替える。 */
function syncTopbarLaw() {
  const el = $('#topbar-law');
  if (!el) return;
  const rec = P().current;
  $('.tl-name', el).textContent = (rec && rec.lawTitle) || '';
  $('.tl-date', el).textContent = (rec && rec.enforcementDate) ? '施行 ' + rec.enforcementDate : '';

  const dot = $('.tl-dot', el);
  const a = rec && amendOf(rec);
  dot.hidden = !a;
  dot.className = 'tl-dot amend-dot' + (a && a.kind === 'upcoming' ? ' upcoming' : '');
  dot.title = a ? amendTitle(a) : '';
}

function setActivePane(idx) {
  if (!state.split) idx = 0;
  state.active = idx;
  for (const p of state.panes) p.root.classList.toggle('active', p.idx === idx);
  syncTopbarLaw();
  renderLawList();
  renderToc();
  // 「この法令」の指す先が変わるので、結果を出し直す。
  // 表示だけ更新すると、別の法令の結果を今の法令のものとして見せてしまう。
  if (find.q && find.where === 'law') doFind();
  else renderFindList();
}

function setSplit(on) {
  state.split = !!on;
  const second = state.panes[1];
  second.root.hidden = !on;
  $('#split-panes').hidden = !on;
  $('#panes').classList.toggle('split', !!on);
  $('#btn-split').classList.toggle('on', !!on);
  if (!on) setActivePane(0);
  try { localStorage.setItem('roppo.split', on ? '1' : '0'); } catch (e) { /* 任意 */ }
  for (const p of livePanes()) { measureHeadings(p); updateCrumb(p); }
}

/** 仕切りをドラッグして幅を変える */
function wireSplitter(el, onMove) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = ev => onMove(ev.clientX);
    const up = ev => {
      el.releasePointerCapture(ev.pointerId);
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      for (const p of livePanes()) { measureHeadings(p); updateCrumb(p); }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

function wirePanes() {
  state.panes = [makePane(0), makePane(1)];

  // 触った面を操作対象にする
  for (const p of state.panes) {
    p.root.addEventListener('pointerdown', () => {
      if (state.split && P() !== p) setActivePane(p.idx);
    });
    p.el.addEventListener('scroll', () => {
      positionPopover();
      updateCrumb(p);
      hideTip();
      if (p === P()) { clearTimeout(p._t); p._t = setTimeout(rememberPos, 300); }
    }, { passive: true });
  }

  $('#btn-split').onclick = () => setSplit(!state.split);

  // 左ペインの幅
  const side = $('#pane-laws');
  let sideW = 268;
  try { sideW = Number(localStorage.getItem('roppo.sideWidth')) || 268; } catch (e) { /* 任意 */ }
  const setSideWidth = w => {
    sideW = Math.max(180, Math.min(520, w));
    document.documentElement.style.setProperty('--side-width', sideW + 'px');
    try { localStorage.setItem('roppo.sideWidth', String(sideW)); } catch (e) { /* 任意 */ }
  };
  setSideWidth(sideW);
  wireSplitter($('#split-side'), x => setSideWidth(x - side.getBoundingClientRect().left));

  // 2面の配分
  let ratio = 50;
  try { ratio = Number(localStorage.getItem('roppo.paneRatio')) || 50; } catch (e) { /* 任意 */ }
  const setRatio = r => {
    ratio = Math.max(20, Math.min(80, r));
    state.panes[0].root.style.flex = `${ratio} 1 0`;
    state.panes[1].root.style.flex = `${100 - ratio} 1 0`;
    try { localStorage.setItem('roppo.paneRatio', String(ratio)); } catch (e) { /* 任意 */ }
  };
  setRatio(ratio);
  wireSplitter($('#split-panes'), x => {
    const box = $('#panes').getBoundingClientRect();
    setRatio(((x - box.left) / box.width) * 100);
  });

  let wantSplit = false;
  try { wantSplit = localStorage.getItem('roppo.split') === '1'; } catch (e) { /* 任意 */ }
  // 狭い画面では2面に割るボタンを隠している。記憶した状態を復元すると、
  // 戻す手段が無いまま2面のままになる。
  if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) wantSplit = false;
  setSplit(wantSplit);
}

/* ------------------------------------------------------------ 絞り込み */

/*
 * 印を付けたところだけを、本文の形のまま残す。
 *
 * 抜粋を別画面に並べるより、条文の順に、前後の見出しごと読める方がよい。
 * ただし二つ、譲れないことがある。
 *
 *   1. 絞り込み中はそれと分かる帯を必ず出す。法令の一部しか出ていないのに
 *      全部だと思って読むのが、この道具で起こりうる一番まずいことである。
 *   2. 次に開いたときは全文に戻す。書体や文字の大きさと違って、これを
 *      持ち越すと、気づかないまま欠けた法令を読むことになる。
 *      だから view（localStorage に残る設定）には入れない。
 *
 * 隠す単位は「条」にしてある。条番号は第1項の中に置かれているので、
 * 項だけを残すと番号が消えて、何条か分からない条文が並ぶ。
 */

/** その絞り込みに合う注釈のアンカーを集める。 */
function filterAnchors(pane) {
  const f = pane.filter;
  const lawId = pane.current && pane.current.lawId;
  const out = new Set();
  if (!f || !lawId) return out;

  for (const n of state.notes.values()) {
    if (n.lawId !== lawId) continue;
    const hit = f.tag
      ? (n.tags || []).includes(f.tag)
      : !!(n.color || (n.tags || []).length
        || String(n.summary || '').trim() || String(n.memo || '').trim());
    if (hit) out.add(n.anchor);
  }
  // 文言に付けたものは、タグを持たない。「印のあるもの」のときだけ数える。
  if (!f.tag) {
    for (const r of state.ranges.values()) {
      if (r.lawId === lawId) out.add(r.anchor);
    }
  }
  return out;
}

function applyFilter(pane) {
  pane = pane || P();
  const banner = $('.law-filter', pane.root);
  const kids = [...pane.el.children];
  for (const el of kids) el.classList.remove('filtered-out');

  if (!pane.filter || !pane.current) {
    banner.hidden = true;
    measureHeadings(pane);
    return 0;
  }

  const want = [...filterAnchors(pane)];
  const levelOf = new Map(pane.toc.map(e => [e.id, e.level]));

  // 条・前文・別表・附則直下の項など、本文の塊ごとに見せるかを決める
  const show = new Map();
  let shown = 0;
  for (const el of kids) {
    const a = el.dataset && el.dataset.anchor;
    if (!a) { show.set(el, false); continue; }
    const hit = want.some(m => m === a || m.startsWith(a + '/'));
    show.set(el, hit);
    if (hit) shown++;
  }

  // 見出しは、その下に残るものがあるときだけ出す。
  // 見出しだけが並ぶのも、見出しが消えて文脈が切れるのも困る。
  const stack = [];
  for (const el of kids) {
    if (levelOf.has(el.id)) {
      const lv = levelOf.get(el.id);
      while (stack.length && levelOf.get(stack[stack.length - 1].id) >= lv) stack.pop();
      stack.push(el);
    } else if (show.get(el)) {
      for (const h of stack) show.set(h, true);
    }
  }

  for (const el of kids) if (!show.get(el)) el.classList.add('filtered-out');

  const name = pane.filter.tag ? `タグ「${pane.filter.tag}」` : '印のあるもの';
  banner.hidden = false;
  banner.innerHTML = `<span>${esc(name)}で絞り込み中　${shown}件</span>`;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = '全文に戻す';
  b.onclick = () => setFilter(null, pane);
  banner.appendChild(b);

  measureHeadings(pane);
  return shown;
}

function setFilter(f, pane) {
  pane = pane || P();
  pane.filter = f;
  applyFilter(pane);
  pane.el.scrollTop = 0;      // 絞ると並びが変わる。前の位置に意味がない。
  updateCrumb(pane);
  renderFilterPicker();
}

/** 表示設定の中の選び口。いま開いている法令に実際にあるタグだけ出す。 */
function renderFilterPicker() {
  const box = $('#filter-picker');
  if (!box) return;
  const pane = P();
  box.innerHTML = '';

  const add = (label, f, on) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (on) b.classList.add('on');
    b.onclick = () => setFilter(f, pane);
    box.appendChild(b);
  };

  add('すべて', null, !pane.filter);
  if (!pane.current) return;

  const lawId = pane.current.lawId;
  let marked = 0;
  const tags = new Map();
  for (const n of state.notes.values()) {
    if (n.lawId !== lawId) continue;
    if (n.color || (n.tags || []).length
      || String(n.summary || '').trim() || String(n.memo || '').trim()) marked++;
    for (const t of (n.tags || [])) tags.set(t, (tags.get(t) || 0) + 1);
  }
  for (const r of state.ranges.values()) if (r.lawId === lawId) marked++;

  if (marked) add('印のあるもの', { marked: true }, !!(pane.filter && !pane.filter.tag));
  for (const [t] of [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))) {
    add(t, { tag: t }, !!(pane.filter && pane.filter.tag === t));
  }
}

/* ------------------------------------------------- 移動の履歴と読書位置 */

const lastPos = new Map();      // lawId -> scrollTop
let hist = [];                  // { lawId, anchor, scrollTop }
let hi = -1;                    // hist の現在位置
let navigating = false;         // 履歴を辿っている最中は記録しない

function loadLastPos() {
  try {
    const o = JSON.parse(localStorage.getItem('roppo.pos') || '{}');
    for (const [k, v] of Object.entries(o)) lastPos.set(k, v);
  } catch (e) { /* 任意 */ }
}

function rememberPos() {
  if (!P().current) return;
  // 絞り込み中の位置は、全文で開き直したときには別の場所を指す。覚えない。
  if (P().filter) return;
  const top = P().el.scrollTop;
  lastPos.set(P().current.lawId, top);
  // 履歴は面をまたいで1本なので、同じ法令・同じ面のときだけ書き戻す。
  // これを見ないと、片方の面の位置がもう片方の履歴に入る。
  const e = hi >= 0 ? hist[hi] : null;
  if (e && e.lawId === P().current.lawId && e.pane === P().idx) e.scrollTop = top;
  try {
    localStorage.setItem('roppo.pos', JSON.stringify(Object.fromEntries(lastPos)));
  } catch (e) { /* 任意 */ }
}

function pushHist(entry) {
  if (entry.pane === undefined) entry.pane = P().idx;
  hist = hist.slice(0, hi + 1);
  const prev = hist[hi];
  // 同じ場所を連続して積まない
  if (prev && prev.lawId === entry.lawId && prev.anchor === entry.anchor
    && prev.pane === entry.pane) return;
  hist.push(entry);
  hi = hist.length - 1;
  updateNavButtons();
}

function updateNavButtons() {
  $('#btn-back').disabled = hi <= 0;
  $('#btn-fwd').disabled = hi < 0 || hi >= hist.length - 1;
}

/*
 * 狭い画面では左ペインが画面を覆うドロワーになる。開いている間は
 * ☰ も条文も隠れるので、行き先を選んだら閉じる。
 */
function setDrawer(open) {
  $('#pane-laws').classList.toggle('open', open);
  $('#scrim').hidden = !open;
}

/* 画面が狭いかどうか。検索欄の置き場所とドロワーの扱いがここで変わる。 */
const narrowMQ = window.matchMedia ? window.matchMedia('(max-width: 800px)') : null;
function narrow() { return !!(narrowMQ && narrowMQ.matches); }

/* シートの中のどちらを出すか。番号で引くのが既定。 */
function switchSheetTab(name) {
  for (const b of $$('#sheet-tabs button')) b.classList.toggle('on', b.dataset.sheet === name);
  $('#sheet-jump').hidden = name !== 'jump';
  $('#sheet-find').hidden = name !== 'find';
  try { localStorage.setItem('roppo.sheetTab', name); } catch (e) { /* 任意 */ }
}

function setSheet(open, which) {
  if (which) switchSheetTab(which);
  $('#lookup-sheet').hidden = !open;
  $('#btn-lookup-fab').classList.toggle('on', open);
  if (!open) return;
  const jump = !$('#sheet-jump').hidden;
  if (jump) updateJumpPreview();
  $(jump ? '#jump-input' : '#find-input').focus();
}

/*
 * 狭い画面には上段に全部を並べる余地がない。片手で持つと上段は遠いので、
 * よく使うものを下へ移す。
 *
 *   上段   ☰ と法令名だけ
 *   下段   戻る・進む／表示設定／引く
 *   シート 番号の欄（テンキー）と検索の欄
 *
 * 作りを二重に持たない。同じ入力欄やボタンが2つあると、どちらを押したかで
 * 挙動が変わる。要素そのものを動かす。
 */
function placeControls() {
  const jump = $('.jump'), find = $('.find'), panel = $('#panel-find');
  const nav = $('.nav'), view = $('.view'), bar = $('#bottombar');
  const pad = $('#keypad'), input = $('#jump-input');

  bar.hidden = !narrow();

  if (narrow()) {
    if (nav.parentElement !== bar) {
      bar.prepend(nav);                       // 左端に戻る・進む
      bar.insertBefore(view, $('#btn-lookup-fab'));   // 右端の「引く」の手前
    }
    if (jump.parentElement !== $('#sheet-jump')) {
      $('#sheet-jump').append(jump);
      $('#sheet-find').append(panel, find);
    }
    pad.hidden = false;           // シートでは盤を常に出す。切替ボタンは隠してある
    input.inputMode = 'none';     // 盤が目の前にあるので、端末のキーボードは出さない
    panel.hidden = false;         // シートの中では常に中身を出す
    $('#tab-find').hidden = true;
    if ($('#tab-find').classList.contains('on')) switchTab('laws');
  } else {
    if (jump.parentElement !== $('.topbar')) {
      // 上段の並びは ← → / 番号 / 検索 / 2面 / 表示 の順に戻す
      $('.topbar').insertBefore(jump, $('#btn-split'));
      $('.topbar').insertBefore(find, $('#btn-split'));
      $('.topbar').insertBefore(nav, jump);
      $('.topbar').appendChild(view);
      $('#pane-laws').insertBefore(panel, $('#panel-marks'));
    }
    input.inputMode = 'numeric';
    try { pad.hidden = localStorage.getItem('roppo.pad') !== '1'; } catch (e) { pad.hidden = true; }
    $('#tab-find').hidden = false;
    setSheet(false);
    setDrawer(false);       // 覆いが残ると、広い画面では画面全体を塞ぐ
    const on = $('.tabs button[data-tab].on');
    switchTab(on ? on.dataset.tab : 'laws');
  }
}

/* 行き先が決まったら、覆っているものをどける。 */
function closeDrawerAfterJump() {
  if (!narrow()) return;
  setDrawer(false);
  setSheet(false);
}

/** 移動の入口。法令内でも法令をまたいでも、ここを通れば履歴に残る。 */
async function navigate(lawId, anchor) {
  rememberPos();
  closeDrawerAfterJump();
  if (!P().current || P().current.lawId !== lawId) await openLaw(lawId, anchor);
  else if (anchor) scrollToAnchor(anchor, false);
  if (!navigating) pushHist({ lawId, anchor: anchor || null, scrollTop: P().el.scrollTop });
}

async function goHistory(delta) {
  const to = hi + delta;
  if (to < 0 || to >= hist.length) return;
  rememberPos();
  navigating = true;
  hi = to;
  const e = hist[hi];
  try {
    // 記録したときの面に戻す
    if (state.split && e.pane !== undefined && e.pane !== state.active) setActivePane(e.pane);
    if (!P().current || P().current.lawId !== e.lawId) await openLaw(e.lawId, e.anchor, e.scrollTop);
    else if (e.anchor) scrollToAnchor(e.anchor, false);
    else P().el.scrollTop = e.scrollTop || 0;
    if (!e.anchor && typeof e.scrollTop === 'number') P().el.scrollTop = e.scrollTop;
  } finally {
    navigating = false;
  }
  updateNavButtons();
  updateCrumb();
}

/* --------------------------------------------------------- 現在位置の表示 */

function measureHeadings(pane) {
  pane = pane || P();
  pane.headOffsets = pane.toc.map(e => {
    const el = $('#' + e.id, pane.el);
    return el ? { ...e, top: el.offsetTop } : null;
  }).filter(Boolean);
  pane.articleOffsets = $$('.article[data-anchor]', pane.el)
    .map(el => ({ anchor: el.dataset.anchor, top: el.offsetTop }));
}

function lastAtOrBefore(list, y) {
  let lo = 0, hi2 = list.length - 1, found = null;
  while (lo <= hi2) {
    const mid = (lo + hi2) >> 1;
    if (list[mid].top <= y) { found = list[mid]; lo = mid + 1; }
    else hi2 = mid - 1;
  }
  return found;
}

function updateCrumb(pane) {
  pane = pane || P();
  const crumb = pane.crumb;
  const heads = pane.headOffsets;
  if (!pane.current || !heads.length) { crumb.hidden = true; return; }
  const y = pane.el.scrollTop + 24;

  const here = lastAtOrBefore(heads, y);
  if (!here) { crumb.hidden = true; return; }

  // 自分より浅い見出しを遡って親を集める
  const chain = [here];
  let need = here.level;
  for (let i = heads.indexOf(here) - 1; i >= 0 && need > 1; i--) {
    const e = heads[i];
    if (e.level && e.level < need) { chain.unshift(e); need = e.level; }
  }

  const art = lastAtOrBefore(pane.articleOffsets, y);
  const parts = chain.map((e, i) =>
    `<span class="${i === chain.length - 1 && !art ? 'here' : ''}">${esc(e.title)}</span>`);

  /*
   * 編・章・節の道筋と、いまの条を分けて包む。
   * 狭い画面では二段にして、条を必ず下の段に出す。まとめて一行にすると、
   * あふれたときに右端＝いまの条が切れる。一番知りたいものが消える。
   */

  crumb.innerHTML = `<span class="crumb-path">${parts.join('<span class="sep">›</span>')}</span>`
    + (art ? `<span class="crumb-art here">${esc(anchorLabel(art.anchor))}</span>` : '');
  crumb.hidden = false;

  // 目次の現在位置は、操作している面にだけ追随させる
  if (pane === P()) {
    for (const li of $$('#toc-list li')) li.classList.toggle('current', li.dataset.id === here.id);
  }
}

/**
 * 指定の条文へ移動する。
 * edit:false のときは枠を出すだけで注釈パネルを開かない。
 * 条文を引いた直後に見たいのは本文であって、編集欄ではないため。
 */
function scrollToAnchor(anchor, edit, pane) {
  pane = pane || P();
  const el = $(`[data-anchor="${CSS.escape(anchor)}"]`, pane.el);
  if (!el) return false;
  // 絞り込みで隠れている先へ飛ぶときは、黙ってではなく全文に戻してから飛ぶ。
  // 隠れたままスクロールしても、画面は何も起きていないように見える。
  if (pane.filter && el.closest('.filtered-out')) {
    setFilter(null, pane);
    toast('全文に戻しました');
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  selectAnchor(anchor, edit, pane);
  return true;
}

async function selectAnchor(anchor, edit, pane) {
  pane = pane || P();
  if (pane !== P()) setActivePane(pane.idx);
  await flushSave();
  $$('.sel').forEach(e => e.classList.remove('sel'));
  const el = $(`[data-anchor="${CSS.escape(anchor)}"]`, pane.el);
  if (el) el.classList.add('sel');
  state.selected = anchor;
  if (edit) openPopover();
  else closePopoverKeepSelection();
}

/* ------------------------------------------------- 注釈のポップアップ */

/** 枠を出している番号の要素。ポップアップはこれに寄せて開く。 */
function numberElOf(el) {
  return el.querySelector(':scope > .para-num, :scope > .item-title, :scope > .article-title, :scope > .article-caption')
    || el.querySelector(':scope > .para > .article-title')
    || el;
}

function positionPopover() {
  const pop = $('#popover');
  if (pop.hidden || !state.selected) return;
  if (window.innerWidth <= 640) { pop.style.left = ''; pop.style.top = ''; return; }

  const block = $(`[data-anchor="${CSS.escape(state.selected)}"]`, P().el);
  if (!block) return;
  const r = numberElOf(block).getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const pad = 12;

  let left = Math.min(Math.max(pad, r.left), window.innerWidth - w - pad);
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - pad) {
    const above = r.top - h - 8;
    top = above >= pad ? above : Math.max(pad, window.innerHeight - h - pad);
  }
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function openPopover() {
  const pop = $('#popover');
  if (!P().current || !state.selected) { closePopover(); return; }
  $('#pop-anchor').textContent = anchorLabel(state.selected);
  pop.hidden = false;
  renderNotePane();
  positionPopover();
}

/** 文言メモの編集。条項号の注釈とは別の内容を同じパネルに出す。 */
function openRangePopover(id) {
  const rec = state.ranges.get(id);
  if (!rec) return;
  state.selected = rec.anchor;
  $$('.sel').forEach(e => e.classList.remove('sel'));

  const pop = $('#popover');
  $('#pop-anchor').textContent = anchorLabel(rec.anchor) + '　の文言';
  pop.hidden = false;

  const body = $('#notes-body');
  body.innerHTML = `
    <div class="note-quote">${esc(rec.text)}</div>
    <p class="note-label">色</p>
    <div class="palette" id="palette"></div>
    <p class="note-label">メモ</p>
    <textarea id="memo-input" placeholder="この文言についてのメモ"></textarea>
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <button type="button" id="range-del" class="mini">削除</button>
      <span class="saved-at" id="saved-at"></span>
    </div>
  `;

  const palette = $('#palette');
  const paint = () => {
    palette.innerHTML = '';
    for (const c of MARK_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = c.label;
      b.style.background = `var(--mk-${c.key})`;
      if (rec.color === c.key) b.classList.add('on');
      b.onclick = async () => { rec.color = c.key; await saveRange(rec); paint(); };
      palette.appendChild(b);
    }
  };
  paint();

  const memo = $('#memo-input');
  memo.value = rec.memo || '';
  memo.oninput = () => { rec.memo = memo.value; scheduleRangeSave(rec); };
  memo.onblur = () => flushSave();

  $('#range-del').onclick = async () => {
    if (!confirm('この文言のメモを削除します。よろしいですか？')) return;
    // 保留中の保存を先に止めないと、削除したあとに書き戻されて復活する
    if (pendingRange) { clearTimeout(pendingRange.timer); pendingRange = null; }
    await deleteRange(rec.id);
  };
  $('#saved-at').textContent = rec.updatedAt
    ? '最終更新 ' + new Date(rec.updatedAt).toLocaleString('ja-JP') : '';

  const el = $(`mark[data-range-id="${CSS.escape(rec.id)}"]`, P().el);
  if (el) {
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight, pad = 12;
    pop.style.left = Math.min(Math.max(pad, r.left), window.innerWidth - w - pad) + 'px';
    const top = r.bottom + 8;
    pop.style.top = (top + h > window.innerHeight - pad
      ? Math.max(pad, r.top - h - 8) : top) + 'px';
  }
}

function closePopover() {
  closePopoverKeepSelection();
  $$('.sel').forEach(e => e.classList.remove('sel'));
  state.selected = null;
}

/** パネルだけ畳む。枠（選択）は残す。ジャンプ直後はこちらを使う。 */
function closePopoverKeepSelection() {
  const pop = $('#popover');
  if (pop.hidden) return;
  flushSave();
  pop.hidden = true;
}

/* ------------------------------------------------------ タグ・メモの描画 */

async function loadNotes() {
  const all = await store.allNotes();
  state.notes = new Map(all.map(n => [n.key, n]));
  renderMarkList();
  renderFilterPicker();
}

function paintNotes() {
  for (const pane of livePanes()) paintNotesIn(pane);
}

function paintNotesIn(pane) {
  $$('[data-anchor]', pane.el).forEach(el => {
    el.classList.remove('mk');
    MARK_COLORS.forEach(c => el.classList.remove('mk-' + c.key));
    for (const sel of [':scope > .inline-tags', ':scope > .memo-inline', ':scope > .note-summary']) {
      const old = el.querySelector(sel);
      if (old) old.remove();
    }
  });
  if (!pane.current) return;
  for (const el of $$('[data-anchor]', pane.el)) {
    const n = state.notes.get(noteKey(pane.current.lawId, el.dataset.anchor));
    if (!n) continue;
    if (n.color) el.classList.add('mk', 'mk-' + n.color);
    if (n.tags && n.tags.length) {
      const span = document.createElement('span');
      span.className = 'inline-tags';
      span.innerHTML = n.tags.map(t => `<span class="t">${esc(t)}</span>`).join('');
      el.appendChild(span);
    }
    if ((n.summary || '').trim()) insertSummary(el, n.summary);
    if ((n.memo || '').trim()) {
      const div = document.createElement('div');
      div.className = 'memo-inline';
      div.textContent = n.memo;
      el.appendChild(div);
    }
  }
}

/**
 * 要約を本文の前に差し込む。条文番号のすぐ後ろ、本文の手前に置く。
 * 自分で書いた言葉が条文本文に紛れないよう、書体と色で明確に分ける。
 */
function insertSummary(el, text) {
  const span = document.createElement('span');
  span.className = 'note-summary';
  span.textContent = text;
  const num = el.querySelector(':scope > .para-num, :scope > .item-title, :scope > .article-title');
  if (num) { num.after(span); return span; }
  // 条に付けた場合。条番号は第1項の中にあるので直下には無い。法令の見出しの後ろに置く。
  const cap = el.querySelector(':scope > .article-caption');
  if (cap) cap.after(span);
  else el.prepend(span);
  return span;
}

/** 要約の打ち込みを本文側へ即時反映する */
function updateInlineSummary(anchor, text, pane) {
  const el = $(`[data-anchor="${CSS.escape(anchor)}"]`, (pane || P()).el);
  if (!el) return;
  const old = el.querySelector(':scope > .note-summary');
  if (!String(text).trim()) { if (old) old.remove(); return; }
  if (old) old.textContent = text;
  else insertSummary(el, text);
}

/** 本文にぶら下げているメモを、打ち込みに合わせて即時更新する */
function updateInlineMemo(anchor, text, pane) {
  const el = $(`[data-anchor="${CSS.escape(anchor)}"]`, (pane || P()).el);
  if (!el) return;
  let div = el.querySelector(':scope > .memo-inline');
  if (!String(text).trim()) { if (div) div.remove(); return; }
  if (!div) {
    div = document.createElement('div');
    div.className = 'memo-inline';
    el.appendChild(div);
  }
  div.textContent = text;
}

/* -------------------------------------------------------------- 改正の追従 */

/*
 * 手元の法令に改正が出ていないかを e-Gov に問い合わせ、名前の横に印を出す。
 *
 *   塗りつぶし  手元より新しい版がすでに施行されている
 *   輪郭だけ    改正は公布されたが、まだ施行されていない
 *
 * 未施行のものも出すのは、読んでいる条文が近く変わると分かっていることに
 * 意味があるからである。改正を知らずに古い条文で考えるのが一番まずい。
 *
 * 結果は localStorage に置く。法令そのものではなく、問い合わせて分かった
 * ことに過ぎないので、消えても取り直せる。バックアップにも入れない。
 */
const AMEND_KEY = 'roppo.amend';
let amendState = {};

function loadAmendState() {
  try { amendState = JSON.parse(localStorage.getItem(AMEND_KEY) || '{}'); }
  catch (e) { amendState = {}; }
}

function saveAmendState() {
  try { localStorage.setItem(AMEND_KEY, JSON.stringify(amendState)); } catch (e) { /* 任意 */ }
}

function today() {
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

/* 1法令ぶんの判定。通信できないときは何も言わない（黙って古い印を残す）。 */
async function checkAmendment(law) {
  const revs = await apiRevisions(law.lawId);
  if (!revs.length) return null;

  const now = today();
  const enforced = revs.filter(r => r.amendment_enforcement_date && r.amendment_enforcement_date <= now);
  const future = revs.filter(r => r.amendment_enforcement_date && r.amendment_enforcement_date > now);

  // 施行済みのうち一番新しいもの＝いま効いている版
  enforced.sort((a, b) => (a.amendment_enforcement_date < b.amendment_enforcement_date ? -1 : 1));
  const latest = enforced[enforced.length - 1];

  // 取り込んだときの版が分からない古い記録は、施行日で見比べる
  const behind = latest && (law.lawRevisionId
    ? latest.law_revision_id !== law.lawRevisionId
    : !!(law.enforcementDate && latest.amendment_enforcement_date > law.enforcementDate));

  const rev = law.lawRevisionId || '';           // どの版について調べたか
  if (behind) {
    return {
      kind: 'behind', rev,
      date: latest.amendment_enforcement_date,
      title: latest.amendment_law_title || '',
      at: Date.now(),
    };
  }

  future.sort((a, b) => (a.amendment_enforcement_date < b.amendment_enforcement_date ? -1 : 1));
  if (future.length) {
    return {
      kind: 'upcoming', rev,
      date: future[0].amendment_enforcement_date,
      title: future[0].amendment_law_title || '',
      at: Date.now(),
    };
  }
  return { kind: 'none', rev, at: Date.now() };
}

/* 全法令ぶん。1日に1度でよいので、呼び出し側で間隔を見る。 */
async function checkAmendments(loud) {
  // 固定版（`<法令ID>@<版ID>`）は e-Gov の法令IDではないので問い合わせない。
  // その版はその版として固定したものなので、新しい版を知らせる意味もない。
  const targets = state.laws.filter(l => !l.revisionOf);
  if (!targets.length) { if (loud) toast('取り込んだ法令がありません'); return; }
  let behind = 0, upcoming = 0, failed = 0;

  for (const law of targets) {
    try {
      const r = await checkAmendment(law);
      // 問い合わせている間に消された・取り込み直された場合は書き戻さない
      const now = state.laws.find(l => l.lawId === law.lawId);
      if (!now || (now.lawRevisionId || '') !== (law.lawRevisionId || '')) continue;
      if (r) {
        amendState[law.lawId] = r;
        if (r.kind === 'behind') behind++;
        if (r.kind === 'upcoming') upcoming++;
      }
    } catch (e) {
      failed++;                    // 圏外・通信断。黙って前の印を残す
    }
  }
  // 手元に無くなった法令の判定は捨てる
  for (const id of Object.keys(amendState)) {
    if (!state.laws.some(l => l.lawId === id)) delete amendState[id];
  }
  saveAmendState();
  try { localStorage.setItem('roppo.amendCheckedAt', String(Date.now())); } catch (e) { /* 任意 */ }
  renderLawList();
  syncTopbarLaw();

  if (!loud) return;
  if (failed === targets.length) { toast('e-Gov に問い合わせできませんでした'); return; }
  const parts = [];
  if (behind) parts.push(`新しい版が出ている法令 ${behind}件`);
  if (upcoming) parts.push(`未施行の改正がある法令 ${upcoming}件`);
  // 確かめられなかったものがあるのに「すべて最新」と言ってはいけない。
  // 調べていないものを、調べて問題なかったことにしてしまう。
  if (failed) parts.push(`確かめられなかった法令 ${failed}件`);
  toast(parts.length ? parts.join('　/　') : '手元の法令はすべて最新です');
}

/* 1日に1度だけ、静かに確かめる。圏外なら何も起きない。 */
function checkAmendmentsIfStale() {
  let at = 0;
  try { at = Number(localStorage.getItem('roppo.amendCheckedAt')) || 0; } catch (e) { /* 任意 */ }
  if (Date.now() - at < 24 * 60 * 60 * 1000) return;
  checkAmendments(false).catch(() => { /* 圏外なら黙って諦める */ });
}

/*
 * まだ施行されていない版か。取り込んだ時点の判定を持ち続けると、
 * 施行日を過ぎても「未施行」と出したままになる。日付から毎回決める。
 */
function isUnenforced(rec) {
  return !!(rec && rec.revisionOf && rec.enforcementDate && rec.enforcementDate > today());
}

/*
 * 改正の印。どの版について確かめた結果かを併せて持つ。
 * 法令を削除して取り込み直すと、前の版についての判定が残って
 * 「新しい版があります」と言い続ける。版が食い違うときは印を出さない。
 */
function amendOf(law) {
  const rec = typeof law === 'string' ? state.laws.find(l => l.lawId === law) : law;
  if (!rec || rec.revisionOf) return null;          // 固定版には印を出さない
  const a = amendState[rec.lawId];
  if (!a || !a.kind || a.kind === 'none') return null;
  if ((a.rev || '') !== (rec.lawRevisionId || '')) return null;   // 確かめた版と違う
  return a;
}

/*
 * 版の一覧を出して、選んだ版を取り込む。
 *
 * 選んだ版は「別の法令」として持つ。いま読んでいる版を置き換えない。
 * 未施行の条文を覗いたせいで、いま効いている条文が手元から消えるのが
 * 一番まずい。圏外なら取り直せない。
 *
 * そのぶん、注釈は版ごとに別になる。同じ条文に見えても中身が違うので、
 * これは正しい分かれ方である。
 */
let revToken = 0;      // 開き直したとき、前の応答で上書きしないための印

async function openRevisions(lawId) {
  const law = state.laws.find(l => l.lawId === lawId);
  if (!law) return;

  // 固定版から開いたときも、問い合わせ先は必ず正規の法令IDにする。
  // `<法令ID>@<版ID>` を渡すと e-Gov に無いIDを送ることになる。
  const base = law.revisionOf || law.lawId;
  const baseLaw = state.laws.find(l => l.lawId === base);
  const baseTitle = (baseLaw && baseLaw.lawTitle) || law.baseTitle || law.lawTitle || '';

  const token = ++revToken;
  $('#rev-law').textContent = baseTitle;
  const box = $('#rev-list');
  box.innerHTML = '<p class="hint">e-Gov に問い合わせています…</p>';
  $('#dlg-revisions').showModal();

  let revs;
  try {
    revs = await apiRevisions(base);
  } catch (e) {
    if (token !== revToken) return;
    box.innerHTML = '<p class="hint">版の一覧を取得できませんでした。通信を確かめてください。</p>';
    return;
  }
  if (token !== revToken) return;   // 別の法令の一覧に切り替わっている

  // 新しい順。施行日が入っていないものは出しようがないので外す。
  revs = revs.filter(r => r.amendment_enforcement_date)
    .sort((a, b) => (a.amendment_enforcement_date < b.amendment_enforcement_date ? 1 : -1));
  if (!revs.length) { box.innerHTML = '<p class="hint">版の情報がありません。</p>'; return; }

  const now = today();
  const held = new Set(state.laws.map(l => l.lawRevisionId).filter(Boolean));

  box.innerHTML = '';
  for (const r of revs) {
    const future = r.amendment_enforcement_date > now;
    const mine = held.has(r.law_revision_id);
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="rv-date">${esc(r.amendment_enforcement_date)}</span>`
      + `<span class="rv-title">${esc(r.amendment_law_title || '')}</span>`
      + `<span class="rv-state ${mine ? 'now' : future ? 'future' : 'past'}">`
      + (mine ? '手元にある' : future ? '未施行' : '施行済み') + '</span>';
    if (mine) b.disabled = true;
    else b.onclick = () => takeRevision(base, baseTitle, baseLaw, r);
    box.appendChild(b);
  }
}

/* base は e-Gov の法令ID。固定版から辿ったときも、必ずこれを親にする。 */
async function takeRevision(base, baseTitle, baseLaw, rev) {
  const id = base + '@' + rev.law_revision_id;
  $('#dlg-revisions').close();

  if (!state.laws.some(l => l.lawId === id)) {
    toast('取り込んでいます…');
    let xml;
    try {
      xml = await apiFetchLaw(rev.law_revision_id);
    } catch (e) {
      toast('取り込めませんでした: ' + e.message);
      return;
    }
    await store.putLaw({
      lawId: id,
      lawTitle: baseTitle + '（' + rev.amendment_enforcement_date + ' 施行）',
      baseTitle,                          // 元法令を消しても名前を組み直せるように
      lawNum: baseLaw ? baseLaw.lawNum : '',
      abbrev: null,                       // 略称で引けると本来の法令と紛れる
      revisionOf: base,
      lawRevisionId: rev.law_revision_id,
      enforcementDate: rev.amendment_enforcement_date,
      amendLawTitle: rev.amendment_law_title || '',
      xml, savedAt: Date.now(),
    });
    await refreshLawList();
  }
  await navigate(id);
}

function amendTitle(a) {
  const head = a.kind === 'behind' ? '新しい版が出ています' : '未施行の改正があります';
  return head + '　施行 ' + a.date + (a.title ? '　' + a.title : '');
}

/* ------------------------------------------------------------------ 目次 */

function renderToc() {
  const ul = $('#toc-list');
  ul.innerHTML = '';
  if (!P().toc.length) {
    ul.innerHTML = '<li style="color:var(--fg-faint);cursor:default">この法令に見出しはありません</li>';
    return;
  }
  for (const e of P().toc) {
    const li = document.createElement('li');
    li.className = e.kind ? e.kind === 'suppl' ? 'suppl' : 'lv1' : 'lv' + e.level;
    li.dataset.id = e.id;
    // 範囲表記（"170:174"）は端の数字だけ使う
    const head = e.first && String(e.first).split(':')[0];
    const tail = e.last && String(e.last).split(':').pop();
    const range = (head && tail)
      ? (head === tail ? numLabel(head, '条') : `${numLabel(head, '条')}–${numLabel(tail, '条')}`)
      : '';
    li.innerHTML = `<span class="t">${esc(e.title)}</span>`
      + (range ? `<span class="range">${esc(range)}</span>` : '');
    li.onclick = () => {
      const target = $('#' + e.id, P().el);      // 両面で同じidを使うので面を限る
      if (!target) return;
      rememberPos();
      closeDrawerAfterJump();
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      pushHist({ lawId: P().current.lawId, anchor: null, scrollTop: target.offsetTop });
    };
    ul.appendChild(li);
  }
}

/* ------------------------------------------------------- マークとタグ一覧 */

/**
 * 位置を見つけられなかった文言メモを画面に出す。
 * 出さないと、消えていないのに消えたようにしか見えない。
 * 「黙って消さない」方針は、利用者が気づける形になって初めて満たされる。
 */
function renderOrphans() {
  const box = $('#orphan-box');
  const ul = $('#orphan-list');
  const list = state.orphanRanges;
  box.hidden = !list.length;
  ul.innerHTML = '';
  if (!list.length) return;
  $('#orphan-count').textContent = list.length + '件';

  for (const r of list) {
    const law = state.laws.find(l => l.lawId === r.lawId);
    const li = document.createElement('li');
    li.innerHTML = `<div class="phrase">${esc(r.text)}</div>`
      + `<div class="where">${esc(law ? law.lawTitle : r.lawId)}　${esc(anchorLabel(r.anchor))}`
      + '　本文に見つかりません</div>'
      + (r.memo ? `<div class="where">${esc(r.memo.slice(0, 60))}</div>` : '')
      + '<div class="acts"><button class="mini go">その条文へ</button>'
      + '<button class="mini del">削除</button></div>';
    li.querySelector('.go').onclick = () => navigate(r.lawId, r.anchor);
    li.querySelector('.del').onclick = async () => {
      if (!confirm(`「${r.text}」の文言メモを削除します。よろしいですか？`)) return;
      await deleteRange(r.id);
    };
    ul.appendChild(li);
  }
}

/*
 * 自分で書いたものを1つの形に揃える。
 *
 * 条項号への注釈（state.notes）と、文言への注釈（state.ranges）は
 * 保存先も指す場所も違うが、「あとで引きたい」という点では同じである。
 * 一覧が片方しか集めていないと、色もタグも付けずにメモだけ書いた場所や、
 * 文言に塗った色が、どこからも辿れなくなる。語を覚えていないと探せない。
 */
function allMarks() {
  const out = [];
  for (const n of state.notes.values()) {
    out.push({
      kind: 'note', lawId: n.lawId, anchor: n.anchor,
      color: n.color || '', tags: n.tags || [],
      memo: [n.summary, n.memo].map(t => String(t || '').trim()).filter(Boolean).join('　'),
      phrase: '',
    });
  }
  for (const r of state.ranges.values()) {
    out.push({
      kind: 'range', id: r.id, lawId: r.lawId, anchor: r.anchor,
      color: r.color || '', tags: [],
      memo: String(r.memo || '').trim(),
      phrase: r.text || '',
    });
  }
  return out;
}

function renderMarkList() {
  const marks = allMarks();
  const byColor = new Map();
  const byTag = new Map();
  let memoCount = 0;
  for (const m of marks) {
    if (m.color) byColor.set(m.color, (byColor.get(m.color) || 0) + 1);
    for (const t of m.tags) byTag.set(t, (byTag.get(t) || 0) + 1);
    if (m.memo) memoCount++;
  }

  const ml = $('#mark-list');
  ml.innerHTML = '';
  const used = MARK_COLORS.filter(c => byColor.get(c.key));
  if (!used.length && !memoCount) {
    ml.innerHTML = '<li style="color:var(--fg-faint);cursor:default">まだありません</li>';
  }
  for (const c of used) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="sw" style="background:var(--mk-${c.key})"></span>`
      + `<span>${esc(c.label)}</span><span class="n">${byColor.get(c.key)}</span>`;
    li.onclick = () => showMarkResults(m => m.color === c.key, `${c.label}のマーク`);
    ml.appendChild(li);
  }
  if (memoCount) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="sw" style="background:var(--ink)"></span>'
      + `<span>メモのあるもの</span><span class="n">${memoCount}</span>`;
    li.onclick = () => showMarkResults(m => !!m.memo, 'メモ');
    ml.appendChild(li);
  }

  const tl = $('#tag-list');
  tl.innerHTML = '';
  if (!byTag.size) {
    tl.innerHTML = '<li style="color:var(--fg-faint);cursor:default">まだありません</li>';
    return;
  }
  for (const [tag, n] of [...byTag].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(tag)}</span><span class="n">${n}</span>`;
    li.onclick = () => showMarkResults(m => m.tags.includes(tag), `タグ「${tag}」`);
    tl.appendChild(li);
  }
}

function renderNotePane() {
  const body = $('#notes-body');
  if (!P().current || !state.selected) return;
  const pane = P();
  const lawId = pane.current.lawId;
  const anchor = state.selected;
  const key = noteKey(lawId, anchor);
  const note = state.notes.get(key)
    || { key, lawId, anchor, tags: [], summary: '', memo: '', color: '' };
  const entry = P().index.find(e => e.anchor === anchor);

  body.innerHTML = `
    <div class="note-quote">${esc(entry ? entry.text : '')}</div>
    <p class="note-label">マーク</p>
    <div class="palette" id="palette"></div>
    <p class="note-label">前メモ</p>
    <input id="summary-input" type="text" placeholder="この条文を一言でいうと" autocomplete="off">
    <p class="note-label">文字タグ</p>
    <div class="note-tags" id="tag-chips"></div>
    <input id="tag-input" type="text" placeholder="タグを入力して Enter" autocomplete="off">
    <div class="tag-known" id="tag-known"></div>
    <p class="note-label">後メモ</p>
    <textarea id="memo-input" placeholder="詳しく書き足したいこと"></textarea>
    <div class="saved-at" id="saved-at"></div>
  `;

  const palette = $('#palette');
  const paintPalette = () => {
    palette.innerHTML = '';
    for (const c of MARK_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = c.label;
      b.style.background = `var(--mk-${c.key})`;
      if (note.color === c.key) b.classList.add('on');
      b.onclick = async () => {
        note.color = note.color === c.key ? '' : c.key;   // 同じ色を押したら外す
        await saveNote(note);
        paintPalette();
      };
      palette.appendChild(b);
    }
    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'none';
    none.title = 'マークなし';
    none.textContent = '／';
    if (!note.color) none.classList.add('on');
    none.onclick = async () => { note.color = ''; await saveNote(note); paintPalette(); };
    palette.appendChild(none);
  };
  paintPalette();

  let paintKnownRef = () => {};      // 下で定義する（タグを外したときも候補を出し直す）

  const chips = $('#tag-chips');
  const paintChips = () => {
    chips.innerHTML = '';
    for (const t of note.tags) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = `${esc(t)}<button title="外す">×</button>`;
      c.querySelector('button').onclick = async () => {
        note.tags = note.tags.filter(x => x !== t);
        await saveNote(note);
        paintChips();
        if ($('#tag-known')) paintKnownRef();
      };
      chips.appendChild(c);
    }
  };
  paintChips();

  /*
   * 使ったことのあるタグを押して付けられるようにする。
   * 同じタグを続けて付けるとき、毎回同じ文字を打つのは無駄である。
   * 打ち込みも残す。新しいタグはそちらで足す。
   */
  const known = $('#tag-known');
  const paintKnown = () => {
    const count = new Map();
    for (const n of state.notes.values()) {
      for (const t of (n.tags || [])) count.set(t, (count.get(t) || 0) + 1);
    }
    const list = [...count]
      .filter(([t]) => !note.tags.includes(t))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
      .slice(0, 12);
    known.innerHTML = '';
    for (const [t] of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tag-known-btn';
      b.textContent = t;
      b.onclick = async () => {
        note.tags.push(t);
        await saveNote(note);
        paintChips();
        paintKnownRef = paintKnown;
  paintKnown();
      };
      known.appendChild(b);
    }
  };

  const addTag = async v => {
    if (!v || note.tags.includes(v)) return;
    note.tags.push(v);
    await saveNote(note);
    paintChips();
    paintKnown();
  };

  const tagInput = $('#tag-input');
  tagInput.onkeydown = async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = tagInput.value.trim();
    tagInput.value = '';
    await addTag(v);
  };
  paintKnown();

  const summary = $('#summary-input');
  summary.value = note.summary || '';
  summary.oninput = () => {
    note.summary = summary.value;
    updateInlineSummary(anchor, summary.value, pane);
    scheduleSave(note);
  };
  summary.onblur = () => flushSave();

  const memo = $('#memo-input');
  memo.value = note.memo || '';
  // 入力は即座に note へ反映し、DB 書き込みだけを遅らせる。
  // こうしないと、500ms 以内に条文を切り替えたときに古い状態で上書きされる。
  memo.oninput = () => {
    note.memo = memo.value;
    updateInlineMemo(anchor, memo.value, pane);   // 本文側のぶら下げ表示は即座に追従させる
    scheduleSave(note);
  };
  memo.onblur = () => flushSave();

  $('#saved-at').textContent = note.updatedAt
    ? '最終更新 ' + new Date(note.updatedAt).toLocaleString('ja-JP') : '';
}

async function saveNote(note) {
  note.updatedAt = Date.now();
  try {
    if (!note.tags.length && !(note.memo || '').trim()
      && !(note.summary || '').trim() && !note.color) {
      await store.delNote(note.key);
      state.notes.delete(note.key);
    } else {
      await store.putNote(note);
      state.notes.set(note.key, note);
    }
  } catch (err) {
    toast('保存できませんでした: ' + err.message);
    return;
  }
  renderMarkList();
  renderFilterPicker();
  paintNotes();
  paintRanges();
  if (state.selected) {
    const el = $(`[data-anchor="${CSS.escape(state.selected)}"]`, P().el);
    if (el) el.classList.add('sel');
  }
  const at = $('#saved-at');
  if (at && state.selected === note.anchor && P().current && P().current.lawId === note.lawId) {
    at.textContent = '最終更新 ' + new Date(note.updatedAt).toLocaleString('ja-JP');
  }
}

/* ------------------------------------------------------ 文言へのメモ（範囲） */


async function loadRanges() {
  state.ranges = new Map((await store.allRanges()).map(r => [r.id, r]));
}

/** 現在の法令の範囲注釈を本文に塗る。位置が見つからないものは印を付けて残す。 */
function paintRanges() {
  state.orphanRanges = [];
  for (const pane of livePanes()) paintRangesIn(pane);
  renderOrphans();
}

function paintRangesIn(pane) {
  for (const m of $$('mark[data-range-id]', pane.el)) {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    m.remove();
    parent.normalize();
  }
  if (!pane.current) return;

  for (const r of state.ranges.values()) {
    if (r.lawId !== pane.current.lawId) continue;
    const el = $(`[data-anchor="${CSS.escape(r.anchor)}"]`, pane.el);
    if (!el) { state.orphanRanges.push(r); continue; }
    const map = textMapOf(el);
    // 指定の出現が無いときに最初の一致へ寄せると、別の文言に注釈が移ってしまう。
    // 「黙って別の場所に付けない」方針のとおり、見つからなければ要確認にする。
    const at = nthIndexOf(map.text, r.text, r.nth || 1);
    if (at < 0) { state.orphanRanges.push(r); continue; }
    wrapInMap(el, at, at + r.text.length,
      'rng' + (r.color ? ' rng-' + r.color : '') + (r.memo ? ' has-memo' : ''), r.id);
  }
}

/** 選択範囲から範囲注釈を作る。単一の条項号の中に収まっている場合だけ。 */
function rangeFromSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const el = r.startContainer.parentElement && r.startContainer.parentElement.closest('[data-anchor]');
  if (!el) return null;
  if (!el.contains(r.endContainer)) return null;            // 条文をまたぐ選択は受けない
  const endEl = r.endContainer.parentElement && r.endContainer.parentElement.closest('[data-anchor]');
  if (endEl !== el) return null;

  const map = textMapOf(el);
  const s = posInMap(map, r.startContainer, r.startOffset);
  const e = posInMap(map, r.endContainer, r.endOffset);
  if (s < 0 || e < 0 || e <= s) return null;

  // 前後の空白を落とすときは、数える基準の位置も一緒にずらす。
  // ずらさないと「甲、 甲」の後半を選んでも1番目の甲に付いてしまう。
  const picked = map.text.slice(s, e);
  const lead = picked.length - picked.replace(/^\s+/, '').length;
  const trail = picked.length - picked.replace(/\s+$/, '').length;
  const s2 = s + lead;
  const text = map.text.slice(s2, e - trail);
  if (!text) return null;

  // 同じ文言が何度も出る条文があるので、何番目の出現かを数えておく
  let nth = 0;
  for (let i = map.text.indexOf(text); i >= 0 && i <= s2; i = map.text.indexOf(text, i + 1)) nth++;

  return { anchor: el.dataset.anchor, text, nth: Math.max(1, nth), el };
}

async function saveRange(rec) {
  rec.updatedAt = Date.now();
  try {
    await store.putRange(rec);
  } catch (err) {
    toast('文言メモを保存できませんでした: ' + err.message);
    return;
  }
  state.ranges.set(rec.id, rec);
  paintRanges();
  renderMarkList();
  renderFilterPicker();
}

async function deleteRange(id) {
  await store.delRange(id);
  state.ranges.delete(id);
  paintRanges();
  renderMarkList();
  renderFilterPicker();
  closePopover();
}

/* ----------------------------------------------------------- 括弧書き */

/*
 * 法令の一文は括弧書きで長く伸びる。主文を追えるように、括弧の中を薄くする。
 * 括弧は入れ子になる（「（…（…）…）」）ので深さを数え、深いほど薄くする。
 *
 * 薄くするかどうかは CSS 側で切り替える。ここでは常に印を付けておき、
 * 設定を変えるたびに本文を組み直さなくて済むようにする。
 */
function paintParens(pane) {
  for (const el of $$('.para[data-anchor], .item[data-anchor]', pane.el)) {
    const map = textMapOf(el);
    const t = map.text;
    if (!t.includes('（')) continue;

    // 1文字ずつ深さを数える
    const depth = new Array(t.length).fill(0);
    let d = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '（') d++;
      depth[i] = d;                       // 括弧そのものも中身と同じ深さにする
      if (t[i] === '）') d = Math.max(0, d - 1);
    }

    // 深さが同じ区間をまとめて包む。後ろから当てて位置がずれないようにする。
    const runs = [];
    for (let i = 0; i < t.length;) {
      if (depth[i] === 0) { i++; continue; }
      let j = i;
      while (j < t.length && depth[j] === depth[i]) j++;
      runs.push({ s: i, e: j, d: depth[i] });
      i = j;
    }
    for (let k = runs.length - 1; k >= 0; k--) {
      const r = runs[k];
      wrapInMap(el, r.s, r.e, 'paren p' + Math.min(r.d, 3), 'paren', 'span');
    }
  }
}

/* --------------------------------------------------------- メモの吹き出し */

let tipTimer = null;

function showTip(el, head, body) {
  const tip = $('#tip');
  tip.innerHTML = `<div class="tip-head">${esc(head)}</div>${esc(body)}`;
  tip.hidden = false;

  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight, pad = 10;
  tip.style.left = Math.min(Math.max(pad, r.left), window.innerWidth - w - pad) + 'px';
  const above = r.top - h - 8;
  tip.style.top = (above >= pad ? above : r.bottom + 8) + 'px';
}

function hideTip() {
  clearTimeout(tipTimer);
  $('#tip').hidden = true;
}

/**
 * カーソルを合わせたらメモを出す。
 * 文言メモは常に、条項号のメモは本文にぶら下げていないときだけ。
 */
function handleHover(e) {
  if (annotMode() === 'none') { hideTip(); return; }

  const mk = e.target.closest && e.target.closest('mark[data-range-id]');
  if (mk) {
    const rec = state.ranges.get(mk.dataset.rangeId);
    if (rec && rec.memo) {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(mk, anchorLabel(rec.anchor) + '　の文言', rec.memo), 150);
      return;
    }
  }

  if (annotMode() !== 'all') {
    const el = e.target.closest && e.target.closest('[data-anchor]');
    // 操作中の面ではなく、カーソルがある面の法令で引く
    const pane = el && paneOf(el);
    if (el && pane && pane.current) {
      const n = state.notes.get(noteKey(pane.current.lawId, el.dataset.anchor));
      if (n && n.memo) {
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => showTip(el, anchorLabel(el.dataset.anchor), n.memo), 150);
        return;
      }
    }
  }
  hideTip();
}

const annotMode = () => document.documentElement.dataset.annot || 'all';

/** 選択直後に出る小さな色バー */
function showSelBar() {
  const bar = $('#selbar');
  const info = rangeFromSelection();
  if (!info) { bar.hidden = true; return; }

  const sel = window.getSelection();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  bar.hidden = false;
  const w = bar.offsetWidth, h = bar.offsetHeight, pad = 12;
  bar.style.left = Math.min(Math.max(pad, rect.left + rect.width / 2 - w / 2),
    window.innerWidth - w - pad) + 'px';

  /*
   * 選択の「下」に出す。
   * iOS は選択すると「コピー・調べる」を選択の上に出してくるので、
   * こちらも上に出すと重なって押せなくなる。下なら競合しない。
   * 下に入らないときだけ上へ回す。
   */
  const barEl = $('#bottombar');
  const floor = window.innerHeight - pad
    - (barEl && !barEl.hidden ? barEl.offsetHeight : 0);
  let top = rect.bottom + 10;
  if (top + h > floor) top = rect.top - h - 10;
  bar.style.top = Math.max(pad, top) + 'px';
  bar.dataset.pending = JSON.stringify({ anchor: info.anchor, text: info.text, nth: info.nth });
}

function hideSelBar() { $('#selbar').hidden = true; }

async function createRangeFrom(color, openMemo) {
  const bar = $('#selbar');
  let pending;
  try { pending = JSON.parse(bar.dataset.pending || 'null'); } catch (e) { pending = null; }
  if (!pending || !P().current) return;

  const rec = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    lawId: P().current.lawId,
    anchor: pending.anchor,
    text: pending.text,
    nth: pending.nth,
    color: color || 'yellow',
    memo: '',
  };
  await saveRange(rec);
  window.getSelection().removeAllRanges();
  hideSelBar();
  if (openMemo) openRangePopover(rec.id);
}

/* ------------------------------------------------------------ ジャンプ */

/*
 * 法令名の略称。e-Gov も Abbrev を持っている（国賠法など）が、
 * 「民訴」「刑訴」のような普段使いの呼び方は入っていないので足しておく。
 */
const LAW_ALIASES = {
  民訴: '民事訴訟法', 刑訴: '刑事訴訟法', 民執: '民事執行法', 民保: '民事保全法',
  行訴: '行政事件訴訟法', 行手: '行政手続法', 行審: '行政不服審査法',
  労基: '労働基準法', 労基法: '労働基準法', 労契法: '労働契約法',
  国賠: '国家賠償法', 独禁法: '私的独占の禁止及び公正取引の確保に関する法律',
  不競法: '不正競争防止法', 地自法: '地方自治法', 会更: '会社更生法', 民再: '民事再生法',
  憲法: '日本国憲法',
};

/**
 * 入力の先頭から法令名を切り出す。「民法709」「刑訴220条2項」の形に対応する。
 * 取込済みの法令名・略称と、上の対応表の両方を見る。長い名前を優先する。
 */
function splitLawPrefix(input) {
  const s = String(input).normalize('NFKC').replace(/\s/g, '');
  const names = [];
  for (const l of state.laws) {
    if (l.lawTitle) names.push([l.lawTitle, l]);
    if (l.abbrev) names.push([l.abbrev, l]);
  }
  for (const [alias, title] of Object.entries(LAW_ALIASES)) {
    const l = state.laws.find(x => x.lawTitle === title);
    if (l) names.push([alias, l]);
  }
  names.sort((a, b) => b[0].length - a[0].length);

  for (const [name, law] of names) {
    if (s.length > name.length && s.startsWith(name)) {
      return { law, rest: s.slice(name.length) };
    }
  }
  return { law: null, rest: s };
}

/**
 * 「709」「709条2項」「第三条の二」「3の2の3」「709条3号」などを解釈する。
 * 枝番は「条」の前でも後でも、何段でも受け付ける。
 */
function parseJump(input) {
  let s = String(input).normalize('NFKC').replace(/\s/g, '');
  if (!s) return null;

  const head = s.match(new RegExp('^第?' + NUM_SRC));
  if (!head) return null;
  const parts = [kanjiToNum(head[1])];
  s = s.slice(head[0].length);

  const eatBranches = () => {
    let m;
    while ((m = s.match(new RegExp('^[のノ_-]' + NUM_SRC)))) {
      parts.push(kanjiToNum(m[1]));
      s = s.slice(m[0].length);
    }
  };
  eatBranches();
  if (s.startsWith('条')) { s = s.slice(1); eatBranches(); }
  if (parts.some(isNaN)) return null;

  let par = null, item = null;
  let m = s.match(new RegExp('^第?' + NUM_SRC + '項'));
  if (m) { par = kanjiToNum(m[1]); s = s.slice(m[0].length); }
  m = s.match(new RegExp('^第?' + NUM_SRC + '号'));
  if (m) { item = kanjiToNum(m[1]); s = s.slice(m[0].length); }

  if (s) return null;                                  // 余りがあれば解釈失敗
  if ((par !== null && isNaN(par)) || (item !== null && isNaN(item))) return null;

  return {
    art: parts.join('_'),
    par: par === null ? null : String(par),
    item: item === null ? null : String(item),
  };
}

/*
 * アンカーから要素を引く。描画のときに作った対応表を先に見る。
 * 属性セレクタは要素を端から見ていくので、会社法のように6,000件あると
 * 一回引くだけで数十ミリ秒かかる。下見は打つたびに引くので、そこが響く。
 * 表が古くなっている場合（差し替えられた要素）は、従来どおり探し直す。
 */
function findAnchorEl(anchor, pane) {
  const pn = pane || P();
  const hit = pn.elOf && pn.elOf.get(anchor);
  if (hit && hit.isConnected) return hit;
  return $(`[data-anchor="${CSS.escape(anchor)}"]`, pn.el);
}

function indexAnchorEls(pane) {
  pane.elOf = new Map();
  for (const el of pane.el.querySelectorAll('[data-anchor]')) {
    if (!pane.elOf.has(el.dataset.anchor)) pane.elOf.set(el.dataset.anchor, el);
  }
}

/*
 * 番号から行き先を探すための表を、描画のときに一度だけ作る。
 *
 * 作る前は、打つたびに scope の数だけ DOM を引き、さらに索引を端から端まで
 * 走査していた。会社法は索引が6,000件あり scope も30を超えるので、下見を
 * 出すたびにそれが繰り返される。外れの番号ほど重くなり、打っている手が止まる。
 */
function buildJumpTables(pane, index) {
  pane.anchors = new Set();
  pane.itemOfArt = new Map();     // 「scope/条/号」→ その号のアンカー
  pane.rangedOf = new Map();      // scope → 削除条の範囲アンカー（170:174 の形）

  for (const e of index) {
    const a = e.anchor.split('/');
    pane.anchors.add(e.anchor);
    if (a.length === 4) {
      const key = a[0] + '/' + a[1] + '/' + a[3];
      if (!pane.itemOfArt.has(key)) pane.itemOfArt.set(key, e.anchor);   // 先に出てくる項を優先
    }
    if (a.length === 2 && a[1].includes(':')) {
      if (!pane.rangedOf.has(a[0])) pane.rangedOf.set(a[0], []);
      pane.rangedOf.get(a[0]).push(e.anchor);
    }
  }
  // 本則を先に、次に附則・別表を現れた順で
  pane.scopes = ['M', ...new Set(index.map(e => e.anchor.split('/')[0]).filter(s => s !== 'M'))];
}

async function doJump() {
  const raw = $('#jump-input').value.trim();
  if (!raw) return;

  // 「民法709」のように法令名が前に付いていれば、その法令に切り替えてから引く
  const { law, rest } = splitLawPrefix(raw);
  if (law && (!P().current || P().current.lawId !== law.lawId)) {
    await navigate(law.lawId);
  }
  if (!P().current) { toast('先に法令を開いてください'); return; }

  const p = parseJump(law ? rest : raw);
  if (!p) { toast('条文番号として読み取れません'); return; }

  const r = resolveJump(p);
  if (!r) { toast(`${numLabel(p.art, '条')}は見つかりません`); return; }
  if (r.note) toast(r.note);

  closeDrawerAfterJump();   // 同じ法令の中で引くときは navigate を通らない
  rememberPos();
  if (scrollToAnchor(r.anchor, false)) {
    pushHist({ lawId: P().current.lawId, anchor: r.anchor, scrollTop: 0 });
  }
}

/*
 * 打たれた番号が、いま開いている法令のどこを指すのかを決める。飛ばしはしない。
 * 引くときと、打ちかけの下見（updateJumpPreview）の両方がここを通る。
 * 二つに分けて書くと、下見と実際の行き先がずれる。
 */
function resolveJump(p, pane) {
  const pn = pane || P();
  if (!pn.anchors) return null;               // まだ描画していない
  const has = a => pn.anchors.has(a);

  for (const sc of pn.scopes) {
    // 項と号の両方が指定されている
    const full = `${sc}/${p.art}/${p.par}/${p.item}`;
    if (p.par && p.item && has(full)) return { anchor: full };

    // 項を省いた号指定（例: 709条3号）
    if (!p.par && p.item) {
      const hit = pn.itemOfArt.get(`${sc}/${p.art}/${p.item}`);
      if (hit) return { anchor: hit };
    }

    const par = `${sc}/${p.art}/${p.par}`;
    if (p.par && has(par)) {
      return {
        anchor: par,
        note: p.item ? `第${p.item}号は見つからないため、項までで止めました` : '',
      };
    }

    const art = `${sc}/${p.art}`;
    if (has(art)) {
      return {
        anchor: art,
        note: (p.par || p.item) ? '指定の項・号は見つからないため、条までで止めました' : '',
      };
    }

    // 削除された条は "170:174" のような範囲でまとめられている
    for (const a of (pn.rangedOf.get(sc) || [])) {
      if (numInRange(a.split('/')[1], p.art)) {
        return {
          anchor: a,
          note: `${numLabel(p.art, '条')}は${numLabel(a.split('/')[1], '条')}にまとめられています`,
        };
      }
    }
  }
  return null;
}

/*
 * 打ちかけの番号が指す条文の頭を出す。
 * 番号を打っても、それが目当ての条文かどうかは飛んでみるまで分からない。
 * 先に頭の一文が見えれば、引く前に気づける。打ち間違いにも気づける。
 */
function updateJumpPreview() {
  const box = $('#jump-preview');
  if (!box) return;
  const raw = $('#jump-input').value.trim();
  if (!raw || !P().current) { box.hidden = true; return; }

  const show = (label, body, miss) => {
    box.hidden = false;
    box.classList.toggle('miss', !!miss);
    box.innerHTML = `<span class="pv-label">${esc(label)}</span>`
      + `<span class="pv-text">${esc(body)}</span>`;
  };

  const { law, rest } = splitLawPrefix(raw);
  // 別の法令を指しているときは、開いてみないと中身が読めない
  if (law && law.lawId !== P().current.lawId) {
    show(law.lawTitle, '「引く」を押すと開きます', true);
    return;
  }

  const p = parseJump(law ? rest : raw);
  const r = p && resolveJump(p);
  if (!r) { show(raw, '見つかりません', true); return; }

  const el = findAnchorEl(r.anchor);
  if (!el) { box.hidden = true; return; }
  show(anchorLabel(r.anchor), previewTextOf(el), false);
}

/** 下見に出す文字。自分で書いたメモ・タグ・ルビの読みは混ぜない。 */
function previewTextOf(el) {
  const clone = el.cloneNode(true);
  for (const n of clone.querySelectorAll('.memo-inline, .inline-tags, .note-summary, rt')) n.remove();
  return clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/* -------------------------------------------------------------- 全文検索 */

async function indexFor(lawId) {
  if (state.indexCache.has(lawId)) return state.indexCache.get(lawId);
  const rec = await store.getLaw(lawId);
  if (!rec) return [];
  const { index } = renderLaw(parseXML(rec.xml).querySelector('Law'));
  state.indexCache.set(lawId, index);
  return index;
}

const FIND_LIMIT = 500;

/*
 * 検索。2面にしてから「どちらの法令を探しているのか」が分からなくなったので、
 * 範囲を明示して選べるようにし、結果は左ペインに残す。
 */
const find = {
  q: '', where: 'law', inText: true, inNotes: true,
  results: [], at: -1, truncated: false, scopeLawId: null,
};
let findToken = 0;      // 検索が重なったとき、古い実行の結果を捨てるための印

async function doFind() {
  const raw = $('#find-input').value.trim();
  find.q = raw;
  if (!raw) { clearFind(); return; }
  const q = normalize(raw);
  if (!q) { clearFind(); return; }

  const laws = find.where === 'law'
    ? (P().current ? [state.laws.find(l => l.lawId === P().current.lawId)].filter(Boolean) : [])
    : state.laws;

  const token = ++findToken;
  const results = [];
  let truncated = false;

  if (find.inText) {
    for (const law of laws) {
      const idx = await indexFor(law.lawId);
      if (token !== findToken) return;       // 新しい検索が始まっていたら捨てる
      for (const e of idx) {
        const at = e.norm.indexOf(q);
        if (at < 0) continue;
        if (results.length >= FIND_LIMIT) { truncated = true; break; }
        results.push({
          kind: '本文', lawId: law.lawId, lawTitle: law.lawTitle,
          anchor: e.anchor, text: e.text, at,
        });
      }
      if (truncated) break;
    }
  }

  if (find.inNotes) {
    const ids = new Set(laws.map(l => l.lawId));
    for (const n of state.notes.values()) {
      if (!ids.has(n.lawId)) continue;
      if (!normalize((n.summary || '') + ' ' + (n.memo || '') + ' ' + (n.tags || []).join(' ')).includes(q)) continue;
      const law = state.laws.find(l => l.lawId === n.lawId);
      results.push({
        kind: 'メモ', lawId: n.lawId, lawTitle: law ? law.lawTitle : n.lawId,
        anchor: n.anchor,
        text: [n.summary, n.memo, (n.tags || []).join(' ')].filter(Boolean).join('　'), at: 0,
      });
    }
    for (const r of state.ranges.values()) {
      if (!ids.has(r.lawId)) continue;
      if (!normalize((r.memo || '') + ' ' + r.text).includes(q)) continue;
      const law = state.laws.find(l => l.lawId === r.lawId);
      results.push({
        kind: '文言', lawId: r.lawId, lawTitle: law ? law.lawTitle : r.lawId,
        anchor: r.anchor, text: r.text + (r.memo ? '　' + r.memo : ''), at: 0,
      });
    }
  }

  if (token !== findToken) return;
  find.results = results;
  find.truncated = truncated;
  find.at = -1;
  find.scopeLawId = find.where === 'law' && P().current ? P().current.lawId : null;

  if (!narrow()) switchTab('find');   // 狭い画面では結果はシートの中。左ペインは触らない
  renderFindList();
  paintFindHits();
}

function clearFind() {
  find.results = [];
  find.at = -1;
  renderFindList();
  paintFindHits();
}

/**
 * 正規化した文字列で探し、元の文字列での範囲に戻す。
 * 索引は NFKC・空白除去・小文字化した文字列で作っているので、
 * 元の本文へそのまま indexOf すると全角半角や大小の違いで当たらない。
 */
function normalizedRanges(text, q) {
  const idx = [];
  let norm = '';
  for (let i = 0; i < text.length; i++) {
    const n = normalize(text[i]);
    for (let k = 0; k < n.length; k++) idx.push(i);
    norm += n;
  }
  const out = [];
  let from = 0;
  for (;;) {
    const at = norm.indexOf(q, from);
    if (at < 0) break;
    const s = idx[at];
    const last = idx[at + q.length - 1];
    out.push([s, (last === undefined ? text.length - 1 : last) + 1]);
    from = at + q.length;
  }
  return out;
}

/** 本文中の一致語を光らせる。操作対象の面の、いま開いている法令だけ。 */
function paintFindHits() {
  for (const pane of livePanes()) {
    for (const m of $$('mark.hit', pane.el)) {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      m.remove();
      parent.normalize();
    }
  }
  const q = normalize(find.q);
  if (!q || !find.inText) return;

  for (const pane of livePanes()) {
    if (!pane.current) continue;
    const anchors = new Set(find.results
      .filter(r => r.lawId === pane.current.lawId && r.kind === '本文')
      .map(r => r.anchor));
    for (const anchor of anchors) {
      const el = $(`[data-anchor="${CSS.escape(anchor)}"]`, pane.el);
      if (!el) continue;
      const map = textMapOf(el);
      for (const [s2, e2] of normalizedRanges(map.text, q)) {
        wrapInMap(el, s2, e2, 'hit', 'find', 'mark');
      }
    }
  }
}

function renderFindList() {
  const ul = $('#find-list');
  const status = $('#find-status');
  ul.innerHTML = '';

  const where = find.where === 'law'
    ? (P().current ? P().current.lawTitle : '法令未選択') : `全法令（${state.laws.length}件）`;
  status.innerHTML = find.q
    ? `<span class="q">${esc(find.q)}</span> を ${esc(where)} から　${find.results.length}件`
      + (find.truncated ? '（上限で打ち切り）' : '')
    : `${esc(where)} を対象に検索します`;

  if (!find.q) return;
  if (!find.results.length) {
    ul.innerHTML = '<li style="color:var(--fg-faint);cursor:default">見つかりませんでした</li>';
    return;
  }

  find.results.forEach((r, i) => {
    const li = document.createElement('li');
    if (i === find.at) li.className = 'current';
    li.innerHTML = `<div class="where"><span class="kind">${esc(r.kind)}</span>`
      + (find.where === 'all' ? `<span class="lawname">${esc(r.lawTitle)}</span>　` : '')
      + `${esc(anchorLabel(r.anchor))}</div>`
      + `<div class="snip">${snippet(r.text, r.at, find.q.length)}</div>`;
    li.onclick = () => gotoFindResult(i);
    ul.appendChild(li);
  });
}

async function gotoFindResult(i) {
  const r = find.results[i];
  if (!r) return;
  find.at = i;
  await navigate(r.lawId, r.anchor);
  paintFindHits();
  const el = $(`[data-anchor="${CSS.escape(r.anchor)}"] mark.hit`, P().el);
  if (el) el.classList.add('cur');
  renderFindList();
  const li = $$('#find-list li')[i];
  if (li) li.scrollIntoView({ block: 'nearest' });
}

function stepFind(d) {
  if (!find.results.length) return;
  const n = find.at < 0 ? 0 : (find.at + d + find.results.length) % find.results.length;
  gotoFindResult(n);
}

/**
 * 抜粋を作る。一致位置は正規化後の文字列で得ているので、
 * 元の文字列へそのまま当てるとずれる。正規化しながら対応表を作って戻す。
 */
function snippet(text, normAt, qlen) {
  let acc = 0, startRaw = -1, endRaw = -1;
  for (let i = 0; i < text.length; i++) {
    const n = normalize(text[i]);
    if (startRaw < 0 && acc + n.length > normAt) startRaw = i;
    acc += n.length;
    if (endRaw < 0 && acc >= normAt + qlen) { endRaw = i + 1; break; }
  }
  if (startRaw < 0) startRaw = 0;
  if (endRaw < 0) endRaw = Math.min(text.length, startRaw + qlen);
  const s = Math.max(0, startRaw - 22);
  const e = Math.min(text.length, endRaw + 34);
  return (s > 0 ? '…' : '') + esc(text.slice(s, startRaw))
    + '<mark class="hit">' + esc(text.slice(startRaw, endRaw)) + '</mark>'
    + esc(text.slice(endRaw, e)) + (e < text.length ? '…' : '');
}

function showMarkResults(pred, title) {
  const box = $('#find-results');
  const hits = allMarks().filter(pred);
  $('#find-count').textContent = `${title}　${hits.length}件`;
  box.innerHTML = '';
  for (const m of hits) {
    const law = state.laws.find(l => l.lawId === m.lawId);
    const idx = state.indexCache.get(m.lawId);
    const entry = idx && idx.find(e => e.anchor === m.anchor);
    const d = document.createElement('div');
    d.className = 'r';
    d.innerHTML = '<div class="sub">'
      + (m.color ? `<span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--mk-${m.color});vertical-align:-1px;margin-right:6px"></span>` : '')
      + `${esc(law ? law.lawTitle : m.lawId)}　${esc(anchorLabel(m.anchor))}`
      + (m.kind === 'range' ? '　<span style="color:var(--fg-faint)">文言</span>' : '')
      + '</div>'
      // 文言に付けたものは、その文言そのものを出す。条文の頭だけでは見分けられない。
      + (m.phrase ? `<div class="snippet">「${esc(m.phrase.slice(0, 60))}」</div>`
        : entry ? `<div class="snippet">${esc(entry.text.slice(0, 110))}</div>` : '')
      + (m.memo ? `<div class="snippet" style="color:var(--fg-dim)">📝 ${esc(m.memo.slice(0, 80))}</div>` : '');
    d.onclick = () => { $('#dlg-find').close(); navigate(m.lawId, m.anchor); };
    box.appendChild(d);
  }
  $('#dlg-find').showModal();
}

/* -------------------------------------------------------- 書き出しと復元 */

const BACKUP_VERSION = 1;

function download(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

/** 全法令（無加工のXML）と全注釈を1ファイルに。これがあれば完全に戻せる。 */
async function exportBackup() {
  const laws = await store.allLaws();
  const notes = await store.allNotes();
  const ranges = await store.allRanges();
  const data = {
    format: 'roppo-backup',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    laws,                 // xml を無加工のまま含む
    notes,                // 条・項・号への注釈
    ranges,               // 文言への注釈
  };
  download(`roppo-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
  toast(`法令 ${laws.length}件 / 注釈 ${notes.length + ranges.length}件 を書き出しました`);
}

/**
 * バックアップから復元する。
 * 注釈は updatedAt が新しい方を残す（古い書き出しで上書きしないため）。
 */
async function importBackup(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { toast('JSONとして読めません'); return; }
  if (data.format !== 'roppo-backup') { toast('このアプリのバックアップではありません'); return; }

  let addedLaws = 0, addedNotes = 0, keptNewer = 0;
  for (const law of data.laws || []) {
    if (!law.lawId || !law.xml) continue;
    await store.putLaw(law);
    state.indexCache.delete(law.lawId);
    addedLaws++;
  }
  for (const n of data.notes || []) {
    if (!n.key) continue;
    const cur = state.notes.get(n.key);
    if (cur && (cur.updatedAt || 0) > (n.updatedAt || 0)) { keptNewer++; continue; }
    await store.putNote(n);
    addedNotes++;
  }
  for (const r of data.ranges || []) {
    if (!r.id) continue;
    const cur = state.ranges.get(r.id);
    if (cur && (cur.updatedAt || 0) > (r.updatedAt || 0)) { keptNewer++; continue; }
    await store.putRange(r);
    addedNotes++;
  }
  await loadNotes();
  await loadRanges();
  await refreshLawList();
  if (P().current) await openLaw(P().current.lawId);
  toast(`法令 ${addedLaws}件 / 注釈 ${addedNotes}件 を復元`
    + (keptNewer ? `（手元が新しい ${keptNewer}件は残しました）` : ''));
}

function openExportDialog() {
  $('#dlg-export').showModal();
}

/* ---------------------------------------------------------- 法令の追加 */

async function searchAndShow() {
  const q = $('#add-query').value.trim();
  if (!q) return;
  const box = $('#add-results');
  box.innerHTML = '<p class="hint" style="padding:10px">検索中…</p>';
  try {
    const list = await apiSearchLaws(q);
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<p class="hint" style="padding:10px">見つかりませんでした。</p>'; return; }
    for (const l of list) {
      const owned = state.laws.some(x => x.lawId === l.lawId);
      const d = document.createElement('div');
      d.className = 'r';
      d.innerHTML = `<div class="info"><div class="name">${esc(l.lawTitle)}</div>`
        + `<div class="sub">${esc(l.lawNum || '')}${l.category ? '　' + esc(l.category) : ''}</div></div>`
        + `<button ${owned ? 'disabled' : ''}>${owned ? '取込済' : '取り込む'}</button>`;
      const btn = d.querySelector('button');
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '取得中…';
        try {
          const xml = await apiFetchLaw(l.lawId);
          await store.putLaw({ ...l, xml, savedAt: Date.now() });
          state.indexCache.delete(l.lawId);
          await refreshLawList();
          btn.textContent = '取込済';
          toast(`「${l.lawTitle}」を取り込みました`);
        } catch (err) {
          btn.disabled = false; btn.textContent = '再試行';
          toast(err.message);
        }
      };
      box.appendChild(d);
    }
  } catch (err) {
    box.innerHTML = `<p class="hint" style="padding:10px">${esc(err.message)}</p>`;
  }
}

/* ------------------------------------------------------------------ 起動 */

/* ------------------------------------------------------------- 表示設定 */

/** 条文本文の書体。Windows と macOS の両方で狙いどおりになるよう並べてある。 */
const FONT_STACKS = {
  mincho: '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS PMincho", "Noto Serif JP", serif',
  gothic: '"Hiragino Sans", "Yu Gothic UI", "Yu Gothic", "MS PGothic", sans-serif',
  meiryo: '"Meiryo", "Hiragino Sans", sans-serif',
  ud: '"BIZ UDPGothic", "Meiryo", "Hiragino Sans", sans-serif',
};
// leading は 1/10 倍、measure は em 単位（0 は幅いっぱい）で持つ
const VIEW_DEFAULT = {
  font: 'mincho', size: 16, leading: 19, measure: 46,
  annot: 'all', ink: '#1558b8', paren: 'dim',
};

function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem('roppo.view') || '{}');
    return { ...VIEW_DEFAULT, ...v };
  } catch (e) { return { ...VIEW_DEFAULT }; }
}

function applyView(v) {
  const root = document.documentElement;
  root.style.setProperty('--font-body', FONT_STACKS[v.font] || FONT_STACKS.mincho);
  root.style.setProperty('--text-size', v.size + 'px');
  root.style.setProperty('--text-leading', (v.leading / 10).toFixed(1));
  root.style.setProperty('--measure', v.measure ? v.measure + 'em' : '100%');
  root.dataset.annot = v.annot || 'all';
  root.style.setProperty('--ink', v.ink || VIEW_DEFAULT.ink);
  root.dataset.paren = v.paren || 'dim';

  for (const b of $$('#font-picker button')) b.classList.toggle('on', b.dataset.font === v.font);
  for (const b of $$('#measure-picker button')) b.classList.toggle('on', Number(b.dataset.measure) === v.measure);
  for (const b of $$('#annot-picker button')) b.classList.toggle('on', b.dataset.annot === (v.annot || 'all'));
  for (const b of $$('#ink-picker button')) b.classList.toggle('on', b.dataset.ink === (v.ink || VIEW_DEFAULT.ink));
  for (const b of $$('#paren-picker button')) b.classList.toggle('on', b.dataset.paren === (v.paren || 'dim'));
  $('#size-range').value = v.size;
  $('#leading-range').value = v.leading;
  $('#size-val').textContent = v.size + 'px';
  $('#leading-val').textContent = (v.leading / 10).toFixed(1);

  try { localStorage.setItem('roppo.view', JSON.stringify(v)); } catch (e) { /* 任意 */ }
  // 字組みが変われば要素の位置も変わる。現在位置の判定をやり直す。
  measureHeadings();
  updateCrumb();
  positionPopover();
}

function wireView() {
  const pad = $('#viewpad');
  const btn = $('#btn-view');
  let view = loadView();

  btn.onclick = () => {
    pad.hidden = !pad.hidden;
    btn.classList.toggle('on', !pad.hidden);
  };
  document.addEventListener('pointerdown', e => {
    if (pad.hidden || e.target.closest('.view')) return;
    pad.hidden = true;
    btn.classList.remove('on');
  });

  $('#font-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-font]');
    if (!b) return;
    view.font = b.dataset.font;
    applyView(view);
  });
  $('#paren-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-paren]');
    if (!b) return;
    view.paren = b.dataset.paren;
    applyView(view);
  });
  $('#ink-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-ink]');
    if (!b) return;
    view.ink = b.dataset.ink;
    applyView(view);
  });
  $('#annot-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-annot]');
    if (!b) return;
    view.annot = b.dataset.annot;
    applyView(view);
    hideTip();
  });
  $('#measure-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-measure]');
    if (!b) return;
    view.measure = Number(b.dataset.measure);
    applyView(view);
  });
  $('#size-range').oninput = e => { view.size = Number(e.target.value); applyView(view); };
  $('#leading-range').oninput = e => { view.leading = Number(e.target.value); applyView(view); };
  $('#view-reset').onclick = () => { view = { ...VIEW_DEFAULT }; applyView(view); };

  applyView(view);
}

function switchTab(name) {
  for (const b of $$('.tabs button[data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
  for (const id of ['laws', 'toc', 'find', 'marks']) {
    if (id === 'find' && narrow()) continue;    // シートの中にあるので隠さない
    $('#panel-' + id).hidden = id !== name;
  }
  try { localStorage.setItem('roppo.tab', name); } catch (e) { /* 使えなくても支障ない */ }
}

/** テンキー。条文番号は数字と「条項号の」だけで打てるので、専用の盤を出す。 */
function wireKeypad() {
  const pad = $('#keypad');
  const input = $('#jump-input');
  const btn = $('#btn-pad');

  const setOpen = open => {
    pad.hidden = !open;
    btn.classList.toggle('on', open);
    try { localStorage.setItem('roppo.pad', open ? '1' : '0'); } catch (e) { /* 任意 */ }
  };
  btn.onclick = () => setOpen(pad.hidden);

  pad.addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    if (k === '⌫') input.value = input.value.slice(0, -1);
    else if (k === '✓') { doJump(); return; }
    else input.value += k;
    input.focus();
    updateJumpPreview();     // 盤からは input イベントが飛ばない
  });

  // 盤の外を押したら閉じる（入力欄と盤自身は除く）
  document.addEventListener('pointerdown', e => {
    if (narrow()) return;           // シートの中では出しっぱなしにする
    if (pad.hidden) return;
    if (e.target.closest('.jump')) return;
    setOpen(false);
  });

  let open = false;
  try { open = localStorage.getItem('roppo.pad') === '1'; } catch (e) { /* 任意 */ }
  setOpen(open);
}

function wire() {
  $('#jump-go').onclick = doJump;
  $('#jump-input').onkeydown = e => { if (e.key === 'Enter') doJump(); };
  $('#find-input').onkeydown = e => {
    if (e.key !== 'Enter') return;
    // 同じ語で続けて押したら次の一致へ送る
    if (find.q === $('#find-input').value.trim() && find.results.length) stepFind(e.shiftKey ? -1 : 1);
    else doFind();
  };
  $('#law-filter').oninput = renderLawList;

  for (const b of $$('.tabs button')) b.onclick = () => switchTab(b.dataset.tab);

  $('#find-where').addEventListener('click', e => {
    const b = e.target.closest('button[data-where]');
    if (!b) return;
    find.where = b.dataset.where;
    for (const x of $$('#find-where button')) x.classList.toggle('on', x === b);
    doFind();
  });
  $('#find-in-text').onchange = e => { find.inText = e.target.checked; doFind(); };
  $('#find-in-notes').onchange = e => { find.inNotes = e.target.checked; doFind(); };
  wireKeypad();
  wireView();

  const openAdd = () => { $('#dlg-add').showModal(); $('#add-query').focus(); };
  $('#btn-add-law').onclick = openAdd;
  document.addEventListener('click', e => {
    if (e.target && e.target.id === 'btn-add-law-2') openAdd();
  });

  $('#btn-export').onclick = openExportDialog;
  $('#exp-backup').onclick = exportBackup;
  $('#exp-restore').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';                       // 同じファイルを選び直せるように
    if (!f) return;
    if (!confirm('バックアップから復元します。\n同じ条文の注釈は、新しい方を残します。よろしいですか？')) return;
    try { await importBackup(f); } catch (err) { toast('復元できませんでした: ' + err.message); }
  };

  const addSearchBtn = $('#add-search');
  addSearchBtn.type = 'button';
  addSearchBtn.onclick = searchAndShow;
  $('#add-query').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); searchAndShow(); } };

  for (const pane of state.panes) bindPaneEvents(pane);
  wireGlobal();
}

function bindPaneEvents(pane) {
  pane.el.addEventListener('click', e => {
    const ref = e.target.closest('a.ref[data-target]');
    if (ref) {
      e.preventDefault();
      followRef(ref, e.ctrlKey || e.metaKey || e.shiftKey);
      return;
    }
    const mk = e.target.closest('mark[data-range-id]');
    if (mk) { openRangePopover(mk.dataset.rangeId); return; }
    // 文字を選択している最中は編集を開かない（範囲注釈を付けたいだけのことが多い）
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;

    /*
     * 注釈欄を開くのは、条・項・号の「番号」を押したときだけにする。
     * 本文のどこを触っても開くと、読んでいるだけで欄が出てきて邪魔になる。
     * 番号はその単位を指す取っ手なので、押す先としても分かりやすい。
     */
    /*
     * 取っ手は「番号」だけにする。見出し（（損害賠償）など）は本文の一部で、
     * 押すものには見えない。番号だけでも全部の単位に届く。
     */
    const num = e.target.closest('.article-title, .para-num, .item-title');
    if (num) {
      // 条番号は第1項の中に置かれているので、近い方をたどると項になる。条まで上がる。
      const host = num.classList.contains('article-title')
        ? num.closest('.article')
        : num.closest('[data-anchor]');
      if (host && host.dataset.anchor) selectAnchor(host.dataset.anchor, true, pane);
      return;
    }

    /*
     * 番号を持たない単位は、本文そのものが取っ手になる。
     *   ・第1項（項番号を出さないのが慣例）
     *   ・前文
     *   ・別表・別記・別図
     * 番号を持つ単位（②③…、号のイロハ、条）は番号を押してもらう。
     * 取っ手が二つあると、どちらに付いたのか分からなくなる。
     */
    const host = e.target.closest('[data-anchor]');
    if (!host || !host.dataset.anchor) return;
    /*
     * 条は条番号が取っ手。
     * 手元の7法令4,540条を数えたところ ArticleTitle の無い条は0件だったが、
     * 全法令を確かめたわけではない。無ければ取っ手が消えて選べなくなるので、
     * そのときだけ本文で選べるようにしておく。あっても害はない。
     */
    if (host.classList.contains('article') && host.querySelector('.article-title')) return;
    if (host.querySelector(':scope > .para-num, :scope > .item-title')) return;
    selectAnchor(host.dataset.anchor, true, pane);
  });

  pane.el.addEventListener('auxclick', e => {
    const ref = e.button === 1 && e.target.closest('a.ref[data-target]');
    if (ref) { e.preventDefault(); followRef(ref, true); }
  });
  pane.el.addEventListener('mouseover', handleHover);
  pane.el.addEventListener('mouseleave', hideTip);

  // 選択したら色バーを出す
  pane.el.addEventListener('mouseup', () => setTimeout(showSelBar, 0));
  pane.el.addEventListener('touchend', () => setTimeout(showSelBar, 0));
}

/** 面によらず1回だけ掛ける配線 */
function wireGlobal() {
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideSelBar();
  });
  $('#selbar').addEventListener('pointerdown', e => e.preventDefault());   // 選択を保つ
  $('#selbar').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'selbar-memo') createRangeFrom('yellow', true);
    else if (b.dataset.color) createRangeFrom(b.dataset.color, false);
  });

  $('#pop-close').onclick = closePopover;

  // 外を押したら閉じる。別の条文を押したときは選択し直しに任せる。
  document.addEventListener('pointerdown', e => {
    if ($('#popover').hidden) return;
    if (e.target.closest('#popover') || e.target.closest('[data-anchor]')) return;
    closePopover();
  });
  window.addEventListener('resize', positionPopover);

  $('#btn-back').onclick = () => goHistory(-1);
  $('#btn-fwd').onclick = () => goHistory(1);

  $('#btn-menu').onclick = () => setDrawer(!$('#pane-laws').classList.contains('open'));
  $('#btn-drawer-close').onclick = () => setDrawer(false);
  $('#scrim').onclick = () => setDrawer(false);

  $('#btn-check').onclick = () => checkAmendments(true);
  $('#topbar-law').onclick = () => { if (P().current) openRevisions(P().current.lawId); };
  $('#jump-input').addEventListener('input', updateJumpPreview);
  $('#btn-lookup-fab').onclick = () => setSheet($('#lookup-sheet').hidden);
  $('#lookup-sheet-close').onclick = () => setSheet(false);
  for (const b of $$('#sheet-tabs button')) {
    b.onclick = () => setSheet(true, b.dataset.sheet);
  }
  if (narrowMQ && narrowMQ.addEventListener) narrowMQ.addEventListener('change', placeControls);

  /*
   * 2面のまま狭くすると、解除ボタンが隠れて1面に戻せなくなる。
   * この幅で割ってもどちらも読めないので、そのときは1面へ戻す。
   */
  const phoneMQ = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
  if (phoneMQ && phoneMQ.addEventListener) {
    phoneMQ.addEventListener('change', () => { if (phoneMQ.matches && state.split) setSplit(false); });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      setDrawer(false);
      setSheet(false);
      closePopover();
    }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goHistory(-1); }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goHistory(1); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (narrow()) { setSheet(true, 'jump'); return; }   // 欄はシートの中にある
      $('#jump-input').focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      if (narrow()) { setSheet(true, 'find'); return; }
      $('#find-input').select();
    }
    if (e.key === 'F3') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  });

  // 離脱時の取りこぼしを防ぐ
  window.addEventListener('pagehide', () => { flushSave(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
}

/* ------------------------------------------------------ Service Worker */

/*
 * アプリ本体をキャッシュして、サーバーなしで起動できるようにする。
 * 新しい版が来ても勝手には切り替えない。書きかけのメモを抱えたまま
 * 読み込み直すことになるため、利用者に断ってから切り替える。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  let approved = false;                       // このタブが切り替えを承認したか

  // 別のタブが先に切り替えたときの知らせ。押したときだけ読み込み直す。
  const offerReload = () => {
    const el = $('#toast');
    el.innerHTML = '';
    el.append('新しい版に入れ替わりました　');
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = '読み込み直す';
    b.onclick = async () => { await flushSave(); reloading = true; location.reload(); };
    el.appendChild(b);
    el.hidden = false;
    clearTimeout(toastTimer);
  };

  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = worker => {
      if (!worker) return;
      const el = $('#toast');
      el.innerHTML = '';
      el.append('新しい版があります　');
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = '読み込み直す';
      b.onclick = async () => {
        await flushSave();                    // 書きかけを保存してから
        approved = true;                      // このタブは読み込み直してよい
        worker.postMessage('skip-waiting');
      };
      el.appendChild(b);
      el.hidden = false;
      clearTimeout(toastTimer);               // これは自動で消さない
    };

    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        // 初回の導入では知らせない。入れ替えのときだけ。
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
  }).catch(err => console.warn('Service Worker を登録できませんでした', err));

  // 読み込み直すのは、このタブで「読み込み直す」を押したときだけ。
  // controllerchange は初回の導入（clients.claim）でも飛ぶし、別のタブが
  // 承認したときにも飛ぶ。そこで読み込み直すと、こちらの書きかけが消える。
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    if (!approved) {
      // 別のタブが切り替えた。こちらは古い殻のまま動いている。
      // 勝手に読み込み直すと書きかけが消えるので、知らせるだけにする。
      if (navigator.serviceWorker.controller) offerReload();
      return;
    }
    reloading = true;
    location.reload();
  });
}

(async function init() {
  wirePanes();
  wire();
  registerServiceWorker();
  let tab = 'laws';
  try { tab = localStorage.getItem('roppo.tab') || 'laws'; } catch (e) { /* 任意 */ }
  switchTab(tab);
  let sheetTab = 'jump';
  try { sheetTab = localStorage.getItem('roppo.sheetTab') || 'jump'; } catch (e) { /* 任意 */ }
  switchSheetTab(sheetTab);
  placeControls();
  loadAmendState();
  await loadNotes();
  await loadRanges();
  await refreshLawList();
  let last = null;
  try { last = localStorage.getItem('roppo.last'); } catch (e) { /* 使えなくても支障ない */ }
  loadLastPos();
  const first = (last && state.laws.some(l => l.lawId === last)) ? last
    : (state.laws.length ? state.laws[0].lawId : null);
  if (first) {
    await openLaw(first);
    pushHist({ lawId: first, anchor: null, scrollTop: P().el.scrollTop });
  }
  checkAmendmentsIfStale();     // 通信できるときだけ、1日に1度
  window.addEventListener('pagehide', rememberPos);
})();
