import { SAMPLE_MARKDOWN } from "../src/translate-sample.js";
import { SYSTEM_PREFIX } from "../src/translate-spec.js";
import { unescapeDocumentText } from "../src/documents.js";

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for a
// model translating one part, so Translate docs can be driven end to end
// without a provider. Never used live.
//
// The sample document (src/translate-sample.js) has written translations
// into French and Simplified Chinese, block for block; anything else is
// marked as a fixture, keeping its Markdown structure. Veil's placeholders
// are kept, so masked details come back as they went. Markers in a part
// drive the failure paths the tests and the demo rig need:
// TRANSLATE-TEST-FAIL (a provider error), TRANSLATE-TEST-LENGTH (cut off at
// the reply budget), TRANSLATE-TEST-DROP (placeholders lost every time),
// TRANSLATE-TEST-DROP-ONCE (lost until the retry names them) and
// TRANSLATE-TEST-FENCE (the answer wrapped in a code fence).
const blocks = (md) =>
  String(md)
    .trim()
    .split(/\n{2,}/)
    .map((b) => b.trim());
const EN = blocks(SAMPLE_MARKDOWN);
const WRITTEN = {
  fr: [
    "# Politique de télétravail",
    "*Northwind Studio · Version 2.1 · En vigueur à compter du 1er octobre 2026*",
    "La présente politique explique comment nous travaillons lorsque nous ne sommes pas au studio. Elle s'applique à l'ensemble de l'équipe, y compris aux prestataires qui travaillent avec nous depuis plus de trois mois. Lorsqu'elle mentionne « votre responsable », il s'agit de la personne à qui vous rendez compte au quotidien.",
    "## 1. Qui peut travailler à distance",
    "Toute personne dont le poste ne nécessite pas de présence sur site peut travailler à distance jusqu'à **quatre jours par semaine**. Les postes qui exigent du matériel du studio, comme l'atelier d'impression et le studio photo, conviennent plutôt d'un planning avec leur responsable. Les nouveaux arrivants passent leurs deux premières semaines au studio, afin de rencontrer l'équipe et de se familiariser avec nos outils.",
    [
      "- Indiquez à votre responsable les jours où vous prévoyez d'être absent au plus tard le vendredi de la semaine précédente.",
      "- Tenez votre agenda à jour afin que vos collègues sachent quand vous êtes disponible.",
      "- Venez à la réunion générale mensuelle, le premier mardi de chaque mois.",
    ].join("\n"),
    "## 2. Horaires de travail",
    "Nos heures de présence commune vont de **10:00 à 15:00**, heure locale. En dehors de cette plage, travaillez quand cela vous convient, à condition de respecter vos échéances et de répondre aux messages dans un délai d'un jour ouvré. Si vous travaillez sur plusieurs fuseaux horaires, convenez d'heures communes avec votre équipe et indiquez-les dans votre profil.",
    [
      "| Situation | Que faire | Qui prévenir |",
      "| --- | --- | --- |",
      "| Vous êtes malade | Reposez-vous et déconnectez-vous | Votre responsable, avant 10:00 |",
      "| Votre connexion Internet est coupée | Travaillez hors ligne ou venez au studio | Le canal de l'équipe |",
      "| Vous allez manquer une échéance | Convenez d'une nouvelle date | Votre responsable et le client |",
    ].join("\n"),
    "## 3. Équipement et frais",
    "Nous vous prêtons un ordinateur portable, un écran et un casque, et nous vous livrons une chaise si vous en avez besoin. Vous pouvez demander jusqu'à **40 € par mois** pour vos frais d'Internet et d'électricité. Soumettez vos justificatifs via l'application de notes de frais au plus tard le cinquième jour ouvré du mois suivant ; les demandes de plus de trois mois ne peuvent pas être remboursées.",
    [
      "1. Prenez soin du matériel comme s'il vous appartenait.",
      "2. Signalez toute perte ou tout dommage dans les 24 heures.",
      "3. Restituez l'ensemble du matériel dans les deux semaines suivant votre départ.",
    ].join("\n"),
    "## 4. Sécurité",
    "Verrouillez votre écran chaque fois que vous vous absentez, et ne travaillez jamais sur des fichiers clients via un Wi-Fi public sans le VPN. Ne transférez pas vos e-mails professionnels vers un compte personnel, et ne laissez ni votre famille ni vos amis utiliser votre ordinateur portable professionnel. Rangez les documents clients imprimés à l'abri des regards et détruisez-les lorsque vous n'en avez plus besoin.",
    "> Si vous pensez qu'un appareil ou un compte a été compromis, signalez-le immédiatement. Personne n'aura d'ennuis pour l'avoir signalé.",
    "## 5. Bien-être",
    "Le travail à domicile peut brouiller la frontière entre travail et repos. Prenez une vraie pause déjeuner, désactivez les notifications en dehors des heures de travail et utilisez la totalité de vos congés. Si la charge de travail vous semble trop lourde, parlez-en tôt à votre responsable : nous préférons adapter un planning plutôt que de voir un collègue s'épuiser. Notre ligne d'assistance aux employés est gratuite, confidentielle et accessible jour et nuit.",
    "## 6. Déplacements et réunions",
    "Lorsque vous venez au studio pour des réunions clients ou des ateliers, réservez vos trajets auprès du service des déplacements au moins cinq jours ouvrés à l'avance. Nous prenons en charge les billets de train en seconde classe et, pour les trajets de plus de trois heures, une nuit d'hôtel près du studio. Conservez vos justificatifs ; le service des déplacements vous les demandera.",
    "## 7. Questions",
    "Pour toute question que cette politique ne couvre pas, écrivez à people@northwind.example ou appelez le +44 20 7946 0958. Nous révisons cette politique tous les six mois ; la prochaine révision aura lieu en avril 2027, et nous vous demanderons votre avis d'ici là.",
  ],
  "zh-CN": [
    "# 远程办公政策",
    "*Northwind Studio · 第 2.1 版 · 自 2026 年 10 月 1 日起生效*",
    "本政策说明我们不在工作室时的工作方式，适用于团队全体成员，包括与我们合作超过三个月的外包人员。文中所称“您的主管”，是指您日常汇报工作的对象。",
    "## 1. 谁可以远程办公",
    "岗位无需在现场工作的员工，每周最多可远程办公**四天**。需要使用工作室设备的岗位（例如印刷间和摄影棚）应与主管另行商定工作安排。新员工入职后的前两周须在工作室工作，以便认识团队、熟悉我们的工具。",
    [
      "- 请在前一周的周五之前，告知主管您计划远程办公的日期。",
      "- 请及时更新日历，方便同事了解您何时有空。",
      "- 请参加每月第一个星期二举行的全员大会。",
    ].join("\n"),
    "## 2. 工作时间",
    "我们的核心工作时间为当地时间 **10:00 至 15:00**。在此之外，您可以灵活安排工作时间，但须按时完成任务，并在一个工作日内回复消息。如果您需要跨时区工作，请与团队商定共同在线的时段，并写在个人资料中。",
    [
      "| 情况 | 处理方式 | 通知对象 |",
      "| --- | --- | --- |",
      "| 您生病了 | 好好休息，并退出登录 | 您的主管，10:00 之前 |",
      "| 网络中断 | 离线工作，或到工作室办公 | 团队频道 |",
      "| 您将错过截止日期 | 商定新的日期 | 您的主管和客户 |",
    ].join("\n"),
    "## 3. 设备与费用",
    "我们会为您提供笔记本电脑、显示器和耳机；如有需要，还会为您送去一把椅子。您每月最多可报销 **€40** 的网络费和电费。请在次月第五个工作日之前通过报销应用提交票据；超过三个月的报销申请将无法支付。",
    ["1. 请像爱护自己的物品一样爱护这些设备。", "2. 如有遗失或损坏，请在 24 小时内报告。", "3. 离职后两周内归还全部设备。"].join("\n"),
    "## 4. 安全",
    "每次离开座位时请锁定屏幕；未开启 VPN 时，切勿通过公共 Wi-Fi 处理客户文件。请勿将工作邮件转发到个人账户，也不要让家人或朋友使用您的工作笔记本电脑。打印的客户文件应妥善存放，用完后请用碎纸机销毁。",
    "> 如果您认为某台设备或某个账户已遭入侵，请立即报告。任何人都不会因为报告而受到责备。",
    "## 5. 身心健康",
    "居家办公可能会模糊工作与休息的界限。请好好享用午休时间，下班后关闭通知，并休完全部年假。如果您觉得工作量过大，请尽早与主管沟通：我们宁愿调整计划，也不愿看到同事因过度劳累而倒下。我们的员工援助热线免费、保密，全天候开放。",
    "## 6. 差旅与会议",
    "如需来工作室参加客户会议或研讨会，请至少提前五个工作日通过差旅服务台预订行程。我们报销标准舱位的火车票；单程超过三小时的行程，还可报销工作室附近一晚的酒店住宿。请保留好票据，差旅服务台会向您索取。",
    "## 7. 问题咨询",
    "如有本政策未涵盖的任何问题，请发送邮件至 people@northwind.example 或致电 +44 20 7946 0958。我们每六个月审阅一次本政策；下一次审阅将于 2027 年 4 月进行，在此之前我们会征求您的意见。",
  ],
};
// A block's words, without Veil's tags or what they replace, so a masked
// block finds its written translation.
const signature = (s) => (String(s).match(/(?<![\p{L}\p{N}@._+[-])\p{L}{3,}(?![\p{L}\p{N}@_\]-])/gu) || []).join(" ").toLowerCase();
const SIGNED = new Map(EN.map((b, i) => [signature(b), i]));
// What each of Veil's tags in `masked` stands for in `original`.
function tagValues(original, masked) {
  const tags = [...masked.matchAll(/\[([A-Z]+_\d+)\]/g)].map((m) => m[1]);
  if (!tags.length) return [];
  const pattern = masked
    .split(/\[[A-Z]+_\d+\]/)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("(.+?)");
  const m = new RegExp("^" + pattern + "$", "s").exec(original);
  return m ? tags.map((t, i) => [m[i + 1], t]) : [];
}
function fixture(block, code) {
  const mark = `«${code}» `;
  return block
    .split("\n")
    .map((line) => {
      if (/^\s*\|?\s*:?-{3,}/.test(line)) return line;
      const lead = /^(\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+|\|\s*)?)/.exec(line)[1];
      return lead + mark + line.slice(lead.length);
    })
    .join("\n");
}
function translateBlock(block, code) {
  const i = SIGNED.get(signature(block));
  const written = i != null ? WRITTEN[code]?.[i] : null;
  if (!written) return fixture(block, code);
  let out = written;
  for (const [value, tag] of tagValues(EN[i], block)) out = out.split(value).join(`[${tag}]`);
  return out;
}

