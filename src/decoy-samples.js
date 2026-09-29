// Decoy Vault's sample chats (src/decoy-vault.js), loaded only when a decoy
// is made, so the workspace doesn't carry their text.
import { vaultChat } from "./device-vault.js";

// Ordinary things anyone might ask, in the language the app is shown in,
// saved exactly like a Device only chat (random UUID ids, the model picked
// in the composer, times spread over the past few weeks). Nothing in them
// is marked as a sample: the person can continue them, delete them or add
// their own.
const SAMPLES = {
  en: [
    [
      "What can I cook tonight with eggs, spinach and a bit of feta?",
      "A quick spinach and feta omelette works well:\n\n1. Wilt two handfuls of spinach in a pan with a little olive oil.\n2. Beat three eggs with salt and pepper and pour them over.\n3. Crumble the feta on top, cook on a low heat until just set, then fold it over.\n\nServe it with toast or a simple tomato salad. It takes about ten minutes.",
    ],
    [
      "Help me write a short message to my landlord about a dripping kitchen tap.",
      "Here's a short, friendly version:\n\n> Hi, the kitchen tap has started dripping all the time, even when it's fully closed. Could you arrange for someone to take a look this week? I'm home most evenings, or I can leave a key if that's easier. Thanks!\n\nYou could add a photo, or the date it started, if you like.",
    ],
    [
      "Make me a packing list for a long weekend by the sea.",
      "- Swimsuit and a quick-dry towel\n- Sunscreen, sunglasses and a hat\n- Light layers, plus one warm top for the evenings\n- Sandals and comfortable walking shoes\n- A reusable water bottle\n- Phone charger and a small power bank\n- A book for the beach\n- Basic first aid: plasters and after-sun",
    ],
    [
      "How often should I water tomato plants on a balcony?",
      "In warm weather most balcony tomatoes need water every day, and pots in full sun may need it twice on hot days. Water deeply at the base in the morning, until it runs out of the bottom of the pot. Check the soil with a finger: if the top few centimetres are dry, it's time. Keep it even, since swinging between dry and soaked can split the fruit.",
    ],
  ],
  zh: [
    [
      "家里有鸡蛋、菠菜和一点菲达奶酪，今晚可以做什么？",
      "可以做一份菠菜菲达奶酪煎蛋卷：\n\n1. 锅里放少许橄榄油，把两把菠菜炒软。\n2. 打三个鸡蛋，加盐和胡椒搅匀后倒进锅里。\n3. 撒上捏碎的菲达奶酪，小火煎到刚好凝固，再对折。\n\n配吐司或简单的番茄沙拉都不错，大约十分钟就能做好。",
    ],
    [
      "帮我给房东写一段简短的留言，说厨房水龙头一直在滴水。",
      "可以这样写：\n\n> 您好，厨房的水龙头最近一直在滴水，拧紧了也不停。这周方便安排人来看一下吗？我大多数晚上都在家，如果更方便，我也可以把钥匙留下。谢谢！\n\n如果需要，也可以附上照片或开始滴水的日期。",
    ],
    [
      "帮我列一份海边长周末的行李清单。",
      "- 泳衣和速干毛巾\n- 防晒霜、太阳镜和帽子\n- 轻薄衣物，外加一件晚上穿的保暖上衣\n- 凉鞋和舒适的步行鞋\n- 可重复使用的水瓶\n- 手机充电器和小型充电宝\n- 一本在海边看的书\n- 简单的急救用品：创可贴和晒后修复霜",
    ],
    [
      "阳台上的番茄多久浇一次水？",
      "天气暖和时，阳台上的番茄大多需要每天浇水；全日照的盆栽在炎热天气里可能一天要浇两次。最好在早上从根部浇透，直到盆底有水流出。可以用手指试一下土壤：表层几厘米干了就该浇水。尽量保持浇水均匀，忽干忽湿容易让果实开裂。",
    ],
  ],
};
// Roughly how many days ago each was last used, before a few hours' jitter.
const AGES = [1.2, 3.6, 8.3, 16.5];
const DAY = 86400000;

export function sampleChats({ lang = "en", model = null, now = Date.now(), newId = () => globalThis.crypto.randomUUID(), random = Math.random } = {}) {
  const set = SAMPLES[lang] || SAMPLES.en;
  return set.map(([question, answer], i) => {
    const updated = Math.round(now - AGES[i] * DAY - random() * 5 * 3600000);
    const created = updated - Math.round((2 + random() * 7) * 60000);
    return vaultChat({
      id: newId(),
      mode: "chat",
      privateMode: false,
      messages: [
        { role: "user", content: question, images: [] },
        {
          role: "assistant",
          content: answer,
          reasoning: "",
          images: [],
          citations: [],
          ...(typeof model === "string" && model ? { model } : {}),
          finishReason: "stop",
        },
      ],
      veil: null,
      created,
      now: updated,
    });
  });
}
