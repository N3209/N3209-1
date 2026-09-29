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
const DB_VER = 4;
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
      /*
       * v3: 法令の見出しだけを別に持つ。
       *
       * 一覧を作るために getAll('laws') を使っていたが、これは XML 込みで
       * 全レコードを読む。名前を並べるためだけに、民法1.6MB・会社法2.2MB
       * …と数MBを読み出して捨てていた。法令を足すほど起動が遅くなる。
       * 見出しだけの小さな記録を別に置き、一覧はそちらを読む。
       */
      /*
       * v4: 同期の対象になるものを IndexedDB に集める。
       *
       * 法令の並び順は localStorage にあった。しかし同期では、注釈と並び順を
       * 「まとめて確定する」必要がある（片方だけ入った状態を残さない）。
       * localStorage は IndexedDB のトランザクションに入れられないので、
       * 同じ入れ物に移す。localStorage に残るのは表示設定だけになる。
       *
       * キーと値の1対だけの単純な置き場所にしておく。同期の覚え書き
       * （端末ID・世代番号など）も、ここに置けるようにするため。
       */
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('lawMeta')) {
        db.createObjectStore('lawMeta', { keyPath: 'lawId' });
        // すでにある法令から見出しを作る。ここは版を上げるときの1回だけ。
        if (db.objectStoreNames.contains('laws') && req.transaction) {
          const laws = req.transaction.objectStore('laws');
          const meta = req.transaction.objectStore('lawMeta');
          const cur = laws.openCursor();
          cur.onsuccess = ev => {
            const c = ev.target.result;
            if (!c) return;
            const { xml, ...rest } = c.value;
            meta.put(rest);
            c.continue();
          };
        }
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

/*
 * 法令の本体と見出しは、必ず一緒に書く。片方だけ残ると、一覧に出るのに
 * 開けない、あるいはその逆になる。同じトランザクションで書く。
 */
async function putLawAndMeta(rec) {
  const db = await openDB();
  const t = db.transaction(['laws', 'lawMeta'], 'readwrite');
  const { xml, ...meta } = rec;
  t.objectStore('laws').put(rec);
  t.objectStore('lawMeta').put(meta);
  await txDone(t);
}

async function delLawAndMeta(id) {
  const db = await openDB();
  const t = db.transaction(['laws', 'lawMeta'], 'readwrite');
  t.objectStore('laws').delete(id);
  t.objectStore('lawMeta').delete(id);
  await txDone(t);
}

/*
 * 復元・同期の反映を、一度のトランザクションで書く。
 *
 * 以前は法令・注釈・文言注釈を1件ずつ別のトランザクションで書いていた。
 * 途中で失敗すると、半分入った状態が残る。どこまで入ったのかも分からない。
 * 注釈は取り返せないので、ここは「全部入るか、何も入らないか」にする。
 *
 * トランザクションの中で IndexedDB 以外の待ちを入れてはいけない（自動で閉じる）。
 * だから、渡すものは呼び側で全部そろえてから来ること。ここでは put を並べて、
 * 最後に完了を待つだけにする。
 */
async function applyBulk({ laws, notes, ranges, lawOrder: order, meta }) {
  const db = await openDB();
  const names = ['laws', 'lawMeta', 'notes', 'ranges', 'meta'];
  const t = db.transaction(names, 'readwrite');
  const os = {};
  for (const n of names) os[n] = t.objectStore(n);

  /*
   * put() は不正な値だと「その場で」例外を投げる（鍵が無いなど）。
   * 受け止めずに抜けると、それまでに並べた書き込みだけが確定してしまう。
   * 半分入った状態を残さないために、必ず中止してから投げ直す。
   */
  try {
    for (const rec of laws || []) {
      const { xml, ...m } = rec;
      os.laws.put(rec);
      os.lawMeta.put(m);
    }
    for (const n of notes || []) os.notes.put(n);
    for (const r of ranges || []) os.ranges.put(r);
    if (Array.isArray(order)) {
    os.meta.put({ key: LAW_ORDER_KEY,
      value: { ids: order, updatedAt: Date.now(), version: lawOrderRec.version || {} } });
  }
    for (const [k, v] of Object.entries(meta || {})) os.meta.put({ key: k, value: v });
  } catch (err) {
    try { t.abort(); } catch (e) { /* すでに終わっているなら、そのまま */ }
    throw err;
  }

  await txDone(t);
}

const store = {
  applyBulk,
  allLaws: () => read('laws', s => s.getAll()),      // XML 込み。書き出しでだけ使う
  allLawMeta: () => read('lawMeta', s => s.getAll()),
  getLaw: id => read('laws', s => s.get(id)),
  putLaw: rec => putLawAndMeta(rec),
  delLaw: id => delLawAndMeta(id),
  getMeta: key => read('meta', s => s.get(key)),
  putMeta: (key, value) => write('meta', s => s.put({ key, value })),
  allNotes: () => read('notes', s => s.getAll()),
  putNote: rec => write('notes', s => s.put(rec)),
  delNote: key => write('notes', s => s.delete(key)),        // 本当に消す。掃除と試験用
  tombNote: rec => write('notes', s => s.put(rec)),          // 消した印を書く
  allRanges: () => read('ranges', s => s.getAll()),
  putRange: rec => write('ranges', s => s.put(rec)),
  delRange: id => write('ranges', s => s.delete(id)),        // 本当に消す。掃除と試験用
  tombRange: rec => write('ranges', s => s.put(rec)),        // 消した印を書く
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

/*
 * 文言に付けられる印。色のほかに下線がある。
 *
 * 色と下線は使い分ける。色は「この文言にメモを足したい」とき、下線は
 * 「読むときに気を付けたい」ときの強調である。紙の六法でマーカーと下線を
 * 使い分けるのと同じで、色を薄くした代わりではない。
 *
 * 条項号の印（上の MARK_COLORS）には下線を入れない。下線は文字そのものに
 * 掛けるものなので、条や項の全体に掛ける意味がない。
 */
const RANGE_STYLES = [...MARK_COLORS, { key: 'ul', label: '下線' }];

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
      if (p.closest('.memo-inline, .inline-tags, .note-summary, .slash')) return NodeFilter.FILTER_REJECT;
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
/*
 * el の中の s〜e 文字目を包む。
 *
 * map を渡さなければ毎回作り直す。渡す場合は、呼ぶ側が後ろから順に
 * 当てていること。前から当てると、包んだ拍子に後ろの位置がずれる。
 * 作り直しが効くのは、同じ条文に何十回も当てるとき（検索の強調・括弧）。
 */
function wrapInMap(el, s, e, cls, id, tag, map0) {
  const map = map0 || textMapOf(el);
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

/*
 * 属性セレクタに埋める文字。
 *
 * CSS.escape は古い環境と、試験のように差し替えを忘れた場面で無いことがある。
 * 実際に、後メモの置き場所を探すのに使ったところで落ちた。アンカーは
 * 英数字と / _ : だけなので、引用符と逆斜線だけ避ければ足りる。
 */
function attrEsc(v) {
  const s = String(v == null ? '' : v);
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/["\\]/g, ch => '\\' + ch);
}

/* ------------------------------------------------------------ 消した印 */

/*
 * 消したことを記録して残す（墓石）。本当に消さない。
 *
 * 消すたびに本当に削除していたので、「消した」という事実がどこにも残らなかった。
 * すると古いバックアップを読み込んだときに、消したものが復活する。端末を
 * 行き来させるなら、これは必ず起きる。
 *
 * 期限は付けない。「全端末が受け取ったら消してよい」と考えても、昔の
 * バックアップを後から読めば復活の入口になる。2〜3台・数十KBの規模では、
 * 墓石の容量より「消してよい条件」を実装する方が高くつく。
 *
 * 中身は小さくする。タグやメモの文面は残さない。消したのに文面が残るのは
 * 筋が違う。復旧のためのバックアップには残るが、それは別の話である。
 *
 * updatedAt を deletedAt と同じ値にしておく。マージは updatedAt の新しい方を
 * 残すので、こうすれば「消した」も「書いた」と同じ物差しで比べられる。
 */
const isTomb = r => !!(r && r.deletedAt);

function noteTomb(note, now, version) {
  return { key: note.key, lawId: note.lawId, anchor: note.anchor,
    deletedAt: now, updatedAt: now,
    // 「消した」も1つの編集。版を持たせないと前後が決められない
    version: version || note.version || {} };
}

function rangeTomb(rec, now, version) {
  // 消す相手は id で決める。text や nth が同じでも別の注釈は消さない
  return { id: rec.id, lawId: rec.lawId, anchor: rec.anchor,
    deletedAt: now, updatedAt: now,
    version: version || rec.version || {} };
}

/** 墓石を除いたものだけ。画面に出すのはこちら。 */
const livingOnly = list => list.filter(r => !isTomb(r));

/* ------------------------------------------- メモの遅延保存（取りこぼし防止） */

let pendingSave = null;      // 条項号のメモ { note, timer }
let pendingRange = null;     // 文言メモ { rec, timer }
/*
 * 保存に失敗したものの鍵。
 *
 * 遅延保存は時計から呼ばれるので、失敗しても受け取る相手がいない。
 * ここに残しておいて、書き出しや同期の前に見る。保存できていないのに
 * 送ると、まだDBに無いものが「無い」として相手に伝わる。
 *
 * 真偽値ひとつにすると、一度失敗したら以後ずっと書き出せなくなる。
 * 対象ごとに覚えて、同じものが保存できたら消す。空になれば止めない。
 */
const saveFailures = new Set();

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
async function flushSave() {
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
  const rs = jobs.length ? await Promise.all(jobs) : [];
  return rs.every(r => r !== false);          // 全部保存できたか
}

/*
 * 書き込み中のものが無いか。flushSave を呼べば解消する。
 *
 * 「保存に失敗したものがある」ことで止めはしない。失敗した内容はその時点で
 * もう失われているので、書き出しを止めても取り戻せない。止めるより、
 * 書き出せたものを残して、失敗があったことを添える方が役に立つ。
 * 外へ送る同期では、そこを厳しく見る（savesAreClean）。
 */
function savesArePending() { return !!(pendingSave || pendingRange); }

/** 書き込み中も無く、失敗も無いか。外へ送る前（同期）はここまで見る。 */
function savesAreClean() { return !savesArePending() && saveFailures.size === 0; }

/** 保存できなかったものの数。知らせるときに使う。 */
function unsavedCount() { return saveFailures.size; }

/* --------------------------------------------------------------- 法令一覧 */


/*
 * つまんで並べ替える。
 *
 * ブラウザの drag-and-drop は iOS の Safari で動かないので使わない。
 * pointer の事象だけで組む。指でもマウスでも同じ道を通る。
 *
 * 取っ手（⠿）からしか始まらない。行そのものをつまめるようにすると、
 * 読むために押したつもりが動いてしまう。
 */
let dragRow = null;        // つまんでいる行
let dragPointer = null;    // つまんでいる指（マウス）

/*
 * つまむのをやめる。覚えた順は書かない。
 * 一覧を作り直すときは、必ずこれを先に呼ぶ。作り直すと、つまんでいた行は
 * 画面から外れるが、こちらは古い要素を握ったままになる。次に指が動くと、
 * 外れたはずの行を一覧へ挿し直して、同じ法令が二重に並ぶ。
 */
function cancelLawDrag() {
  if (!dragRow) return;
  dragRow.classList.remove('dragging');
  const ul = $('#law-list');
  if (ul) ul.classList.remove('dragging');
  dragRow = null;
  dragPointer = null;
}

function wireLawDrag() {
  const ul = $('#law-list');

  const rowsBelow = y => [...ul.querySelectorAll('li[data-law-id]')]
    .find(el => el !== dragRow && y < el.getBoundingClientRect().top + el.offsetHeight / 2);

  ul.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.grip');
    if (!grip) return;
    // 絞り込み中は並びが一部しか出ていない。動かすと全体の順が壊れる。
    if ($('#law-filter').value.trim()) { toast('絞り込みを消してから並べ替えてください'); return; }

    const row = grip.closest('li[data-law-id]');
    if (!row) return;
    e.preventDefault();
    cancelLawDrag();
    /*
     * capture は一覧そのものに付ける。取っ手に付けると、行を動かしたときに
     * 取っ手も一緒に DOM の中を移動する。Safari はそこで capture を手放す
     * ことがあり、掴んだ直後に終わってしまう（iPhone で並べ替えられない
     * 症状の原因）。一覧は動かないので、掴んでいる間ずっと受け取れる。
     */
    try { ul.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても動く */ }
    dragRow = row;
    dragPointer = e.pointerId;
    row.classList.add('dragging');
    ul.classList.add('dragging');      // 周りを薄くして、つまんだことを示す
  });

  ul.addEventListener('pointermove', e => {
    if (!dragRow || e.pointerId !== dragPointer) return;
    // 一覧が作り直されて、握っている行が画面から外れていたらやめる
    if (!dragRow.isConnected) { cancelLawDrag(); return; }
    e.preventDefault();
    const before = rowsBelow(e.clientY);
    if (before) ul.insertBefore(dragRow, before);
    else ul.appendChild(dragRow);
  });

  const finish = e => {
    if (!dragRow || (e && e.pointerId !== dragPointer)) return;
    const ok = dragRow.isConnected;
    if (e && e.pointerId !== undefined) {
      try { ul.releasePointerCapture(e.pointerId); } catch (err) { /* すでに外れている */ }
    }
    cancelLawDrag();
    if (!ok) return;                 // 外れていたら、順は書かない

    // 画面の並びを、そのまま順として覚える
    const shown = [...ul.querySelectorAll('li[data-law-id]')].map(el => el.dataset.lawId);
    const seen = new Set();
    const uniq = shown.filter(id => !seen.has(id) && seen.add(id));
    // 絞り込みで隠れているものは、いまの順のまま後ろに残す
    const rest = state.laws.map(l => l.lawId).filter(id => !seen.has(id));
    saveLawOrder(uniq.concat(rest));
    state.laws = sortLaws(state.laws);
    renderLawList();
  };
  ul.addEventListener('pointerup', finish);
  ul.addEventListener('pointercancel', finish);
  ul.addEventListener('lostpointercapture', finish);
}

/*
 * 法令の並び順。
 *
 * 既定は名前順だが、よく引くものを上に置きたい。順番は法令そのものでは
 * なく「並べ方」なので、XML を抱えた記録は書き換えず、別に持つ。
 * 1.6MB の XML を並べ替えのたびに書き直すのは無駄でもある。
 */
const LAW_ORDER_KEY = 'roppo.lawOrder';
let lawOrder = [];
/*
 * 並び順も同期の対象なので、注釈と同じ形（版と時刻を持つレコード）で持つ。
 * 中身は法令IDの配列ひとつなので、レコードは1件だけである。
 */
let lawOrderRec = { ids: [], updatedAt: 0, version: {} };

/*
 * 並び順を IndexedDB から読む。
 *
 * 以前は localStorage に置いていた。同期では注釈と並び順をまとめて確定したいので、
 * IndexedDB へ移した。移す前の端末には localStorage にしか無いので、
 * 一度だけ拾い上げて書き移す。拾ったあとも localStorage の値は消さない
 * （古い版のアプリで開いたときに並びが失われないように）。
 */
async function loadLawOrder() {
  let rec = null;
  try {
    const got = await store.getMeta(LAW_ORDER_KEY);
    if (got) rec = got.value;
  } catch (e) { /* 読めなければ下で localStorage を見る */ }

  /*
   * 3つの形を受ける。
   *   {ids, updatedAt, version}  いまの形
   *   [ ... ]                    版を入れる前の形（配列だけ）
   *   無い                       localStorage から拾う（さらに前の形）
   */
  if (rec && Array.isArray(rec.ids)) {
    lawOrderRec = { ids: rec.ids, updatedAt: rec.updatedAt || 0, version: rec.version || {} };
  } else if (Array.isArray(rec)) {
    lawOrderRec = { ids: rec, updatedAt: 0, version: {} };
    try { await store.putMeta(LAW_ORDER_KEY, lawOrderRec); } catch (e) { /* 次回また */ }
  } else {
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem(LAW_ORDER_KEY) || '[]'); }
    catch (e) { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    lawOrderRec = { ids, updatedAt: 0, version: {} };
    // 移し替えは一度だけ。空でも書いておかないと、毎回ここを通る
    try { await store.putMeta(LAW_ORDER_KEY, lawOrderRec); } catch (e) { /* 書けなくても読める */ }
  }
  const ids = lawOrderRec.ids;
  lawOrder = ids;
}

function saveLawOrder(ids) {
  lawOrder = ids;
  // 並べ替えも1つの編集。版を進めて、前後を時計で決めなくて済むようにする
  lawOrderRec = { ids, updatedAt: Date.now(), version: vvBump(lawOrderRec.version, deviceId) };
  // IndexedDB を正本にする。localStorage にも書いて、古い版のアプリでも読めるようにする
  store.putMeta(LAW_ORDER_KEY, lawOrderRec).catch(() => { /* 下の localStorage が残る */ });
  try { localStorage.setItem(LAW_ORDER_KEY, JSON.stringify(ids)); } catch (e) { /* 任意 */ }
}

/* 覚えた順を先に、知らないものは名前順で後ろに。 */
function sortLaws(list) {
  const at = new Map(lawOrder.map((id, i) => [id, i]));
  return list.slice().sort((a, b) => {
    const ia = at.has(a.lawId) ? at.get(a.lawId) : Infinity;
    const ib = at.has(b.lawId) ? at.get(b.lawId) : Infinity;
    if (ia !== ib) return ia - ib;
    return (a.lawTitle || '').localeCompare(b.lawTitle || '', 'ja');
  });
}

async function refreshLawList() {
  /*
   * 一覧は見出しだけを読む。XML 込みで全部読むと、法令を足すほど
   * 起動が遅くなる（数MBの読み出しを、名前を並べるためだけに行う）。
   */
  state.laws = sortLaws(await store.allLawMeta());
  renderLawList();
}

function renderLawList() {
  cancelLawDrag();          // 作り直すと、つまんでいた行は画面から外れる
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
    li.dataset.lawId = l.lawId;
    li.innerHTML = '<span class="grip" title="つまんで並べ替え">⠿</span>'
      + `<span class="law-name" title="${esc(l.lawTitle)}">${esc(l.lawTitle)}</span>`
      + (l.source === 'file' ? '<span class="src-badge">取り込み</span>' : '')
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
  pane.meta.textContent = rec.source === 'file'
    ? [
      rec.lawNum,
      // 来歴があれば「施行日は不明」より具体的なことが言える
      rec.provenance && rec.provenance['反映'] ? rec.provenance['反映'] : '',
    ].filter(Boolean).join('　/　') || '取り込んだデータ　施行日は不明'
    : [
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

  const note = $('.law-note', pane.root);
  if (rec.source === 'file') {
    note.hidden = false;
    /*
     * 帯は短くする。重なりの詳しい話が要るのは、その位置に注釈を付けようと
     * したときだけである。読んでいる間ずっと出し続ける理由がない。
     * 詳細は触れたときに出す（下の dupNote）。
     */
    const dups = rec.dupAnchors || [];
    const where = dups.length && dups.every(a => /^S/.test(a)) ? '附則に' : '';
    /*
     * 来歴があるなら「施行日は不明」ではなく、分かっていることを出す。
     * 特に「附則は含まない」は読むときに要る。書いていないと、附則が無いのを
     * 法令の側の話だと思ってしまう。
     * 帯は短くするので、全部は title に入れて触ったときに出す。
     */
    const prov = rec.provenance;
    const head = prov && (prov['反映'] || prov['範囲'])
      ? [prov['反映'] ? prov['反映'] + ' 反映' : '', prov['範囲']].filter(Boolean).join('　')
      : '施行日は不明';
    const band = '取り込んだデータ　' + esc(head) + '　'
      + esc(rec.importedAt || '') + ' 取り込み';
    /*
     * 残りの来歴（出典・URL・変換の条件）は details で畳む。
     *
     * 以前は title に入れていたが、title はマウスを載せたときにしか出ない。
     * スマホでは読む手立てが無く、キーボードでも辿れない（Codex の指摘）。
     * details なら押して開けるし、読み上げも拾う。
     */
    const rest = prov ? PROV_KEYS.filter(k => prov[k] && !['反映', '範囲'].includes(k)) : [];
    note.innerHTML = (rest.length
      ? '<details class="prov"><summary>' + band + '</summary>'
        + rest.map(k => '<div><b>' + esc(k) + '</b> ' + esc(prov[k]) + '</div>').join('')
        + '</details>'
      : '<span>' + band + '</span>')
      + (dups.length
        ? '<span class="warn" title="' + esc(dups.join('、')) + '">'
          + where + '位置の重なりが ' + dups.length + '件</span>'
        : '');
  } else {
    note.hidden = true;
    note.innerHTML = '';
  }

  pane.header.hidden = false;
  pane.el.innerHTML = html;
  syncTopbarLaw();
  syncFindPlaceholder();
  indexAnchorEls(pane);

  renderLawList();
  renderToc();
  resolveRefs(pane);
  paintParens(pane);
  paintNotesIn(pane);
  paintRangesIn(pane);
  closePopover();                        // 前の法令の注釈パネルは閉じる
  hideSlashBar();                        // 別の法令に印を付けてしまわないように
  // 絞り込みは法令をまたいでも保つ。同じタグを別の法令で続けて見たいため。
  applyFilter(pane);
  renderFilterPicker();
  paintFindHits();          // 移った先の法令にも、検索の色を塗り直す
  pane._crumbSig = null;     // 別の法令でも見出しIDは h1 から振り直される
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
  /*
   * 同じ名前の法令が複数あるとき（e-Gov から取ったものと、ファイルから
   * 取り込んだもの）、先に並んでいる方を選ぶと、一覧の並べ替えだけで
   * リンクの行き先が変わる。決め手が無いならリンクを張らない。
   */
  const exact = pool.filter(l => l.lawTitle === name || l.abbrev === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  let best = null, ties = 1;
  for (const l of pool) {
    if (!l.lawTitle || !name.endsWith(l.lawTitle)) continue;
    const before = name.slice(0, name.length - l.lawTitle.length);
    // 「地方法人税法」を「法人税法」と取り違えないよう、直前が漢字・カタカナなら採らない。
    // 「において準用する商業登記法」のように、ひらがなや記号で切れている場合だけ許す。
    if (before && /[一-鿿゠-ヿ]$/.test(before)) continue;
    if (!best) { best = l; continue; }
    if (l.lawTitle.length > best.lawTitle.length) { best = l; ties = 1; continue; }
    if (l.lawTitle.length === best.lawTitle.length) ties++;
  }
  return ties > 1 ? null : best;     // 同じ長さで並ぶなら決め手が無い
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
 * 索引から引きやすい形を一度だけ作って覚えておく。
 *
 * 参照リンクは会社法で4,800本あり、1本ごとに索引6,318件を端から見ていた。
 * 掛け算になるので、開くたびに数百万回の照合が走っていた。
 */
const indexTables = new WeakMap();

function tableOf(index) {
  let t = indexTables.get(index);
  if (t) return t;
  t = { has: new Set(), item: new Map(), arts: new Map() };
  for (const e of index) {
    t.has.add(e.anchor);
    const p = e.anchor.split('/');
    if (p.length === 2) {
      if (!t.arts.has(p[0])) t.arts.set(p[0], []);
      t.arts.get(p[0]).push(p[1]);
    }
    if (p.length === 4) {
      // 項を書かずに号だけ指す書き方のため。複数あるなら決め手が無いので null。
      const k = p[0] + '/' + p[1] + '/' + p[3];
      t.item.set(k, t.item.has(k) ? null : e.anchor);
    }
  }
  indexTables.set(index, t);
  return t;
}

/*
 * 参照の行き先を決める。書いてあるとおりの場所が無ければ諦める。
 * 「第99号」と書いてあるのに条へ飛ばす、という黙った読み替えをしない。
 * 飛んだ先が違うことには、読んでいる側は気づけない。
 */
function bestAnchor(index, scope, art, par, item) {
  const t = tableOf(index);
  const has = a => t.has.has(a);
  if (par && item && has(`${scope}/${art}/${par}/${item}`)) return `${scope}/${art}/${par}/${item}`;
  if (!par && item) {
    // 項を書かずに号だけ指す書き方。同じ号が複数の項にあると決め手が無い。
    // 最初の1件を選ぶと、黙って別の項へ連れて行くことになる。
    return t.item.get(`${scope}/${art}/${item}`) || null;
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
    const arts = tableOf(pane.index).arts.get(scope) || [];
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
  $('.tl-date', el).textContent = !rec ? ''
    : rec.source === 'file' ? '施行日不明'
    : rec.enforcementDate ? '施行 ' + rec.enforcementDate : '';

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
  hideSlashBar();
  syncTopbarLaw();
  syncFindPlaceholder();
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
    /*
     * スクロールは指を滑らせている間ずっと飛んでくる（iOS で毎秒60回ほど）。
     * そのたびに帯を作り直し、目次を全部舐めていたので、長い法令ほど
     * 指に付いてこなくなっていた。1フレームに1回までにする。
     */
    p.el.addEventListener('scroll', () => {
      hideTip();
      if (p === P()) { clearTimeout(p._t); p._t = setTimeout(rememberPos, 300); }
      if (p._raf) return;
      p._raf = requestAnimationFrame(() => {
        p._raf = 0;
        positionPopover();
        updateCrumb(p);
      });
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
    return 0;                 // 見出しの測り直しは呼ぶ側でする（openLaw で二度走っていた）
  }

  /*
   * 注釈のアンカーから、それを含む塊のアンカーを先に作っておく。
   * 塊ごとに注釈を全部見比べると、条数 × 注釈数の掛け算になる。
   */
  const want = new Set();
  for (const a of filterAnchors(pane)) {
    const p2 = a.split('/');
    for (let i = 1; i <= p2.length; i++) want.add(p2.slice(0, i).join('/'));
  }
  const levelOf = new Map(pane.toc.map(e => [e.id, e.level]));

  // 条・前文・別表・附則直下の項など、本文の塊ごとに見せるかを決める
  const show = new Map();
  let shown = 0;
  for (const el of kids) {
    const a = el.dataset && el.dataset.anchor;
    if (!a) { show.set(el, false); continue; }
    const hit = want.has(a);
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
  return shown;
}

function setFilter(f, pane) {
  pane = pane || P();
  pane.filter = f;
  applyFilter(pane);
  measureHeadings(pane);      // 隠すと位置が変わる
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
      // 上段の並びは ← → / 番号 / 2面 / 表示 の順に戻す
      $('.topbar').insertBefore(jump, $('#btn-split'));
      $('.topbar-head').appendChild(nav);     // 戻る・進むは左ゾーンへ
      $('.topbar').appendChild(view);
      $('#pane-laws').insertBefore(panel, $('#panel-marks'));
    }
    // ことばの欄は、結果と同じ場所（検索タブの中）に置く
    if (find.parentElement !== panel) panel.insertBefore(find, panel.firstChild);
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

let tocCurrent = null;      // 目次でいま光っている項目

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

  /*
   * 指を滑らせている間、ほとんどのフレームでは同じ見出し・同じ条のままである。
   * 変わっていないなら何もしない。作り直しと目次の塗り替えが丸ごと消える。
   */
  const sig = here.id + '|' + (art ? art.anchor : '');
  if (pane._crumbSig === sig && !crumb.hidden) return;
  pane._crumbSig = sig;
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

  /*
   * 目次の現在位置は、操作している面にだけ追随させる。
   * 全部を舐めると、民法で384件・会社法で592件を毎回触ることになる。
   * 外す1件と付ける1件だけを触る。
   */
  if (pane === P()) {
    if (tocCurrent && tocCurrent.isConnected) tocCurrent.classList.remove('current');
    tocCurrent = $(`#toc-list li[data-id="${CSS.escape(here.id)}"]`);
    if (tocCurrent) tocCurrent.classList.add('current');
  }
}

/**
 * 指定の条文へ移動する。
 * edit:false のときは枠を出すだけで注釈パネルを開かない。
 * 条文を引いた直後に見たいのは本文であって、編集欄ではないため。
 */
/*
 * 滑らせるか、瞬間で移るか。
 *
 * 近い先へ滑らせるのは役に立つ。どちらへどれだけ動いたかが目で追えるので、
 * いま条文のどこにいるかの見当が保てる。
 *
 * しかし1条から709条のような距離を滑らせると、700条ぶんの本文がただ流れる
 * だけで、そこから何も読み取れない。時間もかかり、目も疲れる。1画面半より
 * 遠ければ瞬間で移る。番号で引くときはほとんどこちらになる。
 *
 * 端末で「動きを控える」を選んでいる人には、距離を問わず瞬間で移る。
 */
const SMOOTH_LIMIT = 1.5;               // 面の高さの何倍まで滑らせるか

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function behaviorForDistance(dist, viewH) {
  if (reducedMotion()) return 'auto';
  if (!viewH) return 'smooth';          // 高さが取れない場面では今までどおり
  return dist > viewH * SMOOTH_LIMIT ? 'auto' : 'smooth';
}

/*
 * 飛び先を画面のどこに置くか。
 *
 * 前は scrollIntoView({ block: 'center' }) を使い、「要素の真ん中」を画面の
 * 真ん中に合わせていた。しかし前メモ・後メモ・タグはその要素の中に入るので、
 * メモを書くほど要素が縦に伸び、真ん中が下がる。そのぶん条番号は上へずれる。
 * メモが画面より長くなると、条番号は画面の外へ出てしまう。
 *
 * 狙うのは要素の真ん中ではなく、その塊の先頭である。上端を面の高さの 22% の
 * ところに置く。上に少し残すのは、直前の条文が見えている方が位置の見当が
 * 付くからで、上端ぴったりに付けるとマークの●（left:-.95em）も窮屈になる。
 *
 * 後メモを何行書いても飛び先は動かない。ただし「条番号がいつも同じ高さ」では
 * ない。条に付けた前メモは第1項より前に入るので、そこが長い条では条番号は
 * そのぶん下に来る（Codex の指摘）。動かないのは塊の上端である。
 */
const JUMP_LEAD = 0.22;        // 飛び先の上端を、面の高さの何割のところに置くか

/** 飛び先の上端 y を、面のどこに置くか。負にはしない。 */
function jumpTopFor(y, viewH) {
  return Math.max(0, y - viewH * JUMP_LEAD);
}

/** 面の中で、その要素まで何 px 送ればよいか */
function scrollTopFor(el, pane) {
  const box = pane.el.getBoundingClientRect();
  const to = el.getBoundingClientRect();
  // いまの送り量に、面の上端から要素の上端までの差を足すと、要素の絶対位置になる
  return jumpTopFor(pane.el.scrollTop + (to.top - box.top), box.height);
}

/** 飛ぶ。滑らせるかどうかは、実際に送る距離で決める。 */
function scrollPaneTo(top, pane) {
  pane.el.scrollTo({
    top,
    behavior: behaviorForDistance(Math.abs(top - pane.el.scrollTop), pane.el.clientHeight),
  });
}

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
  scrollPaneTo(scrollTopFor(el, pane), pane);
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
    ${conflictHtml(rec)}
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

  wireConflict(body, rec, async solved => {
    await store.putRange(solved);
    state.ranges.set(solved.id, solved);
    paintRanges();
    renderMarkList();
    openRangePopover(solved.id);
  });

  const palette = $('#palette');
  const paint = () => {
    palette.innerHTML = '';
    for (const c of RANGE_STYLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = c.label;
      // 下線は色を敷かない。見本も下線で示す。
      if (c.key === 'ul') b.className = 'ul';
      else b.style.background = `var(--mk-${c.key})`;
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
  // 墓石は画面に出さない。比較と書き出しでは使うので、DBには残っている
  const all = livingOnly(await store.allNotes());
  state.notes = new Map(all.map(n => [n.key, n]));
  renderMarkList();
  renderFilterPicker();
}

function paintNotes() {
  for (const pane of livePanes()) paintNotesIn(pane);
}

function paintNotesIn(pane) {
  /*
   * 前に塗ったものを外す。全アンカー（会社法で6,318件）を舐めるのではなく、
   * 実際に塗ってあるものだけを外す。注釈が1件も無ければ何も起きない。
   */
  for (const el of $$('.mk', pane.el)) {
    el.classList.remove('mk');
    MARK_COLORS.forEach(c => el.classList.remove('mk-' + c.key));
  }
  for (const el of $$('.inline-tags, .memo-inline, .note-summary', pane.el)) el.remove();

  if (!pane.current) return;

  // 塗る先も、注釈のある場所だけを引く。本文を端から見ない。
  for (const n of state.notes.values()) {
    if (n.lawId !== pane.current.lawId) continue;
    const el = findAnchorEl(n.anchor, pane);
    if (!el) continue;
    if (n.color) el.classList.add('mk', 'mk-' + n.color);
    if (n.tags && n.tags.length) insertTags(el, n.tags);
    if ((n.summary || '').trim()) insertSummary(el, n.summary);
    if ((n.memo || '').trim()) insertMemo(el, n.memo);
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

/*
 * 後メモを入れる位置を決める。下位の条項号があれば、その直前を返す。
 *
 * 刑訴60条1項のように号を持つ項では、末尾に足すと第三号の下に出てしまう。
 * 号にもそれぞれのアンカーがあるので、項に付けたメモと第三号に付けたメモが
 * 見分けられない。会社法2条1項なら38号ぶん流れた先に出る。
 *
 * ただし自分の文を持たない要素は末尾のままにする。条は本文を持たず項を
 * 並べるだけなので、前に入れると見出しの直後、つまり前メモと同じ場所になり、
 * 「前」「後」の区別が消える。番号と見出しは自分の文には数えない。
 */
/*
 * 「自分の文」に数えないもの。番号・見出し・自分で書いた注釈。
 *
 * h-section は編章節款目の見出しで、renderBlock が出す。別記のように
 * 本文を持たない容器の中に見出しと項が並ぶと、これを本文と数えてしまい
 * 「見出し → 後メモ → 第1項」の順になる（Codex の指摘）。
 * 本文を落とす向きの誤りを避けるため、除くのは見出しだけに限る。
 */
const NOT_BODY = ['article-title', 'para-num', 'item-title', 'article-caption',
  'h-section', 'suppl-label', 'note-dup',
  'note-summary', 'inline-tags', 'memo-inline'];

/** el が「自分の文」を持っているか。番号・見出し・自分で書いた注釈は数えない。 */
function hasOwnBody(el, until) {
  for (let n = el.firstChild; n && n !== until; n = n.nextSibling) {
    if (n.nodeType === 3) {                       // 素のテキスト。本文はここに出る
      if (n.nodeValue.trim()) return true;
      continue;
    }
    if (n.nodeType !== 1) continue;
    if (NOT_BODY.some(c => n.classList.contains(c))) continue;
    if (n.textContent.trim()) return true;        // 括弧書き・ルビ・印なども本文
  }
  return false;
}

/*
 * 後メモを置く場所。親と、その直前に入れる要素を返す。
 *
 * 自分の文があれば、その直後（＝下位の条項号の直前）に置く。
 *
 * 条は自分の文を持たず、項を並べるだけである。しかし **項が1つだけの条** では、
 * その項の中身が「この条の本文」そのものなので、中に入って柱書の直後に置く。
 * ここを末尾のままにすると、号を持つ条で号の後ろへ回ってしまう。
 * 刑訴89条（号6個）で末尾、会社法2条なら38号ぶん離れた先に出ていた。
 *
 * 項が2つ以上ある条は末尾のままにする。どの項に付けたのか紛れるし、
 * 「この条について」のメモは最後にある方が自然である。
 */
function memoSlot(el) {
  const first = [...el.children].find(c => c.dataset && c.dataset.anchor);
  if (!first) return { parent: el, before: null };      // 下位が無い。末尾でよい
  if (hasOwnBody(el, first)) return { parent: el, before: first };

  if (el.classList.contains('article')) {
    const paras = [...el.children]
      .filter(c => c.classList.contains('para') && c.dataset && c.dataset.anchor);
    if (paras.length === 1) return memoSlot(paras[0]);   // 項1つ＝この条の本文
  }
  return { parent: el, before: null };
}

/** 後方互換のための薄い包み（試験と、以前の呼び出しのため）。 */
function memoInsertPoint(el) {
  const slot = memoSlot(el);
  return slot.parent === el ? slot.before : slot.before;
}

/*
 * 文字タグを本文に置く。
 *
 * 以前は要素の末尾に足していた。すると号を持つ項では、号を全部飛び越えて
 * 一番後ろに出る。刑訴89条（号6個）や会社法2条（号38個）で、タグだけが
 * 遠くに離れていた。後メモと同じ場所（自分の文の直後）に置く。
 *
 * タグは短い札なので、後メモ（塊）より前に出す。paintNotesIn がタグ→後メモの
 * 順に呼ぶので、同じ差し込み位置を指定すれば、その順に並ぶ。
 */
function insertTags(el, tags) {
  const anchor = el.dataset.anchor || '';
  const sel = '.inline-tags[data-for="' + attrEsc(anchor) + '"]';
  let span = el.querySelector(sel);
  if (!span) {
    span = document.createElement('span');
    span.className = 'inline-tags';
    span.dataset.for = anchor;
  }
  span.innerHTML = tags.map(t => `<span class="t">${esc(t)}</span>`).join('');
  const { parent, before } = memoSlot(el);
  if (span.parentNode !== parent || span.nextSibling !== before) {
    parent.insertBefore(span, before);
  }
  return span;
}

/*
 * 後メモを本文に置く。すでにあるものは、必要なときだけ動かす。
 *
 * 置き場所が入れ子の中（項の中）になることがあるので、どのアンカーのメモかを
 * data-for に書いておく。直下だけを探すと、中に入れたものを見つけられず、
 * 塗り直すたびに増えてしまう。
 */
function insertMemo(el, text) {
  const anchor = el.dataset.anchor || '';
  const sel = '.memo-inline[data-for="' + attrEsc(anchor) + '"]';
  let div = el.querySelector(sel);
  if (!div) {
    div = document.createElement('div');
    div.className = 'memo-inline';
    div.dataset.for = anchor;
  }
  const { parent, before } = memoSlot(el);
  // 打っている途中に飛ばさないよう、場所が変わるときだけ動かす
  if (div.parentNode !== parent || div.nextSibling !== before) {
    parent.insertBefore(div, before);
  }
  div.textContent = text;
  return div;
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

/** 本文に置いているメモを、打ち込みに合わせて即時更新する */
function updateInlineMemo(anchor, text, pane) {
  const el = $(`[data-anchor="${CSS.escape(anchor)}"]`, (pane || P()).el);
  if (!el) return;
  if (!String(text).trim()) {
    const old = el.querySelector('.memo-inline[data-for="'
      + attrEsc(el.dataset.anchor || '') + '"]');
    if (old) old.remove();
    return;
  }
  insertMemo(el, text);
}

/* ---------------------------------------------- ファイルから取り込む */

/*
 * e-Gov に無い法令を、法令標準XMLのファイルから取り込む。
 *
 * 最高裁判所規則（民事訴訟規則・刑事訴訟規則など）と議院規則は、e-Gov に
 * 1件も入っていない。内閣が公布するものではないためと思われるが、e-Gov 自身の
 * 法令種別の説明にはこれらのコードがあるので、理由は確かめられていない。
 *
 * 取り込んだものは e-Gov 由来と同じようには扱わない。いつの版なのか、
 * 公布済みの改正がどこまで入っているのかが、こちらからは分からないからである。
 *   ・一覧と本文に「取り込み」の印を出す
 *   ・改正の確認（e-Gov への問い合わせ）の対象から外す
 *   ・施行日は空にせず「不明」と出す。空欄は「無い」のか「分からない」のか
 *     区別が付かない
 */

const LOCAL_PREFIX = 'LOCAL_';

/*
 * 取り込むXMLの先頭のコメントから、来歴を読む。
 *
 * e-Gov から取ったものは、いつの版かが API の返す値で分かる。しかし自分で
 * 起こしたデータは、どこから作ったのか・どの改正まで入っているのか・何を
 * 含んでいないのかが、ファイルの外にしか無い。外に置くと必ず失われる。
 * ファイルの中のコメントに書いておけば、書き出しても復元しても一緒に残る。
 *
 *   <!--
 *     出典: 公的機関の法令データベース（日本語版）
 *     反映: 令和七年最高裁判所規則第一一号 まで
 *     範囲: 本則のみ（316条）。附則は含まない
 *   -->
 *
 * 「行頭のラベル: 中身」の形だけを読む。決めた名前以外は拾わない。
 * 取り込むファイルの中身を、そのまま画面に出すことになるからである。
 */
const PROV_KEYS = ['出典', 'URL', '取得', '反映', '範囲', '変換'];

function readProvenance(doc) {
  const out = {};
  const scan = parent => {
    for (const n of parent.childNodes) {
      if (n.nodeType !== 8) continue;                  // コメント以外は見ない
      for (const line of String(n.nodeValue).split('\n')) {
        const m = line.match(/^\s*([^\s:：]+)\s*[:：]\s*(.+?)\s*$/);
        if (m && PROV_KEYS.includes(m[1]) && !out[m[1]]) out[m[1]] = m[2].slice(0, 200);
      }
    }
  };
  scan(doc);
  const law = doc.querySelector('Law');
  if (law) scan(law);
  return Object.keys(out).length ? out : null;
}

/*
 * 取り込むXMLの LawNum は、そのまま信じられない。市販アプリの書き出しは
 * ここにアプリ内部のIDを入れている。法令番号の形をしているときだけ使う。
 */
/*
 * 「令和元年」のように、元号の最初の年は「元」と書く（「一年」とは書かない）。
 * 令和元年最高裁判所規則も実在するので、年のところだけ「元」を許す。
 * これは法令番号の真正性を保証するものではなく、市販アプリが入れてくる
 * 内部IDを除くための形の検査である。
 */
const LAW_NUM_RE = /^(明治|大正|昭和|平成|令和)(?:元|[〇一二三四五六七八九十百千]+)年.{1,14}第[〇一二三四五六七八九十百千]+号$/;

function lawNumOf(doc) {
  const el = doc.querySelector('LawNum');
  const t = el ? el.textContent.trim() : '';
  return LAW_NUM_RE.test(t) ? t : '';
}

/*
 * 市販アプリの書き出しには、注釈付きだと妥当な XML にならないものがある。
 * 既知の壊れ方は2つで、どちらも直せば標準のパーサで読める。
 *   ・XML 宣言が `?>` ではなく `>` で終わる
 *   ・notes 属性が単引用で始まり二重引用で閉じる
 */
function repairExportXml(text) {
  let t = String(text).replace(/^\uFEFF/, '');
  t = t.replace(/^<\?xml([^>]*?)\??>/, '<?xml$1?>');
  t = t.replace(/notes='([^'"]*)"/g, 'notes="$1"');
  return t;
}

/** アプリ独自の注釈要素を外す。条文だけを残す。 */
function stripAppElements(doc) {
  let n = 0;
  for (const tag of ['Highlight', 'HighlightEnd', 'Bookmark', 'BookmarkNotes']) {
    for (const el of [...doc.getElementsByTagName(tag)]) { el.remove(); n++; }
  }
  return n;
}

/*
 * 法令標準XMLのファイルを1本取り込む。
 *
 * opts.defer を渡すと、一覧の作り直しと画面の開き直しをしない。まとめて
 * 取り込むときに、1本ごとに7回描き直すのを避けるためである（importLawFiles）。
 */
async function importLawFile(file, opts) {
  const raw = await file.text();
  let doc;
  try {
    doc = parseXML(repairExportXml(raw));
  } catch (e) {
    throw new Error('XML として読めません（法令標準XMLのファイルを選んでください）');
  }

  const lawEl = doc.querySelector('Law');
  if (!lawEl) throw new Error('Law 要素がありません');
  const stripped = stripAppElements(doc);

  const titleEl = lawEl.querySelector('LawTitle');
  const lawTitle = titleEl ? titleEl.textContent.trim() : '';
  if (!lawTitle) throw new Error('法令名（LawTitle）がありません');

  // 描いてみて、中身を確かめてから取り込む。読めないものを抱え込まない。
  const { index } = renderLaw(lawEl);
  if (!index.length) throw new Error('条文が1件も読み取れません');

  /*
   * 同じアンカーを指す場所が複数ないか調べる。
   *
   * 注釈の位置はアンカーで持つので、重なっていると「どちらに付けたのか」が
   * 決まらない。黙って取り込むと、あとで別の条に付いているように見える。
   *
   * 元データを直して重なりを解くことはしない。たとえば民事訴訟規則の附則には、
   * 見出し（（施行期日）など）が独立した項として入っていて、本物の項と番号が
   * 重なっている。これを推測で畳むのは、法令を正確に表すという原則を一番
   * 危うくする。見つけたことを知らせるだけにする。
   */
  const seen = new Map();
  for (const e of index) seen.set(e.anchor, (seen.get(e.anchor) || 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([a]) => a);

  const rec = {
    lawId: LOCAL_PREFIX + lawTitle,
    lawTitle,
    lawNum: lawNumOf(doc),         // 法令番号の形をしているときだけ使う（上の LAW_NUM_RE）
    source: 'file',
    importedAt: today(),
    provenance: readProvenance(doc),
    dupAnchors: dup,
    xml: new XMLSerializer().serializeToString(doc),
    savedAt: Date.now(),
  };
  await store.putLaw(rec);
  /*
   * 同じ名前で取り込み直したとき、lawId が同じなので navigate は
   * 開き直さない。DBだけ新しくなって画面は古いまま、という状態になる。
   * 「取り込みました」と出るので、新しい本文だと思い込む。
   */
  state.indexCache.delete(rec.lawId);
  rec.strippedMarks = stripped;        // 通知でまとめて数えるため、記録に残す
  /*
   * ここで返すと、一覧の作り直しと画面の開き直しは呼び側がやる。
   * まとめて取り込むとき、1本ごとに描き直すのを避けるため（importLawFiles）。
   * 渡されなければ、下で1本ぶんの後始末をする。
   */
  if (opts && opts.defer) return rec;

  await finishImport([rec], []);
  return rec;
}

/*
 * 取り込んだあとの後始末と通知。1本でもまとめてでも、ここだけを通る。
 *
 * 前は単体とまとめで同じ処理を二重に書いていた。文言が違うので、片方だけ
 * 直して気づかない、という形になりやすい（Codex の指摘）。
 *
 * 保存はもう終わっている。ここから先で失敗しても、保存できた件数と
 * 読めなかったファイル名は必ず知らせる。以前はここで例外が出ると報告ごと
 * 失われ、何件入ったのか分からなくなっていた。
 */
async function finishImport(done, failed) {
  let refreshFailed = '';
  try {
    await refreshLawList();
    // 開いている面が取り込み直した法令を見ているなら、新しい本文に入れ替える
    for (const pane of livePanes()) {
      if (pane.current && done.some(r => r.lawId === pane.current.lawId)) {
        await openLaw(pane.current.lawId, null, 0, pane);
      }
    }
    if (done.length) await navigate(done[done.length - 1].lawId);
  } catch (err) {
    refreshFailed = err && err.message ? err.message : String(err);
  }

  /*
   * 知らせることは4つ。取り込めたもの、読めなかったもの、外した注釈の印、
   * 位置の重なり。重なりは法令名を挙げる。件数だけでは、どれを気にすべきか
   * 分からない。
   */
  const dup = done.filter(r => (r.dupAnchors || []).length);
  const marks = done.reduce((n, r) => n + (r.strippedMarks || 0), 0);
  const parts = [];
  if (done.length) {
    parts.push(done.length === 1
      ? '「' + done[0].lawTitle + '」を取り込みました'
      : done.length + '件を取り込みました');
  }
  if (failed.length) parts.push('読めなかったもの: ' + failed.join('、'));
  if (marks) parts.push('注釈の印 ' + marks + '件は外しました');
  if (dup.length) {
    parts.push(done.length === 1
      ? '同じ位置を指す条項が ' + dup[0].dupAnchors.length + '件あります'
      : '位置の重なりあり: ' + dup.map(r => r.lawTitle).join('、'));
  }
  // 保存はできている。画面が追いついていないだけだと分かるように書く
  if (refreshFailed) parts.push('保存はできましたが画面の更新に失敗しました（' + refreshFailed + '）');
  if (!parts.length) parts.push('取り込めるものがありませんでした');
  toast(parts.join('　/　'));
  return refreshFailed;
}

/*
 * まとめて取り込む。
 *
 * 規則のように、何本かを一度に用意することがある。1本ずつ選ばせると
 * その回数だけ操作させることになる。
 *
 * 1本ごとに一覧を作り直したり画面を開き直したりはしない。7本なら7回
 * 描き直すことになる。最後に一度だけまとめてやる。
 *
 * 途中で読めないものがあっても、残りは続ける。1本のために他を捨てる理由がない。
 * 読めなかったものは名前を挙げて知らせる。黙って数を減らさない。
 */
async function importLawFiles(files) {
  const list = [...files];
  const done = [], failed = [];
  for (const f of list) {
    try {
      done.push(await importLawFile(f, { defer: true }));
    } catch (err) {
      failed.push((f.name || 'ファイル') + '（' + err.message + '）');
    }
  }

  const refreshFailed = await finishImport(done, failed);
  return { done, failed, refreshFailed };
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
  // 取り込んだものは e-Gov に無いので、問い合わせても答えが返らない
  const targets = state.laws.filter(l => !l.revisionOf && l.source !== 'file');
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
  if (!rec || rec.revisionOf || rec.source === 'file') return null;   // 固定版・取り込みには出さない
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
  tocCurrent = null;         // 作り直したので、前の参照はもう繋がっていない
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
      const top = scrollTopFor(target, P());
      scrollPaneTo(top, P());
      // 履歴には実際に送った位置を残す。目次の位置と戻ったときの位置を揃える。
      pushHist({ lawId: P().current.lawId, anchor: null, scrollTop: top });
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
      kind: 'note', lawId: n.lawId, anchor: n.anchor, at: n.updatedAt || 0,
      color: n.color || '', tags: n.tags || [],
      memo: [n.summary, n.memo].map(t => String(t || '').trim()).filter(Boolean).join('　'),
      phrase: '',
    });
  }
  for (const r of state.ranges.values()) {
    out.push({
      kind: isSlash(r) ? 'slash' : 'range', id: r.id, lawId: r.lawId, anchor: r.anchor,
      at: r.updatedAt || 0,
      slash: SLASH_KINDS[r.kind] || '',
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
  const used = RANGE_STYLES.filter(c => byColor.get(c.key));
  const anySlash = marks.some(m => m.kind === 'slash');
  if (!used.length && !memoCount && !anySlash) {
    ml.innerHTML = '<li style="color:var(--fg-faint);cursor:default">まだありません</li>';
  }
  for (const c of used) {
    const li = document.createElement('li');
    li.innerHTML = (c.key === 'ul'
      ? '<span class="sw ul"></span>'
      : `<span class="sw" style="background:var(--mk-${c.key})"></span>`)
      + `<span>${esc(c.label)}</span><span class="n">${byColor.get(c.key)}</span>`;
    li.onclick = () => showMarkResults(m => m.color === c.key,
      c.key === 'ul' ? '下線' : `${c.label}のマーク`);
    ml.appendChild(li);
  }
  /*
   * 別々に直したものは、放っておくと気づけない。専用の行で数を出す。
   * 押せばその一覧が出るので、そこから開いて決められる。
   */
  const cfCount = [...state.notes.values()].filter(hasConflict).length
    + [...state.ranges.values()].filter(hasConflict).length;
  if (cfCount) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="sw" style="background:var(--mk-red-b,#c00)"></span>'
      + `<span>別の編集があるもの</span><span class="n">${cfCount}</span>`;
    li.onclick = () => showMarkResults(m => {
      const r = m.kind === 'note'
        ? state.notes.get(m.lawId + ':' + m.anchor) : state.ranges.get(m.id);
      return hasConflict(r);
    }, '別の編集があるもの');
    ml.appendChild(li);
  }

  // 区切りは色もメモも持たないので、専用の行が無いと一覧から辿れない
  const slashCount = marks.filter(m => m.kind === 'slash').length;
  if (slashCount) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="sw" style="background:var(--ink)"></span>'
      + `<span>区切りの印</span><span class="n">${slashCount}</span>`;
    li.onclick = () => showMarkResults(m => m.kind === 'slash', '区切りの印');
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

  /*
   * いま選んでいる位置が、取り込んだデータの中で他と重なっているなら、
   * そのときに言う。付けても「どちらに付けたのか」が決まらない。
   */
  const dupHere = (pane.current.dupAnchors || []).includes(anchor);

  body.innerHTML = `
    ${dupHere ? '<div class="note-dup">この位置は、同じ番号の別の条項と重なっています。'
      + 'ここに付けた注釈は、どちらを指すか決まりません。</div>' : ''}
    ${conflictHtml(note)}
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

  wireConflict(body, note, async solved => {
    // 選んだ中身で置き換える。版は resolveConflict が組んである
    await store.putNote(solved);
    state.notes.set(solved.key, solved);
    paintNotes();
    renderMarkList();
    renderNotePane();
  });

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

/*
 * 保存できたかどうかを返す（true / false）。
 *
 * 以前は失敗しても toast を出して正常に返っていたので、呼び側が成否を
 * 区別できなかった。同期では「保存できていないのに送る」ことになる。
 * 例外にはしない。打っている最中の自動保存が失敗したときに、操作全体を
 * 止めてしまうため。
 */
async function saveNote(note) {
  note.updatedAt = Date.now();
  // この端末の編集を1つ進める。前後は時計ではなくこれで決める
  note.version = vvBump(note.version, deviceId);
  try {
    if (!note.tags.length && !(note.memo || '').trim()
      && !(note.summary || '').trim() && !note.color) {
      // 消した印を残す。本当に消すと、古いバックアップから復活する
      await store.tombNote(noteTomb(note, note.updatedAt));
      state.notes.delete(note.key);
    } else {
      await store.putNote(note);
      state.notes.set(note.key, note);
    }
    saveFailures.delete('note:' + note.key);      // 保存できたので、前の失敗は解く
  } catch (err) {
    saveFailures.add('note:' + note.key);
    toast('保存できませんでした: ' + err.message);
    return false;
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
  return true;
}

/* ------------------------------------------------------ 文言へのメモ（範囲） */


async function loadRanges() {
  // 墓石は画面に出さない。比較と書き出しでは使うので、DBには残っている
  state.ranges = new Map(livingOnly(await store.allRanges()).map(r => [r.id, r]));
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
  // 区切りの印は中身を持たないので、そのまま外す。片付けを忘れると重なって増える。
  for (const m of $$('span[data-slash-id]', pane.el)) {
    const parent = m.parentNode;
    m.remove();
    parent.normalize();
  }
  if (!pane.current) return;

  for (const r of state.ranges.values()) {
    if (r.lawId !== pane.current.lawId) continue;
    const el = findAnchorEl(r.anchor, pane);
    if (!el) { state.orphanRanges.push(r); continue; }
    const map = textMapOf(el);
    // 指定の出現が無いときに最初の一致へ寄せると、別の文言に注釈が移ってしまう。
    // 「黙って別の場所に付けない」方針のとおり、見つからなければ要確認にする。
    const at = nthIndexOf(map.text, r.text, r.nth || 1);
    if (at < 0) { state.orphanRanges.push(r); continue; }
    if (isSlash(r)) {
      // 「。」の直後に置く。文言そのものは包まない。
      placePointInMap(el, at + r.text.length,
        'slash' + (r.kind === 'dslash' ? ' dslash' : ''), r.id, map);
    } else {
      wrapInMap(el, at, at + r.text.length,
        'rng' + (r.color ? ' rng-' + r.color : '') + (r.memo ? ' has-memo' : ''), r.id);
    }
  }
}


/* ------------------------------------------------------- 区切りの印（/ //） */

/*
 * 紙の六法に手で引く「/」と同じもの。本文とただし書、前段と後段の境目に
 * 自分で引く。自動では引かない。
 *
 * 法令標準XMLは、ただし書を Sentence@Function="proviso" として持っているし、
 * 前段後段も Sentence が分かれている（民法339組・会社法339組など実測）。
 * それを読んで自動で出すこともできるが、そうしない。民法だけで339箇所に
 * 一斉に出ても、ほとんどは線を引きたい場所ではない。印を付ける行為そのものが
 * 読むことの一部であり、自動で出たものは自分が引いた線ではない。
 * 加えて、取り込んだデータには構造が無いことがある（民事訴訟規則は Function
 * ゼロ・文の分割もゼロ）。手で引く形なら、データの質に左右されない。
 *
 * 位置の持ち方は文言メモと同じ。「。」までの数文字と、その条項号の中で
 * 何番目の出現かで持つ。文字の位置では持たない。改正で一字変われば全部ずれる。
 *
 * 本文に「/」の文字は入れない。条文に無い文字なので、検索・コピー・書き出し・
 * 他の注釈の位置計算に混ざる。幅ゼロの印を置いて CSS で描く。
 */

const SLASH_KINDS = { slash: '/', dslash: '//' };

/** 区切りか。kind を持たない古い記録は、これまでどおり文言メモ。 */
function isSlash(r) { return !!(r && SLASH_KINDS[r.kind]); }

/**
 * el の中の pos 文字目に、幅ゼロの印を置く。
 * wrapInMap は正の長さが無いと何も作らないので、こちらは別に用意する。
 */
function placePointInMap(el, pos, cls, id, map0) {
  const map = map0 || textMapOf(el);
  const seg = map.nodes.find(x => pos >= x.start && pos <= x.end);
  if (!seg) return false;
  const node = seg.node;
  const off = pos - seg.start;
  const mark = document.createElement('span');
  mark.className = cls;
  mark.dataset.slashId = id;

  if (off <= 0) {
    node.parentNode.insertBefore(mark, node);
  } else if (off >= node.nodeValue.length) {
    // その文字ノードの末尾。親の末尾ではなく、この文字ノードのすぐ後ろに置く。
    // 親の末尾に付けると、後ろにぶら下がるメモより外に出てしまう。
    node.parentNode.insertBefore(mark, node.nextSibling);
  } else {
    const rest = node.splitText(off);
    rest.parentNode.insertBefore(mark, rest);
  }
  return true;
}

/*
 * 押した場所の近くにある「。」を探す。
 *
 * 「。」を一つずつ要素で包むことはしない。民法だけで3,000個を超えるので、
 * 読むための本文がそのぶん重くなる。押された座標から文字の位置を割り出し、
 * その前後だけを見る。
 */
function sentenceEndNear(x, y) {
  let node = null, off = 0;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; off = r.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const r = document.caretPositionFromPoint(x, y);
    if (r) { node = r.offsetNode; off = r.offset; }
  }
  if (!node || node.nodeType !== 3) return null;

  const el = node.parentElement && node.parentElement.closest('[data-anchor]');
  if (!el) return null;

  const map = textMapOf(el);
  const seg = map.nodes.find(s2 => s2.node === node);
  if (!seg) return null;
  const at = seg.start + off;

  // 押した位置の前後3文字だけを見る。離れた「。」には反応しない。
  const NEAR = 3;
  let best = -1;
  for (let d = 0; d <= NEAR; d++) {
    for (const i of [at + d, at - d]) {
      if (i < 0 || i >= map.text.length) continue;
      if (map.text[i] === '。') { best = i; break; }
    }
    if (best >= 0) break;
  }
  if (best < 0) return null;

  // 「。」までの数文字を覚える。これが位置決めの手がかりになる。
  const from = Math.max(0, best - 7);
  const text = map.text.slice(from, best + 1);
  let nth = 0;
  for (let i = 0; i + text.length <= best + 1; i++) {
    if (map.text.startsWith(text, i)) nth++;
  }
  // どの法令のどの面で押したかを一緒に持つ。バーを開いたまま別の法令へ
  // 移って押すと、この文言を別の法令に付けてしまう。
  const pane = P();
  return {
    anchor: el.dataset.anchor, text, nth, at: best + 1,
    lawId: pane.current && pane.current.lawId, paneIdx: pane.idx,
  };
}

/*
 * その場所にすでに区切りが付いているか。
 *
 * 印は幅ゼロなので、指で直接押すことはできない。「。」を押したときに、
 * 同じ場所の印を探して、種類の変更と削除の入口にする。
 */
function existingSlash(lawId, anchor, text, nth) {
  for (const r of state.ranges.values()) {
    if (!isSlash(r)) continue;
    if (r.lawId === lawId && r.anchor === anchor && r.text === text && (r.nth || 1) === nth) return r;
  }
  return null;
}

let slashPending = null;      // これから付ける位置、または付いている印

function showSlashBar(atRect, current) {
  const bar = $('#slashbar');
  bar.hidden = false;
  const w = bar.offsetWidth, h = bar.offsetHeight, pad = 12;
  bar.style.left = Math.min(Math.max(pad, atRect.left + atRect.width / 2 - w / 2),
    window.innerWidth - w - pad) + 'px';
  // 選択の色バーと同じ考え方で、下に出す。iOS の「コピー・調べる」と重ならない。
  const barEl = $('#bottombar');
  const floor = window.innerHeight - pad - (barEl && !barEl.hidden ? barEl.offsetHeight : 0);
  let top = atRect.bottom + 10;
  if (top + h > floor) top = atRect.top - h - 10;
  bar.style.top = Math.max(pad, top) + 'px';

  for (const b of $$('#slashbar button')) {
    b.classList.toggle('on', !!current && b.dataset.slash === current.kind);
  }
}

function hideSlashBar() { $('#slashbar').hidden = true; slashPending = null; }

async function applySlash(kind) {
  const p = slashPending;
  hideSlashBar();
  if (!p || !P().current) return;

  // 開いたときと同じ法令・同じ面でなければ、何もしない。
  if (p.lawId && (p.lawId !== P().current.lawId || p.paneIdx !== P().idx)) return;

  if (p.id) {                                   // すでに付いている印を押した
    if (kind === 'none') { await deleteRange(p.id); return; }
    const rec = state.ranges.get(p.id);
    if (!rec) return;
    rec.kind = kind;
    await saveRange(rec);
    return;
  }
  if (kind === 'none') return;

  await saveRange({
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    lawId: P().current.lawId,
    anchor: p.anchor,
    kind,
    text: p.text,
    nth: p.nth,
    color: '', memo: '',
  });
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

/** 保存できたかを返す。理由は saveNote の注記を見よ。 */
async function saveRange(rec) {
  rec.updatedAt = Date.now();
  rec.version = vvBump(rec.version, deviceId);       // 理由は saveNote の注記を見よ
  try {
    await store.putRange(rec);
  } catch (err) {
    saveFailures.add('range:' + rec.id);
    toast('文言メモを保存できませんでした: ' + err.message);
    return false;
  }
  saveFailures.delete('range:' + rec.id);         // 保存できたので、前の失敗は解く
  state.ranges.set(rec.id, rec);
  paintRanges();
  renderMarkList();
  renderFilterPicker();
  return true;
}

async function deleteRange(id) {
  const rec = state.ranges.get(id) || { id };
  const now = Date.now();
  await store.tombRange(rangeTomb(rec, now, vvBump(rec.version, deviceId)));
  state.ranges.delete(id);
  paintRanges();
  renderMarkList();
  renderFilterPicker();
  closePopover();
}

/* ----------------------------------------------------------- 括弧書き */

function clearParens(pane) {
  for (const el of $$('span.paren', pane.el)) {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    el.remove();
    parent.normalize();
  }
}

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
      wrapInMap(el, r.s, r.e, 'paren p' + Math.min(r.d, 3), 'paren', 'span', map);
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

  endFind();                // 引いた先を読むので、前の検索の色は消す

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
 *
 * 当たりが出ている下見は、そこを押しても引ける（doJump へ）。目で確かめた直後に
 * 視線を「引く」へ戻さずに済む。「引く」はそのまま残してある。
 */
function updateJumpPreview() {
  const box = $('#jump-preview');
  if (!box) return;
  const raw = $('#jump-input').value.trim();
  if (!raw || !P().current) { box.hidden = true; return; }

  const show = (label, body, miss, go) => {
    box.hidden = false;
    box.classList.toggle('miss', !!miss);
    // 引ける下見だけを押せるようにする。「見つかりません」は押しても何も起きない。
    box.classList.toggle('go', !!go);
    if (go) { box.setAttribute('role', 'button'); box.tabIndex = 0; }
    else { box.removeAttribute('role'); box.removeAttribute('tabindex'); }
    box.innerHTML = `<span class="pv-label">${esc(label)}</span>`
      + `<span class="pv-text">${esc(body)}</span>`;
  };

  const { law, rest } = splitLawPrefix(raw);
  // 別の法令を指しているときは、開いてみないと中身が読めない
  if (law && law.lawId !== P().current.lawId) {
    show(law.lawTitle, '押すと開きます', true, true);
    return;
  }

  const p = parseJump(law ? rest : raw);
  const r = p && resolveJump(p);
  if (!r) { show(raw, '見つかりません', true, false); return; }

  const el = findAnchorEl(r.anchor);
  if (!el) { box.hidden = true; return; }
  show(anchorLabel(r.anchor), previewTextOf(el), false, true);
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
  q: '', where: 'law', inText: true, inNotes: true, busy: false,
  results: [], at: -1, truncated: false, scopeLawId: null,
};

/*
 * 検索欄そのものに、何を対象にしているかを出す。
 *
 * 2面にしていると「どちらの法令を検索するのか」が欄からは分からなかった。
 * 欄を面ごとに2つ置くと、結果の一覧の置き場所が無くなる（左ペインは1つしか
 * ない）。欄は1つのまま、対象を欄に書く。面を切り替えれば文言も変わる。
 */
function syncFindPlaceholder() {
  const el = $('#find-input');
  if (!el) return;
  if (find.where === 'all') {
    el.placeholder = `全法令（${state.laws.length}件）を検索`;
    return;
  }
  const t = P().current && P().current.lawTitle;
  if (!t) { el.placeholder = '本文・メモを検索'; return; }
  // 長い法令名は詰める。欄からあふれると、かえって読めない。
  el.placeholder = (t.length > 12 ? t.slice(0, 12) + '…' : t) + 'を検索';
}
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
  /*
   * 探している間、古い結果が残っていると、新しい語で探しているのか
   * 分からない。特にスマホのシートでは結果が上に積まれるので、状態の行が
   * 流れて見えなくなる。先に古い結果を消して「探しています」を出す。
   */
  find.busy = true;
  find.results = [];
  find.truncated = false;
  renderFindList();

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
      if (isSlash(r)) continue;   // 区切りは位置決めの文字列を持つだけ。メモではない
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
  find.busy = false;
  find.results = results;
  find.truncated = truncated;
  find.at = -1;
  find.scopeLawId = find.where === 'law' && P().current ? P().current.lawId : null;

  if (!narrow()) switchTab('find');   // 狭い画面では結果はシートの中。左ペインは触らない
  renderFindList();
  paintFindHits();
}

function clearFind() {
  find.busy = false;
  find.results = [];
  find.at = -1;
  renderFindList();
  paintFindHits();
}

/*
 * 検索をやめる。
 *
 * 番号で引くのと、ことばで探すのは、別のやり方で同じ場所へ行く手段である。
 * 引いた先を読もうとしているときに、前の検索の色が本文に残っていると邪魔になる。
 * 打った言葉は欄に残すので、もう一度 Enter を押せば戻せる。
 */
function endFind() {
  find.busy = false;
  find.q = '';
  find.results = [];
  find.at = -1;
  find.truncated = false;
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
      const el = findAnchorEl(anchor, pane);        // 本文全体を探し直さない
      if (!el) continue;
      const map = textMapOf(el);
      // 後ろから当てれば、前の位置はずれない。対応表を作り直さずに済む。
      const runs = [...normalizedRanges(map.text, q)];
      for (let i = runs.length - 1; i >= 0; i--) {
        wrapInMap(el, runs[i][0], runs[i][1], 'hit', 'find', 'mark', map);
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
  status.innerHTML = !find.q
    ? `${esc(where)} を対象に検索します`
    : find.busy
      ? `<span class="q">${esc(find.q)}</span> を ${esc(where)} から探しています…`
      : `<span class="q">${esc(find.q)}</span> を ${esc(where)} から　${find.results.length}件`
        + (find.truncated ? '（上限で打ち切り）' : '');

  if (!find.q) return;
  if (find.busy) return;          // 探している間は、古い一覧を出さない
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


/*
 * アンカーを条文の並び順で比べるための鍵。
 *
 * 文字列のままだと「第10条」が「第2条」より前に来る。本則・附則・別表の
 * 別も文字列順では出ない。数として比べられる形に直す。
 */
function anchorSortKey(anchor) {
  const p = String(anchor).split('/');
  const scope = p[0] || '';
  let rank;
  if (scope === 'M') rank = 0;
  else if (/^S(\d+)$/.test(scope)) rank = 1000 + Number(RegExp.$1);
  else if (/^AP(\d+)$/.test(scope)) rank = 2000 + Number(RegExp.$1);
  else rank = 3000;

  // 前文は本則の先頭より前
  if (p[1] === '前文') return [rank, -1, 0, 0, 0];

  /*
   * 枝番は何段にもなる。労働基準法に「第三十二条の三の二」（32_3_2）が実在する。
   * 1段しか読まないと、32_3_2 が 32_3 の項より前に来てしまう。
   * 段の数をそろえるため、足りない分は 0 で埋める。
   */
  const DEPTH = 3;
  const num = t => {
    if (t === undefined || t === '') return new Array(DEPTH).fill(0);
    const parts = String(t).split(/[_:]/).map(x => {
      const m = String(x).match(/^(\d+)/);
      return m ? Number(m[1]) : Infinity;
    });
    while (parts.length < DEPTH) parts.push(0);
    return parts.slice(0, DEPTH);
  };
  return [rank].concat(num(p[1]), num(p[2]), num(p[3]));
}

function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

let markView = null;      // いま出している一覧（並べ替えで作り直すため）

function showMarkResults(pred, title) {
  markView = { pred, title };
  renderMarkResults();
  $('#dlg-find').showModal();
}

/*
 * 法令ごとにまとめて出す。
 *
 * 印が増えると、一列に並べただけでは何がどこにあるのか分からない。
 * 法令の並びは、法令タブで自分が並べた順に合わせる。
 */
function renderMarkResults() {
  if (!markView) return;
  const box = $('#find-results');
  const hits = allMarks().filter(markView.pred);
  $('#find-count').textContent = `${markView.title}　${hits.length}件`;

  const sortBtn = $('#mark-sort');
  sortBtn.hidden = hits.length < 2;
  const order = ($('#mark-sort button.on') || {}).dataset
    ? $('#mark-sort button.on').dataset.sort : 'doc';

  const byLaw = new Map();
  for (const m of hits) {
    if (!byLaw.has(m.lawId)) byLaw.set(m.lawId, []);
    byLaw.get(m.lawId).push(m);
  }
  // 法令タブで並べた順に合わせる。知らないものは後ろ。
  const rank = new Map(state.laws.map((l, i) => [l.lawId, i]));
  const laws = [...byLaw.keys()].sort((a, b) =>
    (rank.has(a) ? rank.get(a) : Infinity) - (rank.has(b) ? rank.get(b) : Infinity));

  box.innerHTML = '';
  for (const lawId of laws) {
    const list = byLaw.get(lawId);
    list.sort((a, b) => order === 'time'
      ? (b.at || 0) - (a.at || 0)
      : cmpKey(anchorSortKey(a.anchor), anchorSortKey(b.anchor)));

    const law = state.laws.find(l => l.lawId === lawId);
    const head = document.createElement('div');
    head.className = 'law-head';
    head.innerHTML = `${esc(law ? law.lawTitle : lawId)}<span class="n">${list.length}件</span>`;
    box.appendChild(head);

    const idx = state.indexCache.get(lawId);
    for (const m of list) {
      const entry = idx && idx.find(e => e.anchor === m.anchor);
      const d = document.createElement('div');
      d.className = 'r';
      d.innerHTML = '<div class="sub">'
        // 下線は色を敷かない印なので、var(--mk-ul) は無い。見本も下線で示す
        + (m.color === 'ul'
          ? '<span class="sw ul" style="display:inline-block;width:10px;height:10px;vertical-align:-1px;margin-right:6px"></span>'
          : m.color ? `<span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--mk-${m.color});vertical-align:-1px;margin-right:6px"></span>` : '')
        + esc(anchorLabel(m.anchor))
        + (m.kind === 'range' ? '　<span style="color:var(--fg-faint)">文言</span>' : '')
        + (m.kind === 'slash' ? `　<span style="color:var(--ink);font-weight:700">${esc(m.slash)}</span>` : '')
        + '</div>'
        // 文言に付けたものは、その文言そのものを出す。条文の頭だけでは見分けられない。
        + (m.phrase ? `<div class="snippet">「${esc(m.phrase.slice(0, 60))}」</div>`
          : entry ? `<div class="snippet">${esc(entry.text.slice(0, 110))}</div>` : '')
        + (m.memo ? `<div class="snippet" style="color:var(--fg-dim)">📝 ${esc(m.memo.slice(0, 80))}</div>` : '');
      /*
       * 押したものをそのまま開く。
       *
       * navigate は選ぶだけ（edit:false）なので、一覧から辿っても注釈欄が
       * 開かなかった。本文が取っ手でない場所（項が1つの条の第1項など）だと、
       * 開く道がどこにも無くなる。押したのだから開くのが素直でもある。
       */
      d.onclick = async () => {
        $('#dlg-find').close();
        await navigate(m.lawId, m.anchor);
        if (m.kind === 'note') { await selectAnchor(m.anchor, true); return; }
        // 文言に付けたものは、その印のパネルを開く（条項号の注釈欄とは別）
        const rec = state.ranges.get(m.id);
        if (rec && !isSlash(rec)) openRangePopover(rec);
      };
      box.appendChild(d);
    }
  }
}


/* ============================================================
 * 【仮】認証の往復を試すだけの仕掛け。同期そのものではない。
 *
 * 確かめたいのは1つ。**ホーム画面から起動した iPhone で、Google へ行って
 * 戻ってきたとき、元の保存領域（注釈のある IndexedDB）に帰ってくるか。**
 *
 * Safari でトークンが取れただけでは合格にしない。WebKit はホーム画面アプリの
 * データを Safari から分けているので、「取れたが別の入れ物だった」があり得る。
 * だから出発前に IndexedDB に印を置き、帰ってから読めるかを見る。
 *
 * 使い方   URL の末尾に ?auth=1 を付けて開く。ボタンが出る。
 * 片付け   確かめ終わったら、この節と init() の呼び出しを消す。
 *
 * トークンそのものは記録も表示もしない。長さと有効期限だけ出す。
 * ============================================================ */

const AP_CLIENT_ID = '866936668538-nclss2rol3u90rs0ujk2rg6a97u7kddc.apps.googleusercontent.com';
const AP_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AP_REDIRECT = location.origin + location.pathname;
const AP_MARK = 'roppo.ap.mark';
const AP_HINT = 'roppo.ap.hint';

/*
 * どのアカウントで認証するか。
 *
 * Google に複数ログインしていると、prompt=none では「どれか決められない」と
 * 言われて interaction_required が返る。login_hint でアカウントを指定すると
 * 決まるので、無画面での取り直しが通ることがある。
 * 値はこの端末の localStorage にだけ置く。どこへも送らない（Google を除く）。
 */
function apHint() {
  try { return localStorage.getItem(AP_HINT) || ''; } catch (e) { return ''; }
}

let apToken = null;            // メモリだけ。localStorage には置かない

const apLog = [];
function apSay(s) {
  apLog.push(s);
  try { sessionStorage.setItem('roppo.ap.log', JSON.stringify(apLog.slice(-60))); }
  catch (e) { /* 無くても画面には出る */ }
  const box = $('#ap-log');
  if (box) box.textContent = apLog.join('\n');
}

function apRand() {
  const a = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function apMode() {
  const mm = window.matchMedia;
  const standalone = (mm && mm('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
  return standalone ? 'standalone（ホーム画面から起動）' : 'ブラウザのタブ';
}

/** 認可の入口へ飛ぶ。ポップアップではなく、この画面ごと移る。 */
async function apGo(silent) {
  const state = apRand();
  const mark = apRand();
  try {
    sessionStorage.setItem('roppo.ap.state', state);
    sessionStorage.setItem('roppo.ap.silent', silent ? '1' : '0');
    sessionStorage.setItem('roppo.ap.t0', String(Date.now()));
  } catch (e) { apSay('sessionStorage に書けない: ' + e.message); }
  try {
    await store.putMeta(AP_MARK, mark);
    sessionStorage.setItem('roppo.ap.markCopy', mark);
    apSay('IndexedDB に印を置いた');
  } catch (e) { apSay('IndexedDB に印を置けない: ' + e.message); }

  const u = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + encodeURIComponent(AP_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(AP_REDIRECT)
    + '&response_type=token'
    + '&scope=' + encodeURIComponent(AP_SCOPE)
    + '&state=' + encodeURIComponent(state)
    + '&include_granted_scopes=true'
    + (apHint() ? '&login_hint=' + encodeURIComponent(apHint()) : '')
    + (silent ? '&prompt=none' : '');
  if (apHint()) apSay('アカウントを指定する: ' + apHint());
  apSay((silent ? '無画面で' : '') + '出発する: ' + AP_REDIRECT);
  location.href = u;
}

/** 帰ってきたところ。フラグメントを読んで、すぐ消す。 */
async function apReturned(frag) {
  const q = new URLSearchParams(frag.replace(/^#/, ''));
  const silent = (() => { try { return sessionStorage.getItem('roppo.ap.silent') === '1'; }
    catch (e) { return false; } })();
  const t0 = (() => { try { return Number(sessionStorage.getItem('roppo.ap.t0') || 0); }
    catch (e) { return 0; } })();

  // 記録に残らないよう、まず消す
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 任意 */ }

  apSay('---- 帰ってきた ----');
  apSay('いまの起動の形: ' + apMode());
  if (t0) apSay('往復にかかった時間: ' + (Date.now() - t0) + ' ミリ秒');

  if (q.get('error')) {
    apSay('Google が断った: ' + q.get('error')
      + (silent ? '（無画面での取り直しなので、同意が必要という意味かもしれない）' : ''));
  }

  let want = null;
  try { want = sessionStorage.getItem('roppo.ap.state'); } catch (e) { /* 下で出る */ }
  apSay('sessionStorage は生きているか: ' + (want ? 'はい' : 'いいえ（別の入れ物に来た疑い）'));
  const got = q.get('state');
  if (want && got) apSay('state が一致するか: ' + (want === got ? 'はい' : 'いいえ'));

  // ここが本題。注釈のある IndexedDB に戻れたか
  try {
    const rec = await store.getMeta(AP_MARK);
    const copy = sessionStorage.getItem('roppo.ap.markCopy');
    apSay('IndexedDB の印を読めたか: ' + (rec ? 'はい' : 'いいえ'));
    if (rec) apSay('印が出発前と同じか: ' + (rec.value === copy ? 'はい' : 'いいえ'));
  } catch (e) { apSay('IndexedDB を読めない: ' + e.message); }
  try {
    const notes = await store.allNotes();
    apSay('注釈の件数: ' + notes.length + '（0 なら別の入れ物の疑い）');
  } catch (e) { apSay('注釈を読めない: ' + e.message); }

  const tok = q.get('access_token');
  if (!tok) { apSay('トークンは来なかった'); return; }
  apToken = tok;
  apSay('トークンが来た（長さ ' + tok.length + '、有効期限 ' + q.get('expires_in') + '秒）');
  apSay('与えられた権限: ' + (q.get('scope') || '（返ってこない）'));
  await apCallDrive();
}

/** トークンが本当に使えるか、Drive を1回叩いて確かめる。 */
async function apCallDrive() {
  if (!apToken) { apSay('トークンが無い'); return; }
  try {
    const r = await fetch('https://www.googleapis.com/drive/v3/files'
      + '?spaces=appDataFolder&pageSize=10&fields=files(id,name,modifiedTime)',
      { headers: { Authorization: 'Bearer ' + apToken } });
    apSay('Drive の返事: ' + r.status);
    const d = await r.json().catch(() => null);
    if (r.ok) apSay('appDataFolder のファイル数: ' + ((d && d.files) ? d.files.length : '?'));
    else apSay('Drive が断った: ' + JSON.stringify(d && d.error ? d.error.message : d).slice(0, 160));
  } catch (e) {
    apSay('Drive を叩けない（CORS か通信）: ' + e.message);
  }
}

/** もう一つの道。Google のスクリプトを読んでポップアップを開く。 */
function apGis() {
  apSay('GIS のスクリプトを読み込む…');
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.onerror = () => apSay('GIS のスクリプトを読めない');
  s.onload = () => {
    apSay('読めた。下の「ポップアップで試す」が押せる');
    const b = $('#ap-gis-go');
    if (b) b.disabled = false;
  };
  document.head.appendChild(s);
}

function apGisGo() {
  /*
   * 押した直後に呼ぶ。読み込みを待ってから呼ぶと、利用者の操作として
   * 扱われずポップアップが塞がれることがある（Codex の指摘）。
   */
  try {
    const g = window.google && window.google.accounts && window.google.accounts.oauth2;
    if (!g) { apSay('GIS がまだ無い'); return; }
    const client = g.initTokenClient({
      client_id: AP_CLIENT_ID,
      scope: AP_SCOPE,
      callback: async res => {
        apSay('GIS の返事: ' + (res && res.access_token
          ? 'トークンが来た（長さ ' + res.access_token.length + '）' : JSON.stringify(res).slice(0, 120)));
        if (res && res.access_token) { apToken = res.access_token; await apCallDrive(); }
      },
      error_callback: err => apSay('GIS の失敗: ' + (err && err.type ? err.type : JSON.stringify(err))),
    });
    apSay('ポップアップを要求する（' + apMode() + '）');
    client.requestAccessToken();
    setTimeout(() => apSay('※5秒たっても何も来なければ、ポップアップが出ていない'), 5000);
  } catch (e) { apSay('GIS で例外: ' + e.message); }
}

function apPanel() {
  const d = document.createElement('div');
  d.id = 'ap-panel';
  /*
   * 全画面で覆うと「新しい版があります」の知らせが裏に隠れて押せなくなる。
   * 実際にそうなった。上を少し空けて、下からせり上がる形にする。
   */
  d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;top:54px;z-index:60;'
    + 'background:var(--bg,#fff);color:var(--fg,#111);font:13px/1.7 system-ui;'
    + 'padding:14px;overflow:auto;border-top:1px solid var(--line,#ccc)';
  d.innerHTML = '<h2 style="margin:0 0 8px;font-size:15px">認証の往復を試す（仮）</h2>'
    + '<p style="margin:0 0 10px;color:#666">いまの起動の形: <b>' + esc(apMode()) + '</b><br>'
    + '戻り先: <code>' + esc(AP_REDIRECT) + '</code></p>'
    + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">'
    + '<button id="ap-go" class="primary">画面遷移で試す</button>'
    + '<button id="ap-go2" class="mini">もう一度（同意が省かれるか）</button>'
    + '<button id="ap-silent" class="mini">無画面で取り直す</button>'
    + '<button id="ap-drive" class="mini">Drive を叩く</button>'
    + '<button id="ap-gis" class="mini">GIS を読む</button>'
    + '<button id="ap-gis-go" class="mini" disabled>ポップアップで試す</button>'
    + '<button id="ap-close" class="mini">閉じる</button></div>'
    + '<p style="margin:0 0 10px">Google のアカウント（複数ログインしているとき）:<br>'
    + '<input id="ap-hint" type="email" placeholder="Google のアカウント" '
    + 'style="width:min(100%,320px);padding:6px;border:1px solid #ccc;border-radius:6px" '
    + 'value="' + esc(apHint()) + '"> '
    + '<button id="ap-hint-save" class="mini">覚える</button></p>'
    + '<pre id="ap-log" style="white-space:pre-wrap;word-break:break-all;'
    + 'background:rgba(0,0,0,.05);padding:10px;border-radius:8px;margin:0"></pre>';
  document.body.appendChild(d);
  $('#ap-go').onclick = () => apGo(false);
  $('#ap-go2').onclick = () => apGo(false);
  $('#ap-hint-save').onclick = () => {
    const v = ($('#ap-hint').value || '').trim();
    try { localStorage.setItem(AP_HINT, v); } catch (e) { /* 無くても動く */ }
    apSay(v ? 'アカウントを覚えた: ' + v : 'アカウントの指定を外した');
  };
  $('#ap-silent').onclick = () => apGo(true);
  $('#ap-drive').onclick = () => apCallDrive();
  $('#ap-gis').onclick = () => apGis();
  $('#ap-gis-go').onclick = () => apGisGo();
  $('#ap-close').onclick = () => d.remove();

  try {
    const old = JSON.parse(sessionStorage.getItem('roppo.ap.log') || '[]');
    for (const l of old) apLog.push(l);
  } catch (e) { /* 無くてよい */ }
  apSay('用意できた');
}

/*
 * 表示設定の中に入口を置く。
 *
 * manifest の start_url が './' なので、?auth=1 を付けてホーム画面に追加しても
 * その印は消える。アイコンから起動すると普通のアプリが出る。しかし
 * 確かめたいのは「ホーム画面から起動した状態」での往復なので、そこから
 * 実証画面へ行けないと意味がない。同じ場所への移動なので standalone のまま。
 */
function apAddEntry() {
  const host = $('#viewpad') || document.body;
  if (!host || $('#ap-entry')) return;
  const b = document.createElement('button');
  b.id = 'ap-entry';
  b.className = 'mini';
  b.textContent = '認証の往復を試す（仮）';
  b.style.cssText = 'margin-top:14px;opacity:.7';
  b.onclick = () => { location.href = location.pathname + '?auth=1'; };
  host.appendChild(b);
}

/** 起動のときに呼ぶ。?auth=1 が付いているか、Google から帰ってきたときだけ出す。 */
async function authProbe() {
  apAddEntry();          // 【仮】確かめ終わったら、この節ごと消す
  const frag = location.hash || '';
  const back = /[#&](access_token|error)=/.test(frag);
  const asked = /[?&]auth=1/.test(location.search);
  if (!back && !asked) return;
  apPanel();
  if (back) await apReturned(frag);
}



/* ------------------------------------------------- 同期：Google の認可 */

/*
 * トークンを取る。画面ごと Google へ移り、戻ってくる。
 *
 * なぜポップアップを使わないか。iPhone でホーム画面から起動していると、
 * ポップアップが表示されずに待ち続けることがある。画面遷移なら、その形でも
 * 元の保存領域に戻れることを実機で確かめた。
 *
 * なぜ Google のスクリプトを読まないか。実行時の依存を増やさないため。
 * 読むのは同期のときだけ、とすることもできるが、遷移で足りるなら要らない。
 *
 * トークンはメモリにだけ置く。localStorage には書かない。1時間で切れるので、
 * 切れたら取り直す。往復の途中であることは sessionStorage に印で残す。
 */
const G_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const G_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const G_CLIENT_ID = AP_CLIENT_ID;          // 実証で使ったものと同じ
const G_STATE = 'roppo.g.state';
const G_RESUME = 'roppo.g.resume';
const G_ACCOUNT = 'roppo.g.account';

let gToken = null;         // { value, expiresAt }

const gRedirect = () => location.origin + location.pathname;

function gAlive() {
  return !!(gToken && gToken.value && gToken.expiresAt > Date.now() + 30000);
}

/** どのアカウントを使うか。複数ログインしていると、指定しないと決まらない。 */
function gAccount() {
  try { return localStorage.getItem(G_ACCOUNT) || ''; } catch (e) { return ''; }
}
function setGAccount(v) {
  try { localStorage.setItem(G_ACCOUNT, String(v || '').trim()); } catch (e) { /* 任意 */ }
}

/** 画面ごと Google へ移る。戻ってきたら resumeAfterAuth が受ける。 */
function gGo(resume) {
  const st = newDeviceId();
  try {
    sessionStorage.setItem(G_STATE, st);
    sessionStorage.setItem(G_RESUME, resume || '');
  } catch (e) { /* 戻ってから state を確かめられないだけ */ }
  location.href = G_AUTH
    + '?client_id=' + encodeURIComponent(G_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(gRedirect())
    + '&response_type=token'
    + '&scope=' + encodeURIComponent(G_SCOPE)
    + '&state=' + encodeURIComponent(st)
    + '&include_granted_scopes=true'
    + (gAccount() ? '&login_hint=' + encodeURIComponent(gAccount()) : '');
}

/*
 * 戻ってきたところ。起動のいちばん早いところで呼ぶ。
 * フラグメントは読んだらすぐ消す。履歴やログにトークンを残さない。
 */
function takeAuthFragment() {
  const frag = location.hash || '';
  if (!/[#&](access_token|error)=/.test(frag)) return null;
  const q = new URLSearchParams(frag.replace(/^#/, ''));
  try { history.replaceState(null, '', location.pathname + location.search); }
  catch (e) { /* 消せなくても読み込みは進む */ }

  let want = '';
  try { want = sessionStorage.getItem(G_STATE) || ''; } catch (e) { /* 下で弾く */ }
  try { sessionStorage.removeItem(G_STATE); } catch (e) { /* 任意 */ }

  const err = q.get('error');
  if (err) return { ok: false, why: err };
  // 送った印と一致しない返事は受け取らない（すり替え対策）
  if (!want || q.get('state') !== want) return { ok: false, why: 'state が合わない' };

  const tok = q.get('access_token');
  const sec = Number(q.get('expires_in') || 0);
  if (!tok) return { ok: false, why: 'トークンが来なかった' };
  gToken = { value: tok, expiresAt: Date.now() + Math.max(60, sec) * 1000 };
  return { ok: true, why: '' };
}

/** 同期の途中で飛んだのか。戻ってきたときに見る。 */
function takeResume() {
  let v = '';
  try { v = sessionStorage.getItem(G_RESUME) || ''; } catch (e) { /* 無ければ空 */ }
  try { sessionStorage.removeItem(G_RESUME); } catch (e) { /* 任意 */ }
  return v;
}


/* ------------------------------------------------- 同期：Drive の通信先 */

/*
 * Drive の appDataFolder に置く。アプリ専用の隠し場所で、Drive の画面には
 * 出ない。ほかのファイルには一切触らない（スコープが drive.appdata だけ）。
 *
 * ファイル名に発行元と世代を入れる。一覧だけで「どの端末の何世代目か」が
 * 分かるので、中身を読まずに済む。
 *
 *   roppo-<writerId>-<generation>.json
 *
 * 名前は一意ではない（同じ名前のものが作れてしまう）ので、名前だけを頼りに
 * しない。中身にも writerId と generation を入れてあり、読んだ方を正とする。
 */
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SNAP_RE = /^roppo-([A-Za-z0-9_-]+)-(\d+)\.json$/;

function driveRemote() {
  const auth = () => {
    if (!gAlive()) throw new Error('認可が切れています');
    return { Authorization: 'Bearer ' + gToken.value };
  };
  const check = async r => {
    if (r.ok) return r;
    let msg = 'HTTP ' + r.status;
    try {
      const d = await r.json();
      if (d && d.error && d.error.message) msg = d.error.message;
    } catch (e) { /* 本文が読めないときは番号だけ */ }
    if (r.status === 401 || r.status === 403) gToken = null;   // 取り直させる
    throw new Error(msg);
  };

  return {
    /*
     * 置いてあるものの一覧。
     * ページが短いことを終わりの合図にしない。nextPageToken を最後まで辿る。
     */
    async listSnapshots() {
      const out = [];
      let page = '';
      for (let i = 0; i < 50; i++) {        // 念のための上限
        const u = DRIVE_API + '?spaces=appDataFolder&pageSize=100'
          + '&fields=nextPageToken,files(id,name,modifiedTime)'
          + (page ? '&pageToken=' + encodeURIComponent(page) : '');
        const r = await check(await fetch(u, { headers: auth() }));
        const d = await r.json();
        for (const f of (d.files || [])) {
          const m = SNAP_RE.exec(f.name || '');
          if (!m) continue;
          out.push({ id: f.id, name: f.name, writerId: m[1],
            generation: Number(m[2]), modifiedTime: f.modifiedTime });
        }
        page = d.nextPageToken || '';
        if (!page) break;
      }
      return out;
    },

    async readSnapshot(id) {
      const r = await check(await fetch(
        DRIVE_API + '/' + encodeURIComponent(id) + '?alt=media', { headers: auth() }));
      const text = await r.text();
      try { return JSON.parse(text); }
      catch (e) { throw new Error('JSON として読めません'); }
    },

    /*
     * 新しいファイルとして置く。既にあるものは書き換えない。
     * 途中で失敗しても、前の世代がそのまま残る。
     */
    async createSnapshot(snap) {
      const name = 'roppo-' + snap.writerId + '-' + snap.generation + '.json';
      const bound = 'b' + newDeviceId();
      const meta = { name, parents: ['appDataFolder'], mimeType: 'application/json' };
      const body = '--' + bound + '\r\n'
        + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
        + JSON.stringify(meta) + '\r\n'
        + '--' + bound + '\r\n'
        + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
        + JSON.stringify(snap) + '\r\n'
        + '--' + bound + '--';
      const r = await check(await fetch(
        DRIVE_UPLOAD + '?uploadType=multipart&fields=id,name',
        { method: 'POST',
          headers: { ...auth(), 'Content-Type': 'multipart/related; boundary=' + bound },
          body }));
      return await r.json();
    },

    /** 古い世代を片付ける。自分の最新2つだけ残す。他の端末のものは触らない。 */
    async sweep(writerId, keep) {
      const list = await this.listSnapshots();
      const mine = list.filter(f => f.writerId === writerId)
        .sort((a, b) => b.generation - a.generation);
      const drop = mine.slice(Math.max(1, keep || 2));
      for (const f of drop) {
        try {
          await fetch(DRIVE_API + '/' + encodeURIComponent(f.id),
            { method: 'DELETE', headers: auth() });
        } catch (e) { /* 消せなくても害はない。次に片付く */ }
      }
      return drop.length;
    },
  };
}

/* ----------------------------------------------------- 同期：手順 */

/*
 * 同期の段取り。通信先（remote）は外から渡す。
 *
 * remote は3つだけ持つ。Drive でも、試験の偽物でも、同じ形にする。
 *   listSnapshots()        置いてあるものの一覧（{id, writerId, generation}）
 *   readSnapshot(id)       中身を1つ読む
 *   createSnapshot(snap)   新しく1つ置く（既にあるものは書き換えない）
 *
 * 段取り
 *   1. 書きかけを確定する。保存できていないなら進まない
 *   2. 一覧を取り、他の端末のものを最後まで読んで検める
 *   3. その時点のDBを読み直してマージし、一度のトランザクションで反映する
 *   4. 自分の塊を作り、世代番号を1つ進めて置く
 *   5. 置けたら、その世代を確認済みにする
 *
 * 通信をトランザクションの中で待たない。取得と検証は先に済ませる。
 * DBに入れてから置くのに失敗しても、同じ状態からやり直せる。
 */
async function syncOnce(remote, opts) {
  const o = opts || {};
  const say = o.onStep || (() => {});
  const out = { ok: false, why: '', read: 0, skipped: [], conflicts: 0, published: false };

  // 1. 書きかけを確定する
  await flushSave();
  if (!savesAreClean()) {
    out.why = '保存できていないものが ' + unsavedCount() + '件あります';
    return out;
  }
  say('置いてあるものを調べる');

  // 2. 一覧を取り、他の端末のものを読む
  let list;
  try { list = await remote.listSnapshots(); }
  catch (e) { out.why = '一覧を取れません: ' + (e && e.message ? e.message : e); return out; }
  if (!Array.isArray(list)) { out.why = '一覧の形が違います'; return out; }

  const datasetId = await loadDatasetId();
  // 端末ごとに、いちばん新しい世代だけ読む
  const newest = new Map();
  for (const f of list) {
    if (!f || typeof f.writerId !== 'string') continue;
    if (f.writerId === deviceId) continue;          // 自分のものは読まない
    const cur = newest.get(f.writerId);
    if (!cur || Number(f.generation || 0) > Number(cur.generation || 0)) newest.set(f.writerId, f);
  }

  const incoming = [];
  for (const f of newest.values()) {
    let raw;
    try { raw = await remote.readSnapshot(f.id); }
    catch (e) {
      // 読めないものがあったら止める。空として扱うと、こちらの墓石が相手を消す
      out.why = '読めないものがあります（' + f.writerId + '）: '
        + (e && e.message ? e.message : e);
      return out;
    }
    const v = validateSnapshot(raw);
    if (!v.ok) { out.why = '中身が読めません（' + f.writerId + '）: ' + v.why; return out; }
    if (v.snapshot.datasetId && datasetId && v.snapshot.datasetId !== datasetId) {
      out.skipped.push(f.writerId);                  // 別のかたまり。混ぜない
      continue;
    }
    incoming.push(v.snapshot);
    out.read++;
  }
  say(out.read + '件を読んだ');

  // 3. いまのDBを読み直してマージする
  const mine = buildSnapshot({
    notes: await store.allNotes(),
    ranges: await store.allRanges(),
    order: lawOrderRec,
    datasetId, writerId: deviceId, generation: 0,
  });
  let merged = mine.records;
  for (const s of incoming) merged = mergeSnapshots({ records: merged }, s);
  out.conflicts = merged.notes.filter(hasConflict).length
    + merged.ranges.filter(hasConflict).length;

  try {
    await store.applyBulk({
      notes: merged.notes,
      ranges: merged.ranges,
      lawOrder: merged.lawOrder.ids,
      meta: { [LAW_ORDER_KEY]: merged.lawOrder },
    });
  } catch (e) {
    out.why = '取り込めません（何も変えていません）: ' + (e && e.message ? e.message : e);
    return out;
  }
  lawOrderRec = merged.lawOrder;
  lawOrder = merged.lawOrder.ids;
  await loadNotes();
  await loadRanges();
  await refreshLawList();
  say('取り込んだ');

  // 4. 自分の塊を置く
  let gen = 0;
  try {
    const rec = await store.getMeta(GENERATION_KEY);
    gen = Number((rec && rec.value) || 0);
  } catch (e) { /* 0 から */ }
  gen += 1;
  const snap = buildSnapshot({
    notes: merged.notes, ranges: merged.ranges, order: merged.lawOrder,
    datasetId, writerId: deviceId, generation: gen,
  });
  try {
    await remote.createSnapshot(snap);
  } catch (e) {
    // 取り込みは済んでいる。置けなかっただけなので、次に同じ状態から出し直す
    out.why = '取り込みましたが、置けませんでした: ' + (e && e.message ? e.message : e);
    return out;
  }
  // 5. 置けた世代だけを確認済みにする
  try {
    await store.putMeta(GENERATION_KEY, gen);
    const seen = {};
    for (const s of incoming) seen[s.writerId] = s.generation;
    await store.putMeta(LAST_SEEN_KEY, seen);
    await store.putMeta(LAST_SYNC_KEY, Date.now());
  } catch (e) { /* 記録できなくても、次の同期でやり直せる */ }

  out.ok = true;
  out.published = true;
  say('置いた（世代 ' + gen + '）');
  return out;
}

/** 同期の結果を一言にする。 */
function syncSummary(r) {
  if (!r.ok) return r.why || '同期できませんでした';
  const parts = ['同期しました'];
  if (r.read) parts.push('他の端末 ' + r.read + '件を取り込み');
  if (r.conflicts) parts.push('別々に直したものが ' + r.conflicts + '件（両方残しました）');
  if (r.skipped.length) parts.push('別のかたまり ' + r.skipped.length + '件は混ぜていません');
  return parts.join('　/　');
}


/* ----------------------------------------------------- 同期：入口 */

/*
 * 同期の入口。押したときにトークンが無ければ、画面ごと Google へ移る。
 * 戻ってきたら resumeSync が受けて、そのまま続きをやる。押すのは一度でよい。
 *
 * オフラインでは何も起きないので、そう言う。読むのは今までどおりできる。
 */
let syncing = false;

async function doSync() {
  if (syncing) return;
  if (!navigator.onLine) { toast('通信できません。読むのはこのまま続けられます'); return; }

  if (!gAlive()) {
    // 取りに行く。戻ってきたら resumeSync が続きをやる
    toast('Google に接続します…');
    gGo('sync');
    return;
  }
  await runSync();
}

async function runSync() {
  if (syncing) return;
  syncing = true;
  setSyncState('同期しています…');
  try {
    const r = await syncOnce(driveRemote(), { onStep: s => setSyncState(s) });
    toast(syncSummary(r));
    if (r.ok) {
      // 置けたら古い世代を片付ける。失敗しても害はない
      try { await driveRemote().sweep(deviceId, 2); } catch (e) { /* 次に片付く */ }
    }
  } catch (e) {
    toast('同期できませんでした: ' + (e && e.message ? e.message : e));
  } finally {
    syncing = false;
    await showLastSync();
  }
}

/** 戻ってきたときに呼ぶ。同期の途中で飛んだなら、そのまま続ける。 */
async function resumeSync() {
  const got = takeAuthFragment();
  const resume = takeResume();
  if (!got) return;
  if (!got.ok) {
    toast('Google に接続できませんでした: ' + got.why
      + (got.why === 'access_denied' ? '（許可が必要です）' : ''));
    return;
  }
  if (resume === 'sync') await runSync();
  else toast('Google に接続しました');
}

function setSyncState(s) {
  const el = $('#sync-state');
  if (el) el.textContent = s || '';
}

/** 「最後に同期: …」を出す。 */
async function showLastSync() {
  const el = $('#sync-state');
  if (!el) return;
  let at = 0;
  try {
    const rec = await store.getMeta(LAST_SYNC_KEY);
    at = Number((rec && rec.value) || 0);
  } catch (e) { /* 出さないだけ */ }
  if (!at) { el.textContent = 'まだ同期していません'; return; }
  const min = Math.floor((Date.now() - at) / 60000);
  el.textContent = '最後に同期: '
    + (min < 1 ? 'たった今' : min < 60 ? min + '分前'
      : min < 60 * 24 ? Math.floor(min / 60) + '時間前'
      : new Date(at).toLocaleString('ja-JP'));
}

/* --------------------------------------------- 条の注釈を第1項へ移す */

/*
 * 一度だけの移し替え。条の単位に付いた注釈を、第1項に付け直す。
 *
 * 以前は条番号を押すと「条」が選ばれたので、条の単位（M/709 のように項の
 * 付かない住所）に注釈が付いていた。いまは条番号を押すと第1項が選ばれる。
 * すると古い注釈は、本文に出ているのに押しても開けない。前メモだけが条見出しの
 * 直後、つまり条文番号の行より上に残る。
 *
 * 一度きりの話なので、そのために機能を足さず、起動時に一度だけ移す。
 *
 * 気をつけること
 *   ・移した先に注釈が既にあるものは触らない。勝手に混ぜない
 *   ・消すのではなく墓石を残す。消しただけだと古いバックアップから復活する
 *   ・住所の形が条に見えないもの（M/前文・別表・範囲）は触らない
 *   ・移したかどうかを meta に記録して、二度走らせない
 *   ・全部を一度のトランザクションで書く。半分だけ移った状態を残さない
 *
 * 取り消したいときはバックアップから戻す。移す前に書き出しておくのが安全。
 */
const MOVED_KEY = 'roppo.movedArticleNotes';

/** 条の単位の住所か（M/709 のように、条番号までで止まっているか）。 */
function isArticleAnchor(anchor) {
  const parts = String(anchor || '').split('/');
  if (parts.length !== 2) return false;
  // 枝番（398_2）と範囲（170:174）は条である。前文・別表は違う
  return /^\d+(_\d+)*(:\d+)?$/.test(parts[1]);
}

/** 移す対象を選ぶ。DBも時計も触らない（試験しやすくするため）。 */
function planArticleNoteMove(all, now) {
  const byKey = new Map(all.map(n => [n.key, n]));
  const move = [], skip = [];
  for (const n of all) {
    if (isTomb(n)) continue;
    if (!isArticleAnchor(n.anchor)) continue;
    const to = n.anchor + '/1';
    const toKey = (n.lawId || '') + ':' + to;
    const there = byKey.get(toKey);
    if (there && !isTomb(there)) { skip.push(n); continue; }   // 重なる。触らない
    move.push({ from: n, toKey, to });
  }
  const notes = [];
  for (const m of move) {
    notes.push({ ...m.from, key: m.toKey, anchor: m.to, updatedAt: now });
    notes.push(noteTomb(m.from, now));
  }
  return { notes, moved: move.length, skipped: skip.length, skip };
}

/** 起動時に一度だけ。移したら件数を知らせる。 */
async function moveArticleNotesOnce() {
  let done = null;
  try { done = await store.getMeta(MOVED_KEY); } catch (e) { return; }
  if (done && done.value) return;

  let all;
  try { all = await store.allNotes(); } catch (e) { return; }
  const plan = planArticleNoteMove(all, Date.now());

  try {
    await store.applyBulk({ notes: plan.notes, meta: { [MOVED_KEY]: true } });
  } catch (err) {
    // 書けなければ印も付けない。次の起動でやり直す
    toast('条の注釈を移せませんでした: ' + err.message);
    return;
  }
  if (!plan.moved && !plan.skipped) return;          // 何も無ければ黙っている
  await loadNotes();
  toast('条に付いていた注釈 ' + plan.moved + '件を第1項へ移しました'
    + (plan.skipped ? '（第1項に既にあった ' + plan.skipped + '件はそのまま）' : ''));
}


/* ------------------------------------------------- 同期：運ぶ形と検証 */

/*
 * 同期で置くファイルの形。バックアップの形とは分ける。
 *
 *   端末ごとに全量を1つ置く。他の端末のファイルは読むだけで、書き換えない。
 *   共有の1ファイルを皆で上書きすると、別々のレコードを直しただけで
 *   片方の変更が消える。
 *
 *   {
 *     format: 'roppo-sync',
 *     schemaVersion: 1,     この JSON の読み方
 *     datasetId: '...',     別の同期のかたまりを混ぜないための印
 *     writerId: '...',      どの端末が出したか（＝端末ID）
 *     generation: 12,       その端末が何回目に出したか。時計を使わずに順を決める
 *     records: { notes: [], ranges: [], lawOrder: {...} }
 *   }
 *
 * 墓石も未解決の衝突（alts）も、records にそのまま入れる。入れないと
 * 相手の端末で復活したり、衝突が片方だけ消えたりする。
 */
const SYNC_FORMAT = 'roppo-sync';
const SYNC_SCHEMA = 1;
const DATASET_KEY = 'roppo.datasetId';
const GENERATION_KEY = 'roppo.generation';
const LAST_SEEN_KEY = 'roppo.lastSeen';
const LAST_SYNC_KEY = 'roppo.lastSyncAt';

/** 同期のかたまりの印。最初に同期した端末が作り、以後それに揃える。 */
async function loadDatasetId() {
  try {
    const rec = await store.getMeta(DATASET_KEY);
    if (rec && rec.value) return rec.value;
  } catch (e) { /* 下で作る */ }
  const id = newDeviceId().replace(/^d/, 's');
  try { await store.putMeta(DATASET_KEY, id); } catch (e) { /* 次回また */ }
  return id;
}

/** いま持っているものを、そのまま1つの塊にする。DBは読むだけ。 */
function buildSnapshot({ notes, ranges, order, datasetId, writerId, generation }) {
  return {
    format: SYNC_FORMAT,
    schemaVersion: SYNC_SCHEMA,
    datasetId,
    writerId,
    generation,
    records: {
      notes: notes || [],
      ranges: ranges || [],
      lawOrder: order || { ids: [], updatedAt: 0, version: {} },
    },
  };
}

/*
 * 受け取った塊を検める。読めないものは読まない。
 *
 * JSON として読めるかだけでは足りない。形・版・型・鍵の重なりまで見る。
 * 壊れたものを「空の同期データ」として扱ってはいけない。空と間違えると、
 * こちらの墓石が相手を消しに行く。
 *
 * 返すのは { ok, why, snapshot }。ok が false なら触らない。
 */
function validateSnapshot(o) {
  const no = why => ({ ok: false, why, snapshot: null });
  if (!o || typeof o !== 'object') return no('中身がない');
  if (o.format !== SYNC_FORMAT) return no('別の形式のファイル');
  const sv = Number(o.schemaVersion);
  if (!Number.isFinite(sv) || sv < 1) return no('版が読み取れない');
  if (sv > SYNC_SCHEMA) return no('新しい版（' + sv + '）。このアプリでは読めない');
  if (typeof o.writerId !== 'string' || !o.writerId) return no('発行元が無い');
  const gen = Number(o.generation);
  if (!Number.isFinite(gen) || gen < 0) return no('世代番号が読み取れない');
  const r = o.records;
  if (!r || typeof r !== 'object') return no('records が無い');
  if (!Array.isArray(r.notes) || !Array.isArray(r.ranges)) return no('records の形が違う');

  const seenN = new Set();
  for (const n of r.notes) {
    if (!n || typeof n !== 'object') return no('注釈に中身のないものがある');
    if (typeof n.key !== 'string' || !n.key) return no('鍵の無い注釈がある');
    if (seenN.has(n.key)) return no('同じ鍵の注釈が2つある: ' + n.key);
    seenN.add(n.key);
  }
  const seenR = new Set();
  for (const x of r.ranges) {
    if (!x || typeof x !== 'object') return no('文言注釈に中身のないものがある');
    if (typeof x.id !== 'string' || !x.id) return no('id の無い文言注釈がある');
    if (seenR.has(x.id)) return no('同じ id の文言注釈が2つある: ' + x.id);
    seenR.add(x.id);
  }
  if (r.lawOrder && !Array.isArray(r.lawOrder.ids)) return no('並び順の形が違う');
  return { ok: true, why: '', snapshot: o };
}

/*
 * 2つの塊を1つにする。マージの核を通すだけ。ここに判定を書かない。
 * 左右を入れ替えても同じ結果になる（試験で確かめている）。
 */
function mergeSnapshots(a, b) {
  const ra = (a && a.records) || {};
  const rb = (b && b.records) || {};
  const oa = ra.lawOrder || { ids: [], updatedAt: 0, version: {} };
  const ob = rb.lawOrder || { ids: [], updatedAt: 0, version: {} };
  let order;
  if (!oa.ids.length) order = ob;
  else if (!ob.ids.length) order = oa;
  else {
    const m = mergeRecord({ ...oa, key: 'lawOrder' }, { ...ob, key: 'lawOrder' });
    order = { ids: m.ids || [], updatedAt: m.updatedAt || 0, version: m.version || {} };
  }
  return {
    notes: mergeLists(ra.notes || [], rb.notes || [], r => r.key),
    ranges: mergeLists(ra.ranges || [], rb.ranges || [], r => r.id),
    lawOrder: order,
  };
}

/* ------------------------------------------------------------ 同期：版 */

/*
 * 「どちらの編集が後か」を、時計ではなく版で決める。
 *
 * updatedAt（端末の時計）で新しい方を残す形にしていたが、時計がずれると
 * 古い内容が勝ち続ける。逆に巻き戻れば新しい編集が負ける。個人の端末でも
 * 時計は狂う。
 *
 * 代わりに、レコードごとに「どの端末の何番目の編集を取り込んだか」を持つ。
 *
 *   version: { "pc-xxxx": 4, "iphone-yyyy": 2 }
 *
 * 共通の版 {PC:4, iPhone:2} から別々に編集すると
 *
 *   PC の編集      {PC:5, iPhone:2}
 *   iPhone の編集  {PC:4, iPhone:3}
 *
 * になる。片方がすべての項目で他方以上なら、それが後の編集。互いに大きい
 * 項目があるなら、互いを見ずに編集したということ＝衝突である。
 * 書かれていない項目は 0 とみなす。
 *
 * updatedAt は捨てない。「最終更新」として画面に出すのに使う。
 */

/*
 * この端末の名前。版の項目名になる。
 *
 * インストールごとに1つ作り、meta に置く。バックアップから復元しても
 * 引き継がない（同じ名前の端末が2つになると、版の前後が決められなくなる）。
 * 名前自体に意味は持たせない。誰の端末かも書かない。
 */
const DEVICE_KEY = 'roppo.deviceId';
let deviceId = '';

function newDeviceId() {
  const a = new Uint8Array(8);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return 'd' + [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loadDeviceId() {
  try {
    const rec = await store.getMeta(DEVICE_KEY);
    if (rec && typeof rec.value === 'string' && rec.value) { deviceId = rec.value; return; }
  } catch (e) { /* 下で作る */ }
  deviceId = newDeviceId();
  try { await store.putMeta(DEVICE_KEY, deviceId); } catch (e) { /* 次回また作る */ }
}

/** 版の各項目を読む。無ければ0。 */
const vvAt = (v, id) => Number((v && v[id]) || 0);

/** 版に出てくる端末の名前を全部。並びは決め打ちにする（下の vvKey を見よ）。 */
function vvIds(a, b) {
  return [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
}

/*
 * 版を文字列にする。鍵を並べ替えてから作る。
 *
 * JSON.stringify をそのまま使うと、鍵の順番が入力の順番で決まる。同じ版でも
 * 端末によって別の文字列になり、重複の判定と同順位の決着が端末ごとに
 * 食い違う。同期では「どの端末でも同じ結果」が要るので、ここを揃える。
 * 0 の項目は書かない（無いのと同じ意味なので）。
 */
function vvKey(v) {
  const o = v || {};
  return Object.keys(o).sort()
    .filter(k => Number(o[k]) > 0)
    .map(k => k + ':' + Number(o[k]))
    .join('|');
}

/** a のすべての項目が b 以上か。 */
function vvDominates(a, b) {
  return vvIds(a, b).every(id => vvAt(a, id) >= vvAt(b, id));
}

/**
 * 2つの版の関係。
 *   'same'     同じ
 *   'left'     左が後（左を採る）
 *   'right'    右が後
 *   'conflict' 互いを見ずに編集された
 */
function vvCompare(a, b) {
  const l = vvDominates(a, b);
  const r = vvDominates(b, a);
  if (l && r) return 'same';
  if (l) return 'left';
  if (r) return 'right';
  return 'conflict';
}

/** 両方を見た、という版を作る（項目ごとの大きい方）。 */
function vvMerge(a, b) {
  const out = {};
  for (const id of vvIds(a, b)) {          // vvIds は並べ替えて返す
    const n = Math.max(vvAt(a, id), vvAt(b, id));
    if (n > 0) out[id] = n;
  }
  return out;
}

/** この端末の編集を1つ進めた版を返す。元の版は変えない。 */
function vvBump(v, deviceId) {
  const out = { ...(v || {}) };
  out[deviceId] = vvAt(out, deviceId) + 1;
  return out;
}

/* --------------------------------------------------- 同期：マージの核 */

/*
 * 衝突したとき、片方を捨てない。
 *
 * 表に出すのは1つだけ決める（画面がぶれないように）。もう片方は alts に
 * 積んでおく。alts はレコードの一部なので、同期でもバックアップでも一緒に
 * 運ばれる。利用者が選んだら、両方の版を取り込んだ新しい編集にする。
 *
 * 表に出す側は「時計が新しい方、同じなら端末の名前が小さい方」で決める。
 * 時計を信じているのではなく、どの端末でも同じ結果になるようにするため。
 */
function pickShown(a, b) {
  const ta = Number(a.updatedAt || 0);
  const tb = Number(b.updatedAt || 0);
  if (ta !== tb) return ta > tb ? [a, b] : [b, a];
  const ia = vvKey(a.version);
  const ib = vvKey(b.version);
  return ia <= ib ? [a, b] : [b, a];
}

/** alts を、同じ版のものを重ねずに集める。 */
function collectAlts(...recs) {
  const seen = new Map();
  for (const r of recs) {
    if (!r) continue;
    for (const alt of r.alts || []) {
      const k = vvKey(alt.version);
      if (!seen.has(k)) seen.set(k, alt);
    }
  }
  return [...seen.values()];
}

/** alts のうち、採用したレコードより古いものは落とす。 */
function pruneAlts(alts, chosen) {
  const out = [];
  const seen = new Set();
  for (const alt of alts) {
    if (vvDominates(chosen.version, alt.version)) continue;   // もう解決済み
    const k = vvKey(alt.version);
    if (seen.has(k)) continue;
    seen.add(k);
    const { alts: _drop, ...clean } = alt;                    // alts は入れ子にしない
    out.push(clean);
  }
  return out;
}

/**
 * 同じ鍵の2つのレコードを1つにする。入力は変えない。
 *
 * 版を持たない古いレコード（版を入れる前のバックアップ）も来る。その場合は
 * 昔どおり updatedAt で比べる。因果関係の情報が無いので、それしかできない。
 */
function mergeRecord(left, right) {
  if (!left) return right ? { ...right, alts: pruneAlts(collectAlts(right), right) } : right;
  if (!right) return { ...left, alts: pruneAlts(collectAlts(left), left) };

  /*
   * 版で比べられるのは、**両方が版を持っているとき**だけである。
   *
   * 空の版（{}）は「版が無い」と同じに扱う。持たせただけで中身が無いものを
   * 「版がある」と見ると、昔の物差しに落ちずに 'same' になり、左が無条件に勝つ。
   *
   * 片方だけが版を持つ場合も版では決められない。版を入れる前に作った
   * バックアップには因果関係の情報が無いので、版を持つ手元が常に勝ってしまい、
   * 古いバックアップから戻せなくなる。そのときは時計で決める。
   */
  const hasVv = !!(vvKey(left.version) && vvKey(right.version));
  if (!hasVv) {
    // 版を持たない同士。昔の物差し（時計）で決める。同じなら左を残す
    const [win] = pickShown(left, right);
    return { ...win };
  }

  const rel = vvCompare(left.version, right.version);
  if (rel === 'same' || rel === 'left' || rel === 'right') {
    const base = rel === 'right' ? right : left;
    const other = rel === 'right' ? left : right;
    const alts = pruneAlts(collectAlts(left, right), base);
    const out = { ...base, version: vvMerge(left.version, right.version) };
    if (alts.length) out.alts = alts; else delete out.alts;
    // 'same' でも相手の alts は拾う。片方だけが衝突を抱えていることがある
    void other;
    return out;
  }

  // 衝突。表に出す方を決め、もう片方は alts に積む
  const [shown, hidden] = pickShown(left, right);
  const { alts: _a, ...shownClean } = shown;
  const { alts: _b, ...hiddenClean } = hidden;
  const alts = pruneAlts([hiddenClean, ...collectAlts(left, right)], shownClean);
  return alts.length ? { ...shownClean, alts } : { ...shownClean };
}

/** 衝突を抱えているか（画面に「別の編集があります」と出す判断）。 */
const hasConflict = r => !!(r && r.alts && r.alts.length);

/*
 * 衝突している中身を、一言で見せるための文字。
 *
 * 大きな比較画面は作らない。どちらを採るか決めるには、何が書いてあるかが
 * 見えれば足りる。長いメモは切って、続きがあることだけ分かるようにする。
 */
function noteBrief(r) {
  if (!r) return '';
  if (isTomb(r)) return '（削除）';
  const parts = [];
  if (r.color) {
    const c = MARK_COLORS.find(x => x.key === r.color);
    parts.push('マーク' + (c ? c.label : r.color));
  }
  if ((r.tags || []).length) parts.push('タグ ' + r.tags.join('・'));
  if (String(r.summary || '').trim()) parts.push('前メモ「' + r.summary.trim().slice(0, 30) + '」');
  if (String(r.memo || '').trim()) parts.push('メモ「' + r.memo.trim().slice(0, 40) + '」');
  if (String(r.text || '').trim() && !('key' in r)) parts.unshift('「' + r.text.trim().slice(0, 20) + '」');
  return parts.length ? parts.join('　') : '（空）';
}

/*
 * 「別の編集があります」の箱を組む。条項号の注釈でも文言の注釈でも同じ形。
 *
 * 表に出しているものと、alts に積んである候補を並べ、どれかを選ばせる。
 * 選んだら resolveConflict が両方の版を取り込んだ新しい編集を作るので、
 * 古い候補を後から受け取っても戻らない。
 */
function conflictHtml(rec) {
  if (!hasConflict(rec)) return '';
  const row = (r, i, now) =>
    '<div class="cf-row"><div class="cf-body">'
    + (now ? '<b>いま表に出ているもの</b><br>' : '')
    + esc(noteBrief(r)) + '</div>'
    + '<button type="button" class="mini" data-cf="' + i + '">これを採る</button></div>';
  return '<div class="note-conflict"><div class="cf-head">別の編集があります</div>'
    + '<div class="cf-note">同じところを、別々の端末で直したものです。'
    + 'どちらも消していません。採る方を選んでください。</div>'
    + row(rec, -1, true)
    + (rec.alts || []).map((a, i) => row(a, i, false)).join('')
    + '</div>';
}

/** 「これを採る」を押したときの配線。box の中のボタンを見る。 */
function wireConflict(box, rec, save) {
  for (const b of $$('button[data-cf]', box)) {
    b.onclick = async () => {
      const i = Number(b.dataset.cf);
      const chosen = i < 0 ? rec : (rec.alts || [])[i];
      if (!chosen) return;
      const solved = resolveConflict(rec, chosen, deviceId);
      await save(solved);
      toast('採った方に決めました');
    };
  }
}

/**
 * 鍵ごとに寄せてマージする。入力の配列も要素も変えない。
 * 順番を変えても、何度混ぜても同じ結果になること（試験で確かめている）。
 */
function mergeLists(left, right, keyOf) {
  const out = new Map();
  for (const r of left || []) {
    const k = keyOf(r);
    if (k === undefined || k === null || k === '') continue;
    out.set(k, out.has(k) ? mergeRecord(out.get(k), r) : r);
  }
  for (const r of right || []) {
    const k = keyOf(r);
    if (k === undefined || k === null || k === '') continue;
    out.set(k, out.has(k) ? mergeRecord(out.get(k), r) : r);
  }
  // 片方だけにあったものも、alts の掃除を通す
  for (const [k, r] of out) out.set(k, mergeRecord(r, null));
  return [...out.values()];
}

/** 衝突を解いて1つにする。選んだ内容に、両方の版を取り込んだ新しい編集を作る。 */
function resolveConflict(rec, chosen, deviceId) {
  let v = rec.version || {};
  for (const alt of rec.alts || []) v = vvMerge(v, alt.version);
  const { alts: _drop, ...body } = chosen;
  return { ...body, version: vvBump(v, deviceId) };
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
  /*
   * 書きかけを先に確定させる。
   *
   * メモは500ms遅れて保存される。待たずに書き出すと、いま打った文が
   * 入らないバックアップができる。それを信じて端末を初期化したら失われる。
   */
  await flushSave();
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
    lawOrder,             // 自分で並べた順。端末を変えても残したい
  };
  // 数えて見せるのは生きているものだけ。墓石はファイルには入るが、数には入れない
  const living = livingOnly(notes).length + livingOnly(ranges).length;
  const tombs = notes.length + ranges.length - living;
  download(`roppo-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
  toast(`法令 ${laws.length}件 / 注釈 ${living}件 を書き出しました`
    + (tombs ? `（消した印 ${tombs}件も含む）` : '')
    + (unsavedCount() ? `　※保存できなかったものが ${unsavedCount()}件あります` : ''));
}

/**
 * バックアップから復元する。
 * 注釈は updatedAt が新しい方を残す（古い書き出しで上書きしないため）。
 *
 * 全部を検めてから、一度のトランザクションで書く。以前は1件ずつ別々に
 * 書いていたので、途中で失敗すると半分入った状態が残り、どこまで入ったのかも
 * 分からなかった。注釈は取り返せないので「全部入るか、何も入らないか」にする。
 *
 * 版（version）も見る。知らない版は読まない。部分的に読んで書き戻すと、
 * こちらが知らない項目を消してしまう。
 */
async function importBackup(file) {
  // 書きかけを先に確定させる。手元の新しい内容が「無い」と見なされないように
  await flushSave();

  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { toast('JSONとして読めません'); return; }
  if (data.format !== 'roppo-backup') { toast('このアプリのバックアップではありません'); return; }
  const ver = Number(data.version);
  if (!Number.isFinite(ver) || ver < 1) { toast('版が読み取れません'); return; }
  if (ver > BACKUP_VERSION) {
    toast(`新しい版のバックアップです（版${ver}）。このアプリを更新してください`);
    return;
  }

  /*
   * 比較の相手は IndexedDB を読み直したものにする。
   * state.notes は画面用の写しで、別のタブが書いていると古い。
   */
  const curNotes = await store.allNotes();
  const curRanges = await store.allRanges();
  const curLaws = new Map((await store.allLawMeta()).map(l => [l.lawId, l]));

  let keptNewer = 0;

  const laws = [];
  for (const law of data.laws || []) {
    if (!law.lawId || !law.xml) continue;
    /*
     * 法令XMLは時刻で比べる。本文には版を持たせていない（e-Gov から取り直せる
     * ものなので、編集の前後を追う必要がない）。以前は無条件に上書きしていたので、
     * 古いバックアップを読むと取り込み直した本文が古いものに戻っていた。
     * 取り込んだ規則のように取り直せないものだと、それが実害になる。
     */
    const cur = curLaws.get(law.lawId);
    if (cur && (cur.savedAt || 0) > (law.savedAt || 0)) { keptNewer++; continue; }
    laws.push(law);
  }

  /*
   * 注釈はマージの核に任せる。版があれば版で、無ければ時計で前後を決め、
   * 互いを見ずに編集されたものは両方残す（alts）。
   * ここに判定を書かない。同期でも同じ核を通すので、二重に書くと食い違う。
   */
  const notes = mergeLists(curNotes, data.notes || [], r => r.key);
  const ranges = mergeLists(curRanges, data.ranges || [], r => r.id);
  const conflicts = notes.filter(hasConflict).length + ranges.filter(hasConflict).length;

  /*
   * 並び順も版で比べる。バックアップには配列で入っていることがある
   * （版を入れる前の書き出し）ので、その形も受ける。
   */
  const inOrder = Array.isArray(data.lawOrder)
    ? { ids: data.lawOrder, updatedAt: 0, version: {} }
    : (data.lawOrder && Array.isArray(data.lawOrder.ids) ? data.lawOrder : null);
  let orderRec = null;
  if (inOrder && inOrder.ids.length) {
    const m = mergeRecord({ ...lawOrderRec, key: 'lawOrder' },
      { ...inOrder, key: 'lawOrder' });
    if (m && Array.isArray(m.ids) && m.ids.join() !== lawOrderRec.ids.join()) orderRec = m;
  }
  const order = orderRec ? orderRec.ids : null;

  try {
    await store.applyBulk({ laws, notes, ranges, lawOrder: order });
  } catch (err) {
    toast('復元できませんでした（何も変えていません）: ' + err.message);
    return;
  }

  for (const law of laws) state.indexCache.delete(law.lawId);
  if (orderRec) {
    lawOrderRec = { ids: orderRec.ids, updatedAt: orderRec.updatedAt || 0,
      version: orderRec.version || {} };
    lawOrder = lawOrderRec.ids;
  }
  await loadNotes();
  await loadRanges();
  await refreshLawList();
  if (P().current) await openLaw(P().current.lawId);
  const living = livingOnly(notes).length + livingOnly(ranges).length;
  toast(`法令 ${laws.length}件 / 注釈 ${living}件 を復元`
    + (keptNewer ? `（本文は手元が新しい ${keptNewer}件を残しました）` : '')
    + (conflicts ? `　※別々に直したものが ${conflicts}件あります（両方残しました）` : '')
    + (unsavedCount() ? `　※保存できなかったものが ${unsavedCount()}件あります` : ''));
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
    for (const pane of livePanes()) paintParens(pane);   // 作る／外すはここで
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
  $('#jump-input').onkeydown = e => { if (e.key === 'Enter') doJump(); };
  $('#find-input').onkeydown = e => {
    if (e.key !== 'Enter') return;
    // 同じ語で続けて押したら次の一致へ送る
    if (find.q === $('#find-input').value.trim() && find.results.length) stepFind(e.shiftKey ? -1 : 1);
    else doFind();
  };
  $('#law-filter').oninput = renderLawList;

  for (const b of $$('.tabs button')) b.onclick = () => switchTab(b.dataset.tab);

  $('#mark-sort').addEventListener('click', e => {
    const b = e.target.closest('button[data-sort]');
    if (!b) return;
    for (const x of $$('#mark-sort button')) x.classList.toggle('on', x === b);
    renderMarkResults();
  });

  $('#find-where').addEventListener('click', e => {
    const b = e.target.closest('button[data-where]');
    if (!b) return;
    find.where = b.dataset.where;
    for (const x of $$('#find-where button')) x.classList.toggle('on', x === b);
    syncFindPlaceholder();
    doFind();
  });
  $('#find-in-text').onchange = e => { find.inText = e.target.checked; doFind(); };
  $('#find-in-notes').onchange = e => { find.inNotes = e.target.checked; doFind(); };
  wireKeypad();
  wireLawDrag();
  wireView();

  const openAdd = () => { $('#dlg-add').showModal(); $('#add-query').focus(); };
  $('#btn-add-law').onclick = openAdd;
  document.addEventListener('click', e => {
    if (e.target && e.target.id === 'btn-add-law-2') openAdd();
  });

  $('#btn-sync').onclick = () => doSync();
  $('#sync-account').value = gAccount();
  $('#sync-account-save').onclick = () => {
    setGAccount($('#sync-account').value);
    toast(gAccount() ? 'アカウントを覚えました' : 'アカウントの指定を外しました');
  };

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

  for (const b of $$('#slashbar button')) {
    b.onclick = () => applySlash(b.dataset.slash);
  }

  $('#btn-import-law').onclick = () => $('#import-file').click();
  $('#import-file').onchange = async e => {
    const files = [...(e.target.files || [])];
    e.target.value = '';                       // 同じファイルを選び直せるように
    if (!files.length) return;
    // まとめ取り込みの中で捕まえきれなかったものも、ここで受ける
    let done = [];
    try { ({ done } = await importLawFiles(files)); }
    catch (err) { toast('取り込めませんでした: ' + err.message); return; }
    if (done.length) $('#dlg-add').close();    // 1本も入らなければ開いたままにする
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

    // すでに付いている区切りの印を押した
    const sl = e.target.closest && e.target.closest('span[data-slash-id]');
    if (sl) {
      const rec = state.ranges.get(sl.dataset.slashId);
      slashPending = { id: sl.dataset.slashId };
      showSlashBar(sl.getBoundingClientRect(), rec);
      return;
    }
    hideSlashBar();

    // 文字を選択している最中は編集を開かない（範囲注釈を付けたいだけのことが多い）
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;

    /*
     * 「。」の近くを押したら、区切りの印を出す入口を開く。
     * 本文のそれ以外の場所は、これまでどおり何も起きない。
     */
    const near = sentenceEndNear(e.clientX, e.clientY);
    if (near) {
      // すでに印が付いていれば、その印の編集として開く
      const cur = P().current && existingSlash(P().current.lawId, near.anchor, near.text, near.nth);
      slashPending = cur
        ? { id: cur.id, lawId: P().current.lawId, paneIdx: P().idx }
        : near;
      const r = document.createRange();
      const map = textMapOf(findAnchorEl(near.anchor, pane) || pane.el);
      const seg = map.nodes.find(x => near.at >= x.start && near.at <= x.end);
      if (seg) {
        r.setStart(seg.node, Math.max(0, near.at - seg.start - 1));
        r.setEnd(seg.node, Math.min(seg.node.nodeValue.length, near.at - seg.start));
        showSlashBar(r.getBoundingClientRect(), cur);
        return;
      }
    }

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
      /*
       * 番号を押したら、その番号が属する単位を選ぶ。条番号なら第1項である。
       *
       * 条番号は第1項の本文の頭に置かれている（第1項だけ番号を出さないのが
       * 慣例）。以前はここで .article まで上がって「条」を選んでいたが、
       * それだと第1項を指す取っ手がどこにも無くなる。刑訴280条のように
       * 3項あって、どの項も番号を持たない法令では、第1項に注釈を付けられない。
       *
       * 注釈の単位は項に寄せる。読むときも「280条1項」と引くのであって、
       * 「280条」と「280条1項」を別に印を付けたい場面は、まず無い。
       * 条の単位に付いた古い注釈は、本文には出るし、印とメモの一覧から選べる。
       */
      const host = num.closest('[data-anchor]');
      if (host && host.dataset.anchor) selectAnchor(host.dataset.anchor, true, pane);
      return;
    }

    /*
     * 番号を持たない単位は、本文そのものが取っ手になる。
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
    /*
     * 第1項は条番号が取っ手。本文を押しても同じ第1項が選ばれるので、どちらでも
     * 構わない。取っ手が二つあって困るのは、押す先が違うときだけである。
     * いまはどちらを押しても項が選ばれるので、そのままにしておく。
     */
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
  // 下見そのものを押しても引ける。当たりが出ているときだけ効く。
  const pv = $('#jump-preview');
  pv.onclick = () => { if (pv.classList.contains('go')) doJump(); };
  pv.onkeydown = e => {
    if ((e.key === 'Enter' || e.key === ' ') && pv.classList.contains('go')) {
      e.preventDefault();
      doJump();
    }
  };
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
      switchTab('find');          // 欄は検索タブの中にある
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
  syncFindPlaceholder();
  let sheetTab = 'jump';
  try { sheetTab = localStorage.getItem('roppo.sheetTab') || 'jump'; } catch (e) { /* 任意 */ }
  switchSheetTab(sheetTab);
  placeControls();
  await authProbe();          // 【仮】認証の往復を試す。確かめ終わったら消す
  await resumeSync();         // Google から戻ってきたなら、同期の続きをやる
  await loadDeviceId();
  await loadLawOrder();
  loadAmendState();
  await loadNotes();
  await loadRanges();
  // 条の単位に付いた古い注釈を第1項へ移す（一度だけ。上の注記を見よ）
  await moveArticleNotesOnce();
  await refreshLawList();
  let last = null;
  try { last = localStorage.getItem('roppo.last'); } catch (e) { /* 使えなくても支障ない */ }
  loadLastPos();
  showLastSync();
  const first = (last && state.laws.some(l => l.lawId === last)) ? last
    : (state.laws.length ? state.laws[0].lawId : null);
  if (first) {
    await openLaw(first);
    pushHist({ lawId: first, anchor: null, scrollTop: P().el.scrollTop });
  }
  checkAmendmentsIfStale();     // 通信できるときだけ、1日に1度
  window.addEventListener('pagehide', rememberPos);
})();
