/**
 * ============================================================
 *  بوت واتساب احترافي - مجموعة الأنمي
 *  يعتمد على مكتبة Baileys
 *  الملف منظم بأقسام واضحة (Sections) لسهولة الصيانة والتوسعة
 * ============================================================
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ============================================================
// القسم 1: الإعدادات الثابتة
// ============================================================

// ⚠️ المالك الأساسي (ثابت لا يمكن إزالته) - نفس الشخص بمعرّفين محتملين
const PRIMARY_OWNERS = [
  '62170305933501@lid',
  '212726590815@s.whatsapp.net',
];

// مسار قاعدة البيانات (ملف JSON بسيط، لا يحتاج تثبيت أي سيرفر قاعدة بيانات)
const DB_PATH = path.join(__dirname, 'database.json');

// هيكلية قاعدة البيانات الافتراضية عند أول تشغيل
const DEFAULT_DB = {
  groups: {
    // كل مجموعة عندها كائن خاص بها، يتم إنشاؤه تلقائياً أول ما يتفاعل معها البوت
    // مثال شكل الكائن:
    // "1203xxxx@g.us": {
    //   ranks: { "<jid>": "عضو" },
    //   joinDates: { "<jid>": <timestamp> },
    //   messageCount: { "<jid>": number },
    //   totalMessagesToday: number,
    //   protection: { antilink: false, contentFilter: false },
    //   welcomeEnabled: true,
    //   locked: false,
    //   leavers: [ { jid, name, timestamp, reason } ... ] // آخر 20 مغادر
    // }
  },
  lastResetDate: null, // لتتبع آخر يوم تم فيه تصفير الإحصائيات (بتوقيت اليمن)
  targetGroupId: null, // معرف المجموعة الوحيدة التي يديرها البوت (يُكتشف تلقائياً)
  secondSovereign: null, // معرف صاحب السيادة الثانية (يُضاف/يُزال بأمر .سيادة)
  botEnabled: true, // إيقاف/تشغيل عام للبوت عبر .انهاء / .بدء
};

// ترتيب الرتب من الأقل للأعلى (تستخدم لمقارنة الصلاحيات)
const RANK_LEVELS = {
  'عضو': 0,
  'مشرف': 1,
  'نخبة': 2,
  'نائب الملك': 3,
  'الملك': 4,
};
const RANK_NAMES = Object.keys(RANK_LEVELS);

// كلمات ممنوعة لفلتر المحتوى (وسّعها براحتك)
const BANNED_WORDS = ['كلمة1', 'كلمة2'];

// نمط الروابط لمانع الروابط
const LINK_REGEX = /(https?:\/\/|www\.|chat\.whatsapp\.com)/i;

// ============================================================
// القسم 2: قاعدة البيانات (تحميل/حفظ ملف JSON)
// ============================================================

function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    }
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.log('❌ خطأ بقراءة قاعدة البيانات:', err);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (err) {
    console.log('❌ خطأ بحفظ قاعدة البيانات:', err);
  }
}

let db = loadDB();

// وقت بدء تشغيل البوت (بالثواني) - أي رسالة توقيتها أقدم من هذا الوقت نتجاهلها
// (رسائل وصلت وقت ما كان البوت متوقف، ما نبيه يرد عليها بعد ما يرجع يشتغل)
const BOT_START_TIME = Math.floor(Date.now() / 1000);

function ensureGroup(groupId) {
  if (!db.groups[groupId]) {
    db.groups[groupId] = {
      ranks: {},
      joinDates: {},
      messageCount: {},
      totalMessagesToday: 0,
      protection: { antilink: false, contentFilter: false },
      welcomeEnabled: true,
      locked: false,
      leavers: [],
      muted: {}, // { "<jid>": true } - أعضاء مكتومين، رسائلهم تُحذف تلقائياً
      banned: {}, // { "<jid>": true } - أعضاء منفيين، يُطردون تلقائياً لو حاولوا الدخول
    };
    saveDB(db);
  }
  return db.groups[groupId];
}

// ============================================================
// القسم 3: أدوات مساعدة عامة
// ============================================================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isSuperOwner(jid) {
  return PRIMARY_OWNERS.includes(jid) || jid === db.secondSovereign;
}

function isPrimaryOwner(jid) {
  return PRIMARY_OWNERS.includes(jid);
}

// نستخدم هذه المجموعة لتتبع الأشخاص اللي طردناهم للتو عبر أمر .طرد
// عشان لما يوصل حدث المغادرة نعرف نكتب السبب الصحيح بالسجل
const recentlyKicked = new Set();

function getRank(groupId, jid) {
  const group = ensureGroup(groupId);
  return group.ranks[jid] || 'عضو';
}

function setRank(groupId, jid, rank) {
  const group = ensureGroup(groupId);
  group.ranks[jid] = rank;
  saveDB(db);
}

function rankLevel(rank) {
  return RANK_LEVELS[rank] ?? 0;
}

// تحقق: هل الشخص (actorRank) يقدر يدير شخص ثاني (targetRank)؟
// القاعدة: لازم رتبة الفاعل أعلى من رتبة الهدف
function canManage(actorLevel, targetLevel) {
  return actorLevel > targetLevel;
}

function mention(jid) {
  const jidStr = typeof jid === 'string' ? jid : (jid?.id || jid?.jid || String(jid || ''));
  return `@${jidStr.split('@')[0]}`;
}

// يستخرج الشخص المستهدف من رد (Reply) أو منشن على رسالة الأمر
function getTargetJid(msg) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  return contextInfo?.participant || contextInfo?.mentionedJid?.[0] || null;
}

function todayDateString() {
  // نحسب التاريخ بتوقيت اليمن (Asia/Aden) بغض النظر عن توقيت الجهاز
  const yemenTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Aden' });
  const d = new Date(yemenTime);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// تصفير الإحصائيات اليومية (بدون إرسال أي رسالة للمجموعات)
function resetDailyStatsIfNeeded() {
  const today = todayDateString();
  if (db.lastResetDate !== today) {
    for (const groupId of Object.keys(db.groups)) {
      db.groups[groupId].messageCount = {};
      db.groups[groupId].totalMessagesToday = 0;
    }
    db.lastResetDate = today;
    saveDB(db);
    console.log('🔄 تم تصفير إحصائيات الرسائل اليومية');
  }
}

// فحص دوري كل دقيقة للتأكد من تصفير الإحصائيات عند منتصف الليل
setInterval(resetDailyStatsIfNeeded, 60 * 1000);
resetDailyStatsIfNeeded();

// ============================================================
// القسم 4: نصوص لوحة التحكم والمساعدة
// ============================================================

function buildCommandsList() {
  return `╭━━━〔 *قائمة الأوامر* 〕━━━╮

⚙️ *العامة*
.أسرع | .الأوامر | .مساعدة | .شرح | .بحث
.بطاقتي | .جماعي | .دخول | .خروج
.ترحيب | .تشغيل ترحيب | .إيقاف ترحيب | .إلغاء
.قفل | .فتح

🛡️ *الحماية*
.حماية | .حماية تشغيل | .حماية تعطيل

🔗 *الروابط*
.روابط | .روابط تشغيل | .روابط تعطيل

🚫 *فلتر المحتوى*
.فلتر المحتوى | .فلتر المحتوى تشغيل | .فلتر المحتوى تعطيل

🎯 *الرتب*
.رفع [رتبة] | .خفض | .طرد | .حذف
.مشرف إضافة | .مشرف إزالة | .تعديل رتبة | .مشرفين
.كتم | .نفي

👑 *النخبة*
.نخبة | .نخبة إضافة | .نخبة إزالة

🔱 *نائب الملك*
.نائب | .نائب إضافة | .نائب إزالة

📦 *النسخ الاحتياطية*
.القروبات | .استعادة [كود] | .تقسيم [كود] [عدد]

🎬 *الوسائط*
.ايديت [اسم الشخصية] (للسيادة العليا فقط)

🎵 *الموسيقى*
.موسيقى [اسم الأغنية]

📊 *الإحصائيات*
.المغادرين

💎 *السيادة العليا (بالخاص فقط)*
.سيادة [رقم] | .إزالة سيادة | .تحكم
.بدء | .انهاء

╰━━━━━━━━━━━━━━━━━━╯
_اكتب ".شرح [أمر]" لتفاصيل أي أمر._`;
}

const buildControlPanel = buildCommandsList; // نفس المحتوى، اسم بديل للتوافق مع الكود القديم

const COMMAND_HELP = {
  '.أسرع': 'يقيس سرعة استجابة البوت.',
  '.الأوامر': 'يعرض كل الأوامر المتوفرة.',
  '.مساعدة': 'يعرض لوحة التحكم الرئيسية.',
  '.شرح': 'اكتب ".شرح [أمر]" لمعرفة تفاصيل أمر معين.',
  '.بحث': 'للبحث داخل قوائم البوت (قيد التطوير).',
  '.بطاقتي': 'يعرض بطاقتك الشخصية (الاسم، الرقم، الرتبة، النشاط).',
  '.جماعي': 'يمنشن جميع أعضاء المجموعة برسالة.',
  '.دخول': 'يرسل رابط دعوة المجموعة (إن وجد).',
  '.خروج': 'يخرج البوت من المجموعة (Super Owner فقط).',
  '.ترحيب': 'يعرض حالة الترحيب الحالية.',
  '.تشغيل ترحيب': 'يفعّل رسائل الترحيب بالأعضاء الجدد.',
  '.إيقاف ترحيب': 'يوقف رسائل الترحيب.',
  '.إلغاء': 'يلغي آخر عملية معلّقة.',
  '.قفل': 'يقفل المجموعة (الرسائل للأدمن فقط).',
  '.فتح': 'يفتح المجموعة لجميع الأعضاء.',
  '.رفع': 'يرفع رتبة عضو، مثال: ".رفع مشرف" مع منشن الشخص أو رد على رسالته.',
  '.خفض': 'يخفض رتبة عضو لرتبة "عضو" الافتراضية.',
  '.طرد': 'يطرد عضو من المجموعة (يتطلب صلاحية أدمن).',
  '.حذف': 'يحذف رسالة معينة (رد عليها بأمر ".حذف").',
  '.حماية': 'يعرض حالة أنظمة الحماية الحالية.',
  '.مانع الروابط': 'يشغّل/يوقف حذف أي رسالة فيها رابط.',
  '.فلتر المحتوى': 'يشغّل/يوقف حذف الرسائل المخالفة.',
  '.ايديت': 'يبحث عن مونتاج أنمي للشخصية ويرسله (للسيادة العليا فقط)، مثال: ".ايديت ناروتو"',
  '.المغادرين': 'يعرض آخر 20 شخص غادروا أو تم طردهم من المجموعة.',
  '.سيادة': 'بالخاص فقط، للمالك الأساسي، يضيف سيادة ثانية: ".سيادة [رقم]"',
  '.إزالة سيادة': 'بالخاص فقط، للمالك الأساسي، يزيل السيادة الثانية الحالية.',
};

// ============================================================
// القسم 5: أنظمة الحماية
// ============================================================

async function handleProtection(sock, groupId, msg, text) {
  const group = ensureGroup(groupId);
  const senderJid = msg.key.participant || msg.key.remoteJid;

  // لا نطبق الحماية على السوبر أونر
  if (isSuperOwner(senderJid)) return false;

  if (group.protection.antilink && LINK_REGEX.test(text)) {
    try {
      await sock.sendMessage(groupId, { delete: msg.key });
    } catch (e) { /* تجاهل لو فشل الحذف */ }
    return true;
  }

  if (group.protection.contentFilter) {
    const lower = text.toLowerCase();
    if (BANNED_WORDS.some((w) => lower.includes(w))) {
      try {
        await sock.sendMessage(groupId, { delete: msg.key });
      } catch (e) { /* تجاهل */ }
      return true;
    }
  }

  return false;
}

