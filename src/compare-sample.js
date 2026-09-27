// Document Compare's "Try a sample NDA": two made-up versions of a short
// mutual NDA between two fictional companies, built in the browser. Nothing
// in them is real, and they're not a template to use.
export const SAMPLE_NAMES = ["Sample NDA v1.txt", "Sample NDA v2.txt"];

const P = {
  title: "MUTUAL NON-DISCLOSURE AGREEMENT",
  parties: (date) =>
    `This Mutual Non-Disclosure Agreement (the "Agreement") is made on ${date} (the "Effective Date") between Kestrel Analytics Ltd. and Bluefin Studio LLC (each a "Party").`,
  purpose: (scope) =>
    `Purpose. The Parties wish to evaluate a possible collaboration on a data visualisation product${scope} (the "Purpose") and will share Confidential Information for that Purpose only.`,
  exclusions:
    "Exclusions. Confidential Information does not include information that is or becomes public through no fault of the receiving Party, was already known to it, or is developed independently without using the other Party's information.",
  obligations: (who) =>
    `Obligations. The receiving Party shall use Confidential Information only for the Purpose, protect it with at least reasonable care, and disclose it only to its ${who} who need to know it.`,
  compelled:
    "Compelled Disclosure. If the law or a court requires the receiving Party to disclose Confidential Information, it shall give the disclosing Party prompt notice, where lawful, so that it can seek protection.",
  term: (years, survive) =>
    `Term. This Agreement lasts ${years} from the Effective Date. The obligations in this Agreement survive for ${survive} after it ends.`,
  returning: (days) =>
    `Return of Information. On written request, the receiving Party shall return or destroy all Confidential Information within ${days}.`,
  noSolicit:
    "Non-Solicitation. During the term and for twelve (12) months after it, neither Party shall solicit for employment any employee of the other Party whom it met through the Purpose.",
  noLicence:
    "No Licence. Nothing in this Agreement grants any licence or right in the other Party's intellectual property.",
  noWarranty:
    'No Warranty. All Confidential Information is provided "as is", without any warranty as to its accuracy or completeness.',
  noDeal:
    "No Obligation. Neither Party is obliged to enter into any further agreement, and either may end the discussions at any time.",
  entire:
    "Entire Agreement. This Agreement is the entire agreement between the Parties about its subject and replaces all earlier discussions between them.",
  remedies:
    "Remedies. Each Party agrees that a breach may cause irreparable harm, and that the other Party may seek an injunction in addition to any other remedy.",
  assignment:
    "Assignment. Neither Party may assign this Agreement without the other Party's written consent, which shall not be unreasonably withheld.",
  severability:
    "Severability. If any part of this Agreement is found unenforceable, the rest of it remains in effect.",
  law: (where) =>
    `Governing Law. This Agreement is governed by the laws of ${where}, whose courts have exclusive jurisdiction.`,
  notices:
    "Notices. Notices must be in writing and sent to the addresses the Parties give each other.",
  counterparts:
    "Counterparts. This Agreement may be signed in counterparts, including by electronic signature, which together form one agreement.",
  signed: [
    "Signed for Kestrel Analytics Ltd. by M. Okafor, Director.",
    "Signed for Bluefin Studio LLC by J. Alvarez, Managing Member.",
  ],
};

export const SAMPLE_ORIGINAL = [
  P.title,
  P.parties("1 March 2026"),
  P.purpose(""),
  'Confidential Information. "Confidential Information" means non-public information disclosed by one Party to the other that is marked as confidential or would reasonably be understood to be confidential.',
  P.exclusions,
  P.obligations("employees and advisers"),
  P.compelled,
  P.term("two (2) years", "three (3) years"),
  P.returning("thirty (30) days"),
  P.noLicence,
  P.noWarranty,
  P.noDeal,
  P.entire,
  P.remedies,
  P.assignment,
  P.severability,
  P.law("England and Wales"),
  P.notices,
  P.counterparts,
  ...P.signed,
].join("\n\n");

export const SAMPLE_REVISED = [
  P.title,
  P.parties("15 March 2026"),
  P.purpose(" and any related follow-on projects"),
  'Confidential Information. "Confidential Information" means any information disclosed by one Party to the other, whether or not it is marked as confidential.',
  P.exclusions,
  P.obligations("employees, contractors and advisers"),
  P.compelled,
  P.term("five (5) years", "five (5) years"),
  P.returning("ten (10) days"),
  P.noSolicit,
  P.noLicence,
  P.noWarranty,
  P.noDeal,
  P.assignment,
  P.severability,
  P.law("the State of New York"),
  P.notices,
  P.entire,
  P.counterparts,
  ...P.signed,
].join("\n\n");
