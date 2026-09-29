// More tools: small, deterministic intent classifier. Queries stay in memory;
// no model, network, storage, telemetry or account data is involved.
const TAGS = {
  home: 'dashboard overview balance credits usage activity spending history 仪表盘 概览 余额 积分 用量',
  uncensored: 'uncensored unfiltered unrestricted models 无审查 未审查',
  symposium: 'compare models perspectives consensus answers synthesis debate brainstorm 比较模型 多角度 综合 辩论',
  device: 'offline local private privacy browser download free disconnected 离线 本地 隐私 免费',
  code: 'coding programming developer software debug debugging bug javascript python html css website 编程 代码 调试 网站',
  audio: 'voice speech spoken sound audio transcribe transcription recording podcast tts stt 语音 音频 朗读 转录',
  collab: 'team teamwork collaborate collaboration together shared invite colleagues 团队 协作 共享 邀请',
  tools: 'research search web internet browse facts evidence sources citations verify calculator arithmetic maths mathematics writing 研究 搜索 真相 核实 事实 来源 计算器',
  sheets: 'spreadsheet spreadsheets csv tsv excel data analytics analysis statistics chart graph table 数据 表格 电子表格 图表 分析',
  compare: 'compare documents contracts versions differences changes diff evidence 比较 文档 合同 差异 版本',
  canvas: 'write writing rewrite editing edit draft prose grammar tone shorten expand document 写作 改写 编辑 草稿 语法',
  translate: 'translate translation translating language languages multilingual glossary 翻译 语言 术语',
  study: 'learn learning studying flashcards quiz quizzes revision exam practice remember memorise memorize 学习 复习 记忆 抽认卡 测验 考试',
  slides: 'presentation presentations slides slideshow deck powerpoint pitch 演示 幻灯片 汇报',
  notes: 'meeting meetings recording minutes transcript transcription decisions actions summary 会议 纪要 录音 转录 待办 决策',
  filesearch: 'files saved uploads documents search find ask question passages citations cite sources across contracts notes 文件 搜索 查找 提问 引用 来源 文档 保存',
  routines: 'schedule scheduled recurring automatic automate automation daily weekly monitor watch reminders inbox 定时 自动 每日 每周 监控 提醒',
  projects: 'organise organize organisation organization folder folders files instructions context group 项目 文件夹 整理 指令',
  library: 'saved media creations images pictures photos videos audio history gallery downloads 保存 媒体 图片 视频 作品',
  models: 'model models catalog catalogue providers pricing prices capabilities compare 模型 目录 提供商 价格 能力',
  api: 'api key keys sdk endpoint integration integrate cli developer scripts openai compatible 接口 密钥 集成 开发者 脚本',
};
// Weight likely destinations rather than treating every related tool equally.
// “Truth” suggests ways to investigate and compare; no model is labelled truthful.
const INTENTS = [
  ['truth|facts|factual|fact check|fact checking|factcheck|verify|verification|evidence|reliable|accuracy|accurate|sources|citations|research|search|lookup|look up|investigate|check claims|真相|事实|求证|查证|核实|搜索|研究|查资料', { tools: 140, symposium: 85, compare: 45 }],
  ['compare|comparison|compare answers|second opinion|different perspectives|consensus|比较|对比|不同观点', { symposium: 80, compare: 75, models: 35 }],
  ['write|rewrite|writing|polish|proofread|proofreading|grammar|tone|draft|写作|改写|润色|校对', { canvas: 120, tools: 45 }],
  ['summarize|summarise|summary|tldr|总结|摘要', { tools: 75, notes: 55, canvas: 40 }],
  ['offline|local|private|privacy|without internet|no internet|without cloud|no cloud|离线|本地|隐私', { device: 140 }],
  ['presentation|presentations|powerpoint|slide|slides|pitch deck|演示|幻灯片', { slides: 140 }],
  ['learn|learning|study|studying|revision|revise|flashcards|quiz|exam|memorize|memorise|学习|复习|记忆|考试', { study: 140 }],
  ['translate|translation|multilingual|another language|翻译|多语言', { translate: 140 }],
  ['spreadsheet|spreadsheets|excel|csv|data analysis|statistics|chart|graph|电子表格|数据分析|图表', { sheets: 140 }],
  ['meeting|meetings|minutes|action items|decisions|会议|纪要|待办', { notes: 140 }],
  ['my files|saved files|across files|across my files|find in files|search files|file search|search my documents|ask my files|搜索文件|查找文件|文件搜索', { filesearch: 140 }],
  ['transcribe|transcription|transcript|转录|转写', { notes: 90, audio: 85 }],
  ['speech|speak|read aloud|text to speech|voice|tts|朗读|语音', { audio: 140 }],
  ['code|coding|programming|debug|debugging|bug|website|app|编程|代码|调试', { code: 140, api: 35 }],
  ['team|teamwork|collaborate|collaboration|together|shared|协作|团队|共享', { collab: 140, projects: 30 }],
  ['schedule|scheduled|automate|automatic|recurring|daily|weekly|monitor|watch|定时|自动|每日|每周|监控', { routines: 140 }],
  ['organize|organise|organization|organisation|folders|folder|整理|文件夹', { projects: 140 }],
  ['saved pictures|saved images|saved videos|creations|gallery|media library|已保存|作品|媒体库', { library: 140 }],
];
const STOP = new Set('a an the i me my we our you your it its this that these those to for of in on at with and or is are be do does can could would should want need help please something tool tools how what which find get make create use using into from about'.split(' '));
const normalize = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = (s) => [...new Set(normalize(s).split(/\s+/).filter(Boolean))];
const HAN = /\p{Script=Han}/u;
const INDEX = Object.fromEntries(Object.entries(TAGS).map(([id, tags]) => [id, tokens(tags)]));
const CONCEPTS = INTENTS.map(([aliases, weights]) => ({ aliases: aliases.split('|').map(normalize), weights }));