// ============================================================
// القسم 6: نظام تحميل مونتاجات الأنمي (.ايديت)
// ============================================================

// ترجمة أسماء شخصيات شائعة من العربي للإنجليزي (تحسّن نتائج البحث بالمصادر الأجنبية)
const CHARACTER_NAME_MAP = {
  'ناروتو': 'Naruto', 'ساسكي': 'Sasuke', 'ساكورا': 'Sakura', 'كاكاشي': 'Kakashi',
  'ايتاتشي': 'Itachi', 'مادارا': 'Madara', 'لوفي': 'Luffy', 'زورو': 'Zoro',
  'غوكو': 'Goku', 'فيجيتا': 'Vegeta', 'ايتشيغو': 'Ichigo', 'ليفاي': 'Levi',
  'ايرين': 'Eren', 'ميكاسا': 'Mikasa', 'لايت': 'Light', 'سايتاما': 'Saitama',
  'تانجيرو': 'Tanjiro', 'نيزوكو': 'Nezuko', 'غوجو': 'Gojo', 'سوكونا': 'Sukuna',
  'ايدوارد': 'Edward Elric', 'كيريتو': 'Kirito', 'ديكو': 'Deku',
};

function translateCharacterName(name) {
  const trimmed = name.trim();
  return CHARACTER_NAME_MAP[trimmed] || trimmed;
}

