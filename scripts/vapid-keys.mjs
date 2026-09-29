// Push Alerts: prints a new VAPID key pair for the environment. Run it once
// per installation and keep the private key with the other secrets; changing
// it later makes every browser subscribe again the next time Account
// settings is open in it. VAPID_SUBJECT is how push services reach the
// operator: a mailto: address or an https: page.
//
//   node scripts/vapid-keys.mjs
import { generateVapidKeys } from "../server/web-push.js";

const { publicKey, privateKey } = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