// Bounded spelling distance, including adjacent transpositions. Short words
// need an exact/prefix match; longer words can tolerate two mistyped letters.
function typo(a, b) {
  if (a.length < 5 || b.length < 5 || Math.max(a.length, b.length) > 32 || HAN.test(a + b)) return false;
  const limit = Math.min(a.length, b.length) >= 8 ? 2 : 1;
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let beforePrevious;
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j], beforePrevious[j - 2] + 1);
    }
    if (Math.min(...row) > limit) return false;
    beforePrevious = previous;
    previous = row;
  }
  return previous[b.length] <= limit;
}
function match(q, word) {
  if (q === word) return 1;
  if (HAN.test(q) && (q.includes(word) || word.includes(q))) return 0.9;
  if (q.length >= 3 && word.startsWith(q)) return 0.7;
  return typo(q, word) ? 0.55 : 0;
}
const best = (q, words) => words.reduce((value, word) => Math.max(value, match(q, word)), 0);

// Only rank caller-supplied entries: released/visible-tool filtering belongs to
// the caller, and search must never reintroduce a gated route. Empty queries
// retain the curated order; unknown intent produces an honest empty result.
export function rankTools(entries, query, translate = (s) => s) {
  const normalized = normalize(String(query ?? '').slice(0, 256));
  if (!normalized) return entries.slice();
  const terms = tokens(normalized).filter(s => !STOP.has(s)).slice(0, 24);
  if (!terms.length) return [];
  const intents = CONCEPTS.map(({ aliases, weights }) => ({
    strength: Math.max(...aliases.map(alias => alias.includes(' ')
      ? Number((' ' + normalized + ' ').includes(' ' + alias + ' '))
      : Math.max(...terms.map(term => match(term, alias))))), weights,
  })).filter(({ strength }) => strength > 0);
  return entries.map((entry, order) => {
    const [id, label, description = ''] = entry;
    const names = [normalize(label), normalize(translate(label))];
    const title = tokens(names.join(' '));
    const detail = tokens(description + ' ' + translate(description)).filter(s => !STOP.has(s));
    const tags = INDEX[id] || [];
    let matched = 0;
    let score = terms.reduce((sum, term) => {
      const value = Math.max(best(term, title) * 100, best(term, tags) * 50, best(term, detail) * 12);
      if (value) matched++;
      return sum + value;
    }, 0);
    score *= matched / terms.length;
    score += intents.reduce((sum, { strength, weights }) => sum + (weights[id] || 0) * strength, 0);
    return { entry, order, exact: names.includes(normalized), score };
  }).filter(item => item.exact || item.score >= 10)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.order - b.order)
    .map(({ entry }) => entry);
}