/**
 * نظام بحث متعدد المصادر: نجرب TikTok أولاً، ولو فشل نجرب يوتيوب
 * كل دالة بحث ترجع: { url, title, source } أو null
 * قابل للتوسعة بسهولة: أضف دالة بحث جديدة وأدرجها بمصفوفة SEARCH_SOURCES
 */

async function searchTikTok(query) {
  try {
    const res = await fetch(`https://www.tikwm.com/api/feed/search?keywords=${encodeURIComponent(query)}&count=10`);
    const data = await res.json();
    const videos = data?.data?.videos;
    if (!videos || videos.length === 0) return null;
    const best = videos.find((v) => v.play) || videos[0];
    if (!best || !best.play) return null;
    return { url: best.play, title: best.title || query, source: 'tiktok' };
  } catch (err) {
    console.log('❌ فشل البحث بـ TikTok:', err.message);
    return null;
  }
}

async function searchYouTube(query) {
  try {
    const ytSearch = require('yt-search');
    const results = await ytSearch(query);
    if (!results || !results.videos || results.videos.length === 0) return null;
    const shortVideo = results.videos.find((v) => v.seconds > 0 && v.seconds < 180);
    const chosen = shortVideo || results.videos[0];
    return { url: chosen.url, title: chosen.title, source: 'youtube' };
  } catch (err) {
    console.log('❌ فشل البحث بيوتيوب:', err.message);
    return null;
  }
}

const SEARCH_SOURCES = [searchTikTok, searchYouTube];

async function searchAnimeEdit(characterNameRaw) {
  const characterName = translateCharacterName(characterNameRaw);
  const queries = [`${characterName} edit`, `${characterName} anime edit amv`];

  for (const searchFn of SEARCH_SOURCES) {
    for (const query of queries) {
      const result = await searchFn(query);
      if (result) return result;
    }
  }
  return null;
}

async function downloadAndSendEdit(sock, groupId, characterName) {
  const video = await searchAnimeEdit(characterName);
  if (!video) {
    await sock.sendMessage(groupId, { text: '❌ لم يتم العثور على مونتاج لهذه الشخصية.' });
    return;
  }

  await sock.sendMessage(groupId, { text: `🔎 لقيت مونتاج (${video.source}): ${video.title}\n⏳ جاري التحميل...` });

  try {
    if (video.source === 'tiktok') {
      // تحميل مباشر - tikwm يرجع رابط فيديو جاهز بدون علامة مائية
      const res = await fetch(video.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      await sock.sendMessage(groupId, { video: buffer, caption: `🎬 ${video.title}` });
      return;
    }

    // مصدر يوتيوب: تحميل عبر ytdl لملف مؤقت
    const tempPath = path.join(__dirname, `temp_${Date.now()}.mp4`);
    try {
      const ytdl = require('@distube/ytdl-core');
      let stream;
      try {
        stream = ytdl(video.url, { quality: 'highest', filter: 'audioandvideo' });
      } catch (e) {
        stream = ytdl(video.url, { filter: 'audioandvideo' });
      }

      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(tempPath);
        stream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        stream.on('error', reject);
      });

      await sock.sendMessage(groupId, {
        video: fs.readFileSync(tempPath),
        caption: `🎬 ${video.title}`,
      });
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  } catch (err) {
    console.log('❌ خطأ بتحميل/إرسال المونتاج:', err);
    await sock.sendMessage(groupId, {
      text: `⚠️ صار خطأ أثناء التحميل أو الإرسال:\n${err.message || err}`,
    });
  }
}

// ============================================================
// القسم 6ب: تحميل الموسيقى (.موسيقى)
// ============================================================

async function downloadAndSendMusic(sock, groupId, songName) {
  try {
    const found = await searchYouTube(songName);
    if (!found) {
      await sock.sendMessage(groupId, { text: '❌ لم يتم العثور على نتيجة لهذه الأغنية.' });
      return;
    }

    await sock.sendMessage(groupId, { text: `🎵 لقيت: ${found.title}\n⏳ جاري التحميل...` });

    const tempPath = path.join(__dirname, `temp_audio_${Date.now()}.mp3`);
    try {
      const ytdl = require('@distube/ytdl-core');
      const stream = ytdl(found.url, { filter: 'audioonly', quality: 'highestaudio' });

      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(tempPath);
        stream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        stream.on('error', reject);
      });

      await sock.sendMessage(groupId, {
        audio: fs.readFileSync(tempPath),
        mimetype: 'audio/mpeg',
        fileName: `${found.title}.mp3`,
      });
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  } catch (err) {
    console.log('❌ خطأ بتحميل الموسيقى:', err);
    await sock.sendMessage(groupId, { text: `⚠️ صار خطأ أثناء تحميل الأغنية:\n${err.message || err}` });
  }
}

// ============================================================
// القسم 7: معالجة الأوامر
// ============================================================