export function translateTestReply(messages) {
  const system = messages?.[0];
  if (system?.role !== "system" || typeof system.content !== "string" || !system.content.startsWith(SYSTEM_PREFIX)) return null;
  const user = messages.find((m) => m.role === "user")?.content;
  if (typeof user !== "string") return null;
  const code = /^Target language: .* \(([\w-]+)\)\.$/m.exec(system.content)?.[1] || "xx";
  const source = unescapeDocumentText(/<document [^>]*>([\s\S]*)<\/document>/.exec(user)?.[1] || "");
  if (source.includes("TRANSLATE-TEST-FAIL")) return { error: "Local test provider: this part failed on purpose." };
  let text = blocks(source)
    .map((b) => translateBlock(b, code))
    .join("\n\n");
  if (source.includes("TRANSLATE-TEST-LENGTH")) return { text: text.slice(0, 40), finish: "length" };
  const retried = /dropped or changed these placeholders/.test(user);
  if (source.includes("TRANSLATE-TEST-DROP") && !(source.includes("TRANSLATE-TEST-DROP-ONCE") && retried))
    text = text.replace(/\[[A-Z]+_\d+\]/g, "");
  if (source.includes("TRANSLATE-TEST-FENCE")) text = "```markdown\n" + text + "\n```";
  return { text };
}