async function handleCommand(sock, msg, groupId, senderJid, text, isFromDM = false) {
  // نلف sock.sendMessage عشان كل رد يصير Reply تلقائي على رسالة المستخدم
  // (بدون الحاجة نعدل كل استدعاء لحاله)
  const rawSock = sock;
  if (!isFromDM) {
    sock = new Proxy(rawSock, {
      get(target, prop) {
        if (prop === 'sendMessage') {
          return (jid, content, opts) => target.sendMessage(jid, content, { quoted: msg, ...opts });
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  const group = ensureGroup(groupId);
  const isOwnerOrSuper = isSuperOwner(senderJid);
  const senderRank = getRank(groupId, senderJid);
  const senderLevel = rankLevel(senderRank);

  // --- بوابة الإيقاف العام: لو البوت متوقف (.انهاء)، ما يشتغل إلا أوامر السيادة ---
  const alwaysAllowed = ['.بدء', '.انهاء', '.تحكم', '.سيادة', '.إزالة سيادة'];
  const isAlwaysAllowed = alwaysAllowed.some((c) => text.startsWith(c));
  if (db.botEnabled === false && !isAlwaysAllowed) {
    return true; // البوت متوقف، نتجاهل بصمت
  }

  if (text === '.بدء') {
    if (!isOwnerOrSuper) {
      await sock.sendMessage(groupId, { text: '⛔ هذا الأمر للسيادة العليا فقط.' });
      return true;
    }
    db.botEnabled = true;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '✅ تم تشغيل البوت.' });
    return true;
  }

  if (text === '.انهاء') {
    if (!isOwnerOrSuper) {
      await sock.sendMessage(groupId, { text: '⛔ هذا الأمر للسيادة العليا فقط.' });
      return true;
    }
    db.botEnabled = false;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '⛔ تم إيقاف البوت مؤقتاً (عدا أوامر السيادة).' });
    return true;
  }

  // --- أوامر عامة (يقدر يستخدمها أي عضو) ---

  if (text === '.أسرع') {
    if (!isOwnerOrSuper && senderLevel < RANK_LEVELS['مشرف']) {
      await sock.sendMessage(groupId, { text: '⛔ هذا الأمر يتطلب رتبة مشرف فأعلى.' });
      return true;
    }
    const start = Date.now();
    await sock.sendMessage(groupId, { text: '⏱️ جاري القياس...' });
    const ms = Date.now() - start;
    const ramMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const uptimeSec = process.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    await sock.sendMessage(groupId, {
      text: `🚀 سرعة البوت\n\n⚡ Ping: "${ms} ms"\n🧠 RAM: "${ramMB} MB"\n⏳ التشغيل: "${days}d ${hours}h"\n\n🟢 الحالة: ممتازة`,
    });
    return true;
  }

  if (text === '.الأوامر' || text === '.أوامر' || text === '.اوامر' || text === '.مساعدة' || text === '.تحكم') {
    await sock.sendMessage(groupId, { text: buildCommandsList() }, { quoted: msg });
    return true;
  }

  if (text.startsWith('.شرح')) {
    const cmd = text.replace('.شرح', '').trim();
    if (!cmd) {
      await sock.sendMessage(groupId, { text: 'اكتب ".شرح [أمر]" مثال: ".شرح .رفع"' });
      return true;
    }
    const key = cmd.startsWith('.') ? cmd : `.${cmd}`;
    const helpText = COMMAND_HELP[key];
    await sock.sendMessage(groupId, {
      text: helpText ? `📖 ${key}:\n${helpText}` : '⚠️ ما لقيت شرح لهذا الأمر.',
    });
    return true;
  }

  if (text === '.بطاقتي') {
    const meta = await sock.groupMetadata(groupId).catch(() => null);
    const displayName = msg.pushName || senderJid.split('@')[0];
    const joinDate = group.joinDates[senderJid];
    const joinDateStr = joinDate ? new Date(joinDate).toLocaleDateString('ar-EG') : 'غير معروف';
    const rank = getRank(groupId, senderJid);
    const myMessages = group.messageCount[senderJid] || 0;
    const totalMessages = group.totalMessagesToday || 0;

    let activityStatus = '😴 متخاذل';
    if (myMessages >= 500) activityStatus = '🔥 نار';
    else if (myMessages >= 100) activityStatus = '⚡ نشط';

    const card = `╭━━〔 *بطاقة العضو* 〕━━╮
👤 الاسم: ${mention(senderJid)}
📱 الرقم: ${senderJid.split('@')[0]}
📅 تاريخ الدخول: ${joinDateStr}
🎖️ الرتبة: ${rank}
💬 رسائلك اليوم: ${myMessages}
📊 إجمالي رسائل المجموعة اليوم: ${totalMessages}
${activityStatus}
╰━━━━━━━━━━━━━━╯`;

    await sock.sendMessage(groupId, { text: card, mentions: [senderJid] });
    return true;
  }

  if (text === '.جماعي') {
    const meta = await sock.groupMetadata(groupId).catch(() => null);
    if (!meta) return true;
    const mentions = meta.participants.map((p) => p.id);
    const mentionText = mentions.map((jid) => mention(jid)).join(' ');
    await sock.sendMessage(groupId, { text: `📢 استدعاء جماعي\n${mentionText}`, mentions });
    return true;
  }

  if (text.startsWith('.ايديت')) {
    if (!isOwnerOrSuper) {
      await sock.sendMessage(groupId, { text: '⛔ هذا الأمر متاح فقط لأصحاب الصلاحية الكاملة.' });
      return true;
    }
    const character = text.replace('.ايديت', '').trim();
    if (!character) {
      await sock.sendMessage(groupId, { text: 'اكتب اسم الشخصية، مثال: ".ايديت ناروتو"' });
      return true;
    }
    await downloadAndSendEdit(sock, groupId, character);
    return true;
  }

  if (text.startsWith('.موسيقى')) {
    const songName = text.replace('.موسيقى', '').trim();
    if (!songName) {
      await sock.sendMessage(groupId, { text: 'اكتب اسم الأغنية، مثال: ".موسيقى اسم الأغنية"' });
      return true;
    }
    await downloadAndSendMusic(sock, groupId, songName);
    return true;
  }

  // --- أوامر تحتاج صلاحية مشرف فأعلى ---

  const needsModerator = ['.قفل', '.فتح', '.طرد', '.حذف', '.رفع', '.خفض',
    '.حماية', '.روابط', '.فلتر المحتوى', '.تشغيل ترحيب', '.إيقاف ترحيب', '.دخول', '.خروج',
    '.مشرف', '.نخبة', '.نائب', '.تعديل رتبة', '.مشرفين', '.كتم', '.نفي',
    '.القروبات', '.استعادة', '.تقسيم'];

  const matchedModCommand = needsModerator.find((c) => text.startsWith(c));

  if (matchedModCommand && !isOwnerOrSuper && senderLevel < RANK_LEVELS['مشرف']) {
    await sock.sendMessage(groupId, { text: '⛔ هذا الأمر يتطلب رتبة مشرف فأعلى.' });
    return true;
  }

  if (text === '.قفل') {
    await sock.groupSettingUpdate(groupId, 'announcement').catch(() => {});
    group.locked = true;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '🔒 تم قفل المجموعة، الإرسال للأدمن فقط.' });
    return true;
  }

  if (text === '.فتح') {
    await sock.groupSettingUpdate(groupId, 'not_announcement').catch(() => {});
    group.locked = false;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '🔓 تم فتح المجموعة لجميع الأعضاء.' });
    return true;
  }

  if (text === '.ترحيب') {
    await sock.sendMessage(groupId, {
      text: group.welcomeEnabled ? '🟢 الترحيب مفعّل حالياً.' : '🔴 الترحيب متوقف حالياً.',
    });
    return true;
  }

  if (text === '.تشغيل ترحيب') {
    group.welcomeEnabled = true;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '✅ تم تفعيل الترحيب.' });
    return true;
  }

  if (text === '.إيقاف ترحيب') {
    group.welcomeEnabled = false;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '⛔ تم إيقاف الترحيب.' });
    return true;
  }

  if (text === '.حماية') {
    await sock.sendMessage(groupId, {
      text: `🛡️ حالة الحماية:\nمانع الروابط: ${group.protection.antilink ? '🟢' : '🔴'}\nفلتر المحتوى: ${group.protection.contentFilter ? '🟢' : '🔴'}`,
    });
    return true;
  }

  if (text === '.حماية تشغيل') {
    group.protection.antilink = true;
    group.protection.contentFilter = true;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '🟢 تم تفعيل كل أنظمة الحماية.' });
    return true;
  }

  if (text === '.حماية تعطيل') {
    group.protection.antilink = false;
    group.protection.contentFilter = false;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '🔴 تم تعطيل كل أنظمة الحماية.' });
    return true;
  }

  if (text === '.روابط') {
    await sock.sendMessage(groupId, {
      text: `🔗 مانع الروابط حالياً: ${group.protection.antilink ? '🟢 مفعّل' : '🔴 متوقف'}`,
    });
    return true;
  }

  if (text === '.روابط تشغيل') {
    group.protection.antilink = true;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '🟢 تم تفعيل مانع الروابط.' });
    return true;
  }

  if (text === '.روابط تعطيل') {
    group.protection.antilink = false;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '🔴 تم تعطيل مانع الروابط.' });
    return true;
  }

  if (text === '.فلتر المحتوى') {
    await sock.sendMessage(groupId, {
      text: `🧹 فلتر المحتوى حالياً: ${group.protection.contentFilter ? '🟢 مفعّل' : '🔴 متوقف'}`,
    });
    return true;
  }

  if (text === '.فلتر المحتوى تشغيل') {
    group.protection.contentFilter = true;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '🟢 تم تفعيل فلتر المحتوى.' });
    return true;
  }

  if (text === '.فلتر المحتوى تعطيل') {
    group.protection.contentFilter = false;
    saveDB(db);
    await sock.sendMessage(groupId, { text: '🔴 تم تعطيل فلتر المحتوى.' });
    return true;
  }

  // --- رفع/خفض الرتب (يتطلب منشن أو رد على رسالة) ---
  if (text.startsWith('.رفع') || text === '.خفض') {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    const targetJid = contextInfo?.participant || contextInfo?.mentionedJid?.[0];

    if (!targetJid) {
      await sock.sendMessage(groupId, { text: '⚠️ منشن الشخص أو رد على رسالته لتنفيذ هذا الأمر.' });
      return true;
    }

    const targetLevel = rankLevel(getRank(groupId, targetJid));

    if (!isOwnerOrSuper && !canManage(senderLevel, targetLevel)) {
      await sock.sendMessage(groupId, { text: '⛔ لا تملك صلاحية كافية لإدارة هذا الشخص.' });
      return true;
    }

    if (text.startsWith('.رفع')) {
      const requestedRank = text.replace('.رفع', '').trim();
      const validRank = RANK_NAMES.find((r) => r === requestedRank);

      if (!validRank) {
        await sock.sendMessage(groupId, {
          text: `⚠️ رتبة غير صحيحة. الرتب المتاحة: ${RANK_NAMES.join('، ')}`,
        });
        return true;
      }

      if (!isOwnerOrSuper && rankLevel(validRank) >= senderLevel) {
        await sock.sendMessage(groupId, { text: '⛔ لا تقدر ترفع لرتبة مساوية أو أعلى من رتبتك.' });
        return true;
      }

      setRank(groupId, targetJid, validRank);

      await sock.sendMessage(groupId, {
        text: `📢 تمت الترقية\n\n⬆️ المرقّي: ${mention(senderJid)}\n🎖️ المرتقي: ${mention(targetJid)}`,
        mentions: [senderJid, targetJid],
      });
      return true;
    }

    if (text === '.خفض') {
      setRank(groupId, targetJid, 'عضو');
      await sock.sendMessage(groupId, {
        text: `📢 تم إعفاء العضو\n\n⬇️ المعفي: ${mention(senderJid)}\n👤 المعفى: ${mention(targetJid)}`,
        mentions: [senderJid, targetJid],
      });
      return true;
    }
  }

  if (text === '.طرد') {
    const targetJid = getTargetJid(msg);
    if (!targetJid) {
      await sock.sendMessage(groupId, { text: '⚠️ منشن الشخص أو رد على رسالته.' });
      return true;
    }
    try {
      recentlyKicked.add(targetJid);
      await sock.groupParticipantsUpdate(groupId, [targetJid], 'remove');
      await sock.sendMessage(groupId, { text: `✅ تم طرد ${mention(targetJid)}`, mentions: [targetJid] });
    } catch (err) {
      recentlyKicked.delete(targetJid);
      await sock.sendMessage(groupId, { text: '⚠️ تعذر الطرد، تأكد إن البوت أدمن بالمجموعة.' });
    }
    return true;
  }

  // --- اختصارات رتب محددة (مشرف/نخبة/نائب) ---
  const rankShortcuts = [
    { addCmd: '.مشرف إضافة', removeCmd: '.مشرف إزالة', statusCmd: null, rank: 'مشرف' },
    { addCmd: '.نخبة إضافة', removeCmd: '.نخبة إزالة', statusCmd: '.نخبة', rank: 'نخبة' },
    { addCmd: '.نائب إضافة', removeCmd: '.نائب إزالة', statusCmd: '.نائب', rank: 'نائب الملك' },
  ];

  for (const rs of rankShortcuts) {
    if (text === rs.statusCmd) {
      const members = Object.entries(group.ranks).filter(([, r]) => r === rs.rank).map(([jid]) => jid);
      if (members.length === 0) {
        await sock.sendMessage(groupId, { text: `📋 لا يوجد أحد برتبة ${rs.rank} حالياً.` });
      } else {
        await sock.sendMessage(groupId, {
          text: `📋 أعضاء رتبة ${rs.rank}:\n${members.map((j) => mention(j)).join('\n')}`,
          mentions: members,
        });
      }
      return true;
    }

    if (text === rs.addCmd || text === rs.removeCmd) {
      const targetJid = getTargetJid(msg);
      if (!targetJid) {
        await sock.sendMessage(groupId, { text: '⚠️ منشن الشخص أو رد على رسالته.' });
        return true;
      }
      const targetLevel = rankLevel(getRank(groupId, targetJid));
      if (!isOwnerOrSuper && !canManage(senderLevel, targetLevel)) {
        await sock.sendMessage(groupId, { text: '⛔ لا تملك صلاحية كافية لإدارة هذا الشخص.' });
        return true;
      }

      if (text === rs.addCmd) {
        setRank(groupId, targetJid, rs.rank);
        await sock.sendMessage(groupId, {
          text: `📢 تمت الترقية\n\n⬆️ المرقّي: ${mention(senderJid)}\n🎖️ المرتقي: ${mention(targetJid)}`,
          mentions: [senderJid, targetJid],
        });
      } else {
        setRank(groupId, targetJid, 'عضو');
        await sock.sendMessage(groupId, {
          text: `📢 تم إعفاء العضو\n\n⬇️ المعفي: ${mention(senderJid)}\n👤 المعفى: ${mention(targetJid)}`,
          mentions: [senderJid, targetJid],
        });
      }
      return true;
    }
  }

  if (text === '.مشرفين') {
    const members = Object.entries(group.ranks).filter(([, r]) => r === 'مشرف').map(([jid]) => jid);
    if (members.length === 0) {
      await sock.sendMessage(groupId, { text: '📋 لا يوجد مشرفين حالياً.' });
    } else {
      await sock.sendMessage(groupId, {
        text: `📋 قائمة المشرفين:\n${members.map((j) => mention(j)).join('\n')}`,
        mentions: members,
      });
    }
    return true;
  }

  if (text.startsWith('.تعديل رتبة')) {
    const targetJid = getTargetJid(msg);
    const requestedRank = text.replace('.تعديل رتبة', '').trim();
    if (!targetJid || !requestedRank) {
      await sock.sendMessage(groupId, { text: '⚠️ استخدم: رد على شخص + ".تعديل رتبة [اسم الرتبة]"' });
      return true;
    }
    const validRank = RANK_NAMES.find((r) => r === requestedRank);
    if (!validRank) {
      await sock.sendMessage(groupId, { text: `⚠️ رتبة غير صحيحة. الرتب المتاحة: ${RANK_NAMES.join('، ')}` });
      return true;
    }
    const targetLevel = rankLevel(getRank(groupId, targetJid));
    if (!isOwnerOrSuper && (!canManage(senderLevel, targetLevel) || rankLevel(validRank) >= senderLevel)) {
      await sock.sendMessage(groupId, { text: '⛔ لا تملك صلاحية كافية لهذا التعديل.' });
      return true;
    }
    setRank(groupId, targetJid, validRank);
    await sock.sendMessage(groupId, { text: `✅ تم تعديل رتبة ${mention(targetJid)} إلى ${validRank}`, mentions: [targetJid] });
    return true;
  }

  // --- الكتم والنفي ---
  if (text === '.كتم') {
    const targetJid = getTargetJid(msg);
    if (!targetJid) {
      await sock.sendMessage(groupId, { text: '⚠️ منشن الشخص أو رد على رسالته.' });
      return true;
    }
    group.muted[targetJid] = true;
    saveDB(db);
    await sock.sendMessage(groupId, { text: `🔇 تم كتم ${mention(targetJid)}`, mentions: [targetJid] });
    return true;
  }

  if (text === '.إلغاء كتم') {
    const targetJid = getTargetJid(msg);
    if (targetJid) {
      delete group.muted[targetJid];
      saveDB(db);
      await sock.sendMessage(groupId, { text: `🔊 تم إلغاء كتم ${mention(targetJid)}`, mentions: [targetJid] });
    }
    return true;
  }

  if (text === '.نفي') {
    const targetJid = getTargetJid(msg);
    if (!targetJid) {
      await sock.sendMessage(groupId, { text: '⚠️ منشن الشخص أو رد على رسالته.' });
      return true;
    }
    group.banned[targetJid] = true;
    saveDB(db);
    try {
      recentlyKicked.add(targetJid);
      await sock.groupParticipantsUpdate(groupId, [targetJid], 'remove');
    } catch (e) { /* تجاهل */ }
    await sock.sendMessage(groupId, { text: `🚫 تم نفي ${mention(targetJid)} (سيُطرد تلقائياً لو حاول الدخول)`, mentions: [targetJid] });
    return true;
  }

  // --- النسخ الاحتياطية ---
  if (text === '.القروبات') {
    const meta = await sock.groupMetadata(groupId).catch(() => null);
    if (!meta) {
      await sock.sendMessage(groupId, { text: '⚠️ تعذر جلب معلومات المجموعة.' });
      return true;
    }
    await sock.sendMessage(groupId, {
      text: `📦 المجموعة الحالية:\n📛 الاسم: ${meta.subject}\n🆔 المعرف: ${groupId}\n👥 الأعضاء: ${meta.participants.length}`,
    });
    return true;
  }

  if (text.startsWith('.تقسيم')) {
    const parts = text.replace('.تقسيم', '').trim().split(/\s+/);
    const count = parseInt(parts[0], 10) || 1;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

    const fullData = JSON.stringify(db);
    const chunkSize = Math.ceil(fullData.length / count);
    for (let i = 0; i < count; i++) {
      const chunk = fullData.slice(i * chunkSize, (i + 1) * chunkSize);
      fs.writeFileSync(path.join(backupDir, `${code}_part${i + 1}.json`), chunk);
    }

    await sock.sendMessage(groupId, {
      text: `📦 تم إنشاء نسخة احتياطية\n🔑 الكود: ${code}\n📄 عدد الأجزاء: ${count}\n\nاستخدم ".استعادة ${code}" لاستعادتها لاحقاً.`,
    });
    return true;
  }

  if (text.startsWith('.استعادة')) {
    const code = text.replace('.استعادة', '').trim().toUpperCase();
    if (!code) {
      await sock.sendMessage(groupId, { text: 'اكتب ".استعادة [الكود]"' });
      return true;
    }
    const backupDir = path.join(__dirname, 'backups');
    try {
      const files = fs.readdirSync(backupDir)
        .filter((f) => f.startsWith(`${code}_part`))
        .sort((a, b) => {
          const numA = parseInt(a.match(/part(\d+)/)[1], 10);
          const numB = parseInt(b.match(/part(\d+)/)[1], 10);
          return numA - numB;
        });

      if (files.length === 0) {
        await sock.sendMessage(groupId, { text: '⚠️ ما لقيت نسخة احتياطية بهذا الكود.' });
        return true;
      }

      const fullData = files.map((f) => fs.readFileSync(path.join(backupDir, f), 'utf-8')).join('');
      const restoredDb = JSON.parse(fullData);
      db = restoredDb;
      saveDB(db);
      await sock.sendMessage(groupId, { text: `✅ تم استعادة النسخة الاحتياطية (${code}) بنجاح.` });
    } catch (err) {
      await sock.sendMessage(groupId, { text: `⚠️ فشلت الاستعادة: ${err.message || err}` });
    }
    return true;
  }

  if (text === '.حذف') {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    if (!contextInfo || !contextInfo.stanzaId) {
      await sock.sendMessage(groupId, { text: '⚠️ رد على الرسالة يلي تبي تحذفها بأمر ".حذف"' });
      return true;
    }
    try {
      await sock.sendMessage(groupId, {
        delete: {
          remoteJid: groupId,
          id: contextInfo.stanzaId,
          participant: contextInfo.participant,
        },
      });
    } catch (err) {
      await sock.sendMessage(groupId, { text: '⚠️ تعذر حذف الرسالة.' });
    }
    return true;
  }

  if (text === '.دخول') {
    try {
      const code = await sock.groupInviteCode(groupId);
      await sock.sendMessage(groupId, { text: `🔗 رابط الدعوة:\nhttps://chat.whatsapp.com/${code}` });
    } catch (err) {
      await sock.sendMessage(groupId, { text: '⚠️ تعذر جلب رابط الدعوة.' });
    }
    return true;
  }

  if (text === '.خروج') {
    if (!isOwnerOrSuper) {
      await sock.sendMessage(groupId, { text: '⛔ هذا الأمر لأصحاب الصلاحية الكاملة فقط.' });
      return true;
    }
    await sock.sendMessage(groupId, { text: '👋 وداعاً، البوت راح يخرج من المجموعة الآن.' });
    await sock.groupLeave(groupId);
    return true;
  }

  if (text === '.إلغاء') {
    await sock.sendMessage(groupId, { text: '✅ تم إلغاء أي عملية معلّقة.' });
    return true;
  }

  if (text === '.بحث') {
    await sock.sendMessage(groupId, { text: '🔍 ميزة البحث قيد التطوير حالياً.' });
    return true;
  }

  if (text === '.المغادرين') {
    const leavers = group.leavers || [];
    if (leavers.length === 0) {
      await sock.sendMessage(groupId, { text: '📋 لا يوجد سجل مغادرين حتى الآن.' });
      return true;
    }
    const list = leavers
      .slice(-20)
      .reverse()
      .map((l, i) => {
        const d = new Date(l.timestamp);
        const dateStr = d.toLocaleDateString('ar-EG');
        const timeStr = d.toLocaleTimeString('ar-EG');
        return `${i + 1}. ${l.name} (${l.jid.split('@')[0]})\n   📅 ${dateStr} 🕒 ${timeStr}\n   السبب: ${l.reason}`;
      })
      .join('\n\n');
    await sock.sendMessage(groupId, { text: `📋 آخر المغادرين:\n\n${list}` });
    return true;
  }

  // --- أوامر السيادة (بالخاص فقط، للمالك الأساسي فقط) ---
  if (text.startsWith('.سيادة') || text === '.إزالة سيادة') {
    if (!isFromDM) {
      // هذه الأوامر لا تعمل داخل المجموعة إطلاقاً، نتجاهلها بصمت
      return true;
    }
  }

  if (text.startsWith('.سيادة')) {
    if (!isPrimaryOwner(senderJid)) {
      await sock.sendMessage(senderJid, { text: '⛔ هذا الأمر للمالك الأساسي فقط.' });
      return true;
    }
    const target = text.replace('.سيادة', '').trim();
    if (!target) {
      await sock.sendMessage(senderJid, { text: 'اكتب ".سيادة [رقم الشخص]" مثال: .سيادة 212600000000' });
      return true;
    }
    const targetJid = target.includes('@') ? target : `${target.replace(/\D/g, '')}@s.whatsapp.net`;
    db.secondSovereign = targetJid;
    saveDB(db);

    const congratsMsg = `👑 تهانينا!\n\nتم تعيينك رسميًا كسيادة عليا للبوت.\n\n🛡️ بواسطة المُرقّي: ${mention(senderJid)}\n\nأصبحت تمتلك صلاحيات التحكم الكاملة.\n\n📋 لمعرفة جميع أوامر التحكم أرسل:\n.تحكم\n\nمرحبًا بك في فريق إدارة البوت. 🚀`;

    try {
      await sock.sendMessage(targetJid, { text: congratsMsg, mentions: [senderJid] });
      await sock.sendMessage(senderJid, { text: `✅ تمت إضافة ${target} كسيادة ثانية، وتم إبلاغه بنجاح.` });
    } catch (err) {
      await sock.sendMessage(senderJid, { text: `✅ تمت الإضافة، لكن تعذر إرسال رسالة الخاص له (${err.message || err}).` });
    }
    return true;
  }

  if (text === '.إزالة سيادة') {
    if (!isPrimaryOwner(senderJid)) {
      await sock.sendMessage(senderJid, { text: '⛔ هذا الأمر للمالك الأساسي فقط.' });
      return true;
    }
    db.secondSovereign = null;
    saveDB(db);
    await sock.sendMessage(senderJid, { text: '✅ تمت إزالة السيادة الثانية.' });
    return true;
  }

  return false; // ما كان أمر معروف
}

// ============================================================
// القسم 8: بدء تشغيل البوت
// ============================================================

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('❌ الاتصال انقطع | السبب:', statusCode, '| إعادة الاتصال:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('⚠️ تم تسجيل الخروج. احذف auth_info وأعد الربط');
      }
    } else if (connection === 'open') {
      console.log('✅ البوت متصل بنجاح');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // تتبع دخول أعضاء جدد: نسجل تاريخ الدخول + رسالة الترحيب
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id: groupId, participants: rawParticipants, action } = update;
      const group = ensureGroup(groupId);

      // بعض إصدارات Baileys ترجع كائنات بدل نصوص - نطبّعها لنصوص JID دائماً
      const participants = (rawParticipants || [])
        .map((p) => (typeof p === 'string' ? p : (p?.id || p?.jid)))
        .filter(Boolean);

      if (action === 'add') {
        for (const jid of participants) {
          // لو الشخص منفي، اطرده تلقائياً فوراً
          if (group.banned && group.banned[jid]) {
            recentlyKicked.add(jid);
            await sock.groupParticipantsUpdate(groupId, [jid], 'remove').catch(() => {});
            continue;
          }
          group.joinDates[jid] = Date.now();
        }
        saveDB(db);

        const newMembers = participants.filter((jid) => !(group.banned && group.banned[jid]));
        if (group.welcomeEnabled && newMembers.length > 0) {
          const names = newMembers.map((jid) => mention(jid)).join(' ');
          await sock.sendMessage(groupId, {
            text: `🌸 أهلاً وسهلاً ${names} بالمجموعة!`,
            mentions: newMembers,
          });
        }
      }

      if (action === 'remove') {
        if (!group.leavers) group.leavers = [];
        for (const jid of participants) {
          const wasKicked = recentlyKicked.has(jid);
          recentlyKicked.delete(jid);
          group.leavers.push({
            jid,
            name: jid.split('@')[0],
            timestamp: Date.now(),
            reason: wasKicked ? 'تم طرده' : 'غادر المجموعة',
          });
        }
        // نحتفظ بآخر 20 سجل فقط
        group.leavers = group.leavers.slice(-20);
        saveDB(db);
      }
    } catch (err) {
      console.log('❌ خطأ بمعالجة دخول عضو:', err);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      // نتعامل بس مع الرسائل الحية (type === 'notify')
      // أي رسائل ثانية (backlog وصل وقت ما كان البوت متوقف) نتجاهلها
      if (type !== 'notify') return;

      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      // 🔍 تشخيص مؤقت: يطبع أي رسالة خاصة توصل، عشان نتأكد من الـ JID الصحيح
      const debugFrom = msg.key.remoteJid;
      if (!debugFrom.endsWith('@g.us')) {
        console.log('📩 [خاص] من:', debugFrom, '| النص:', msg.message.conversation || msg.message.extendedTextMessage?.text || '');
      }

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

      resetDailyStatsIfNeeded();

      // ==== حالة 1: رسالة داخل المجموعة ====
      if (isGroup) {
        const groupId = from;
        const senderJid = msg.key.participant || groupId;

        // نحفظ معرف هذه المجموعة تلقائياً كـ"المجموعة المستهدفة" لأوامر التحكم بالخاص
        if (db.targetGroupId !== groupId) {
          db.targetGroupId = groupId;
          saveDB(db);
        }

        // كتم: احذف أي رسالة من عضو مكتوم
        const group0 = ensureGroup(groupId);
        if (group0.muted && group0.muted[senderJid]) {
          await sock.sendMessage(groupId, { delete: msg.key }).catch(() => {});
          return;
        }

        // فحص أنظمة الحماية أولاً
        const wasBlocked = await handleProtection(sock, groupId, msg, text);
        if (wasBlocked) return;

        // احتساب الرسائل (لكل الرسائل النصية غير الأوامر وغير المحظورة)
        const group = ensureGroup(groupId);
        group.messageCount[senderJid] = (group.messageCount[senderJid] || 0) + 1;
        group.totalMessagesToday = (group.totalMessagesToday || 0) + 1;
        saveDB(db);

        // معالجة الأوامر (أي رسالة تبدأ بنقطة)
        if (text.startsWith('.')) {
          await handleCommand(sock, msg, groupId, senderJid, text, false);
        }
        return;
      }

      // ==== حالة 2: رسالة خاصة (DM) ====
      // أوامر التحكم تشتغل هنا، بس لأصحاب الصلاحية الكاملة (Super Owners)
      if (!isSuperOwner(from)) return;
      if (!text.startsWith('.')) return;

      if (!db.targetGroupId) {
        await sock.sendMessage(from, {
          text: '⚠️ البوت لسا ما شاف أي رسالة من المجموعة، أضف البوت للمجموعة وخلي حد يرسل فيها رسالة أولاً.',
        });
        return;
      }

      // ننفذ الأمر على المجموعة المستهدفة (الفعل الفعلي يظهر بالمجموعة، مثل الترقية/الطرد/الإعلانات)
      await handleCommand(sock, msg, db.targetGroupId, from, text, true);
      // تأكيد سريع بالخاص إنه الأمر انفذ
      await sock.sendMessage(from, { text: '✅ تم تنفيذ الأمر (النتيجة الكاملة تظهر بالمجموعة إن وجدت).' });

    } catch (err) {
      console.log('❌ خطأ عام:', err);
    }
  });
}

startBot();
