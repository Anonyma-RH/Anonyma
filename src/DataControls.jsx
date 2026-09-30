import { Link } from "react-router-dom";
import { useApp } from "./context.jsx";
import { isReleased, modeReleased } from "./lib.js";

export default function DataControls() {
  const { config } = useApp() || {};
  // Share a Chat is described only once it's live.
  const shares = !!config && isReleased(config, "sharelinks");
  // So are Routines.
  const routines = !!config && isReleased(config, "routines");
  // And Page Watch, whose reports are part of the Routines inbox.
  const pageWatch = routines && isReleased(config, "pagewatch");
  // And Research Watch: Deep Research on a Routines schedule.
  const researchWatch =
    routines &&
    isReleased(config, "researchwatch") &&
    isReleased(config, "deepresearch") &&
    isReleased(config, "search");
  // And Sealed Share, which builds on Share a Chat.
  const sealedShares = shares && isReleased(config, "sealedshare");
  // And Burn After Reading, an option on both.
  const burnLinks = shares && isReleased(config, "burnlinks");
  // And Projects.
  const projects = !!config && isReleased(config, "projects");
  // And Two-Step Sign-in.
  const twoStep = !!config && isReleased(config, "twostep");
  // And Low-Balance Alerts.
  const alerts = !!config && isReleased(config, "balancealerts");
  // And Bookmarks.
  const bookmarks = !!config && isReleased(config, "bookmarks");
  // And Pay with NYMA.
  const nyma = !!config && isReleased(config, "paynyma");
  // And Redact Before You Send.
  const redact = !!config && isReleased(config, "redact");
  // And Link Reader, which needs Documents.
  const linkReader =
    !!config && isReleased(config, "linkreader") && isReleased(config, "documents");
  // And Blind Compare.
  const blind = !!config && isReleased(config, "blind");
  // And Blind Arena, built on it.
  const arena = blind && isReleased(config, "arena");
  // And Audio Overview, which needs Voice & Audio.
  const overviews =
    !!config && isReleased(config, "audiooverview") && isReleased(config, "audio");
  // Passkeys: listed once that update is live.
  const passkeys = !!config && isReleased(config, "passkeys");
  // And the Recovery Kit.
  const recoveryKit = !!config && isReleased(config, "recovery");
  // And the Privacy Screen.
  const privacyScreen = !!config && isReleased(config, "privacyscreen");
  // And PDF Redact.
  const pdfRedact = !!config && isReleased(config, "pdfredact");
  // And Local OCR, which needs Documents.
  const ocr = !!config && isReleased(config, "ocr") && isReleased(config, "documents");
  // And Study Mode.
  const study = !!config && isReleased(config, "study");
  // And Python Runner.
  const python = !!config && isReleased(config, "python");
  // And Inactivity Wipe, whose erase is Panic Wipe's.
  const inactivity =
    !!config && isReleased(config, "deadswitch") && isReleased(config, "wipe");
  // And Gift Links.
  const gifts = !!config && isReleased(config, "giftlinks");
  // And Vault Sync, which builds on Device Vault.
  const vaultSync = !!config && isReleased(config, "vaultsync") && isReleased(config, "vault");
  // And Decoy Vault, which builds on Device Vault too.
  const decoy = !!config && isReleased(config, "decoy") && isReleased(config, "vault");
  // And Canvas.
  const canvas = !!config && isReleased(config, "canvas");
  // And Slides.
  const slides = !!config && isReleased(config, "slides");
  // Push Alerts, whose notifications arrive through the app's worker.
  const push = !!config && isReleased(config, "pushalerts") && isReleased(config, "app");
  // And Repo Reader.
  const repos = !!config && isReleased(config, "reporeader");
  // And Secret Guard.
  const secretGuard = !!config && isReleased(config, "secretguard");
  // And Characters.
  const characters = !!config && isReleased(config, "characters");
  // And Contract Reader.
  const contracts = !!config && modeReleased(config, "contracts");
  return (
    <div className="data-controls">
      <h3>What is retained</h3>
      <ul>
        <li>
          Personal conversations: the 300 most recently updated conversations.
          Creating another conversation removes the oldest personal conversation
          and its messages. Symposium runs are kept separately: the newest 150,
          removed the same way. Shared conversations have no automatic count or
          time limit.
        </li>
        <li>
          Saved media: the latest 100 images, 60 videos and 60 audio files per
          account, per type. Saving another file removes the oldest file of that
          type. These are count limits, not day limits.
        </li>
        <li>
          Clean Uploads removes location, camera and author details from photos, saved Office files and saved audio in your browser before they leave your device; chat documents send only their text.
        </li>
        {redact && (
          <li>
            Redact Before You Send: the boxes you draw on an image are applied in your browser. Only the redacted copy is sent, and only it is kept in a saved chat. The original isn't uploaded, and ANONYMA isn't told that an image was redacted.
          </li>
        )}
        {pdfRedact && (
          <li>
            PDF Redact: the PDF is opened, boxed and redrawn in your browser, and the redacted copy is written there. Nothing is uploaded, saved or added to your export unless you choose Send to chat, and then only the redacted pages, as pictures or as the text read from them on this device, go to a new chat.
          </li>
        )}
        {ocr && (
          <li>
            Local OCR: Text only reads an image's words in your browser. Only the text you keep is sent, and only it is kept in a saved chat; the image isn't uploaded. The text reader's files come from ANONYMA's own server, and your browser keeps a copy.
          </li>
        )}
        {python && (
          <li>
            Python Runner: code from a reply runs in your browser, with no network. Its output, and any file you give it, stay on this device and aren't saved with the chat. Python's files come from ANONYMA's own server, and your browser keeps a copy.
          </li>
        )}
        {secretGuard && (
          <li>
            Secret Guard checks what you send from the workspace for passwords, API keys and tokens in your browser. Masked ones go as placeholders like [SECRET_1]; their real values stay in that tab's memory and are never sent or saved. Only whether you switched it off is kept with your account. It doesn't check the developer API (/v1) or MCP: those callers are programs, and holding their requests would break them.
          </li>
        )}
        <li>
          Device Vault keeps device-only chats encrypted in this browser with your passphrase; ANONYMA's servers store none of them, and they can't be recovered without the passphrase.
        </li>
        {vaultSync && (
          <li>
            Vault Sync, if you turn it on: your browser encrypts each Device Vault chat before it's uploaded, so ANONYMA stores only ciphertext. We keep each chat's random id, version, size and when it changed, plus the vault's salt and an encrypted passphrase check; never the passphrase, the key or a title. Nobody can read these chats without your passphrase, including us. Forget synced copy, Panic Wipe and closing your account delete it; your account export includes the encrypted copy.
          </li>
        )}
        {decoy && (
          <li>
            Decoy Vault, if you set a decoy passphrase: a second, separate vault kept encrypted in this browser only. It's never synced, uploaded or in your account export, and Panic Wipe and deleting Device Vault remove it too.
          </li>
        )}
        <li>
          Routines: each routine's prompt and settings, and the newest 50 runs per routine (answer, charge and receipt), until you delete them.
        </li>
        <li>
          Panic Wipe (Account → Settings, type WIPE) erases your conversations, media files, uploads, memory, Scrolls, routines, collabs you own and support requests, revokes keys and connected apps, and signs out everywhere; your balance, ledger, deposits, receipts and settings remain, and backups are separate copies.
        </li>
        <li>
          Privacy Trail keeps only these facts with a saved reply: the model,
          provider, gateway route, retention, storage, Veil's mask count and
          the receipt id. No prompt text is added.
        </li>
        <li>
          Seed Guard checks for wallet seed phrases and private keys in your
          browser and stops them before sending; nothing about a match is logged
          or saved.
        </li>
        <li>
          NYMA holders at 1,000,000+ keep twice as much: 600 conversations, 300
          Symposium runs, 200 images, 120 videos and 120 audio files. Below
          that, nothing is deleted at once; the standard caps apply again as new
          items are saved.
        </li>
        <li>
          Connected apps: the name you gave each one, the name it gave itself,
          its return address, budget and expiry. Its charges are in the ledger
          like any other; prompts and answers sent through it aren't stored.
          Its sign-in tokens are kept only as hashes and deleted when they
          expire or you revoke the app.
        </li>
        {shares && (
          <li>
            Share links: when you share a conversation, a read-only copy of its
            messages’ text is stored with the link’s title and random address.
            Veil tags stay tags, and attachments, images and files are left
            out. The copy is deleted when the link expires, when you revoke it,
            when its conversation is deleted or auto-deleted, and when you
            close your account. Anyone with the link can read it; links are
            never listed publicly and ask search engines not to index them.
          </li>
        )}
        {sealedShares && (
          <li>
            Sealed share links: your browser encrypts the snapshot before it’s
            uploaded, so only the encrypted copy, its random address and its
            dates are stored. The key stays in the link after the #, which
            browsers never send to a server, so ANONYMA can’t read a sealed
            link. A Device-only chat can be shared only this way; its encrypted
            copy is deleted when the link expires, when you revoke it, and when
            you close your account or use Panic Wipe.
          </li>
        )}
        {burnLinks && (
          <li>
            Burn-after-reading links: the same copy as any share link, stored
            under a fingerprint of the link rather than the link itself. The
            first time someone opens it, the copy and its title are deleted
            at once, and only the link’s dates are kept (created, opened,
            expires) so you can see when it was read. Opening the page alone
            never counts: only a click on Open does.
          </li>
        )}
        {routines && (
          <li>
            Routines: each routine’s name, prompt, model, schedule and budget,
            and its inbox: the newest 50 runs per routine, with their answers,
            sources, charges and signed receipts. Runs happen on the server, so
            Veil can’t mask a routine’s prompt, and a Private models only
            routine’s answers are still kept in the inbox. Deleting a run or a
            routine deletes its answers; the ledger entries stay. Closing your
            account deletes every routine and its inbox, and no routine runs
            after that.
          </li>
        )}
        {pageWatch && (
          <li>
            Page Watch: each watched page’s link, how often it’s checked, its
            hint, model and budget, and one copy of the page’s readable text
            (the last version, at most 200 KB) with its fingerprint, kept only
            to spot changes. Reports keep a change’s summary, never the page
            or the diff: the newest 50 per watch, with their charges and
            signed receipts. The model is sent only the changed lines, a
            little context and the site’s name. Deleting a watch deletes its
            copy of the page and its reports; Panic Wipe and closing your
            account delete every watch.
          </li>
        )}
        {researchWatch && (
          <li>
            Research Watch: each watch’s topic, depth, model, schedule and
            budget, and its reports in the Routines inbox: the newest 50 per
            watch, with their sources and charges. With “Only what’s new”, the
            last report’s key findings (at most 3,000 characters) are sent
            with the next run, and deleting that report makes the watch forget
            it. Runs happen on the server, so Veil can’t mask the topic: it
            goes to the model and, as searches, to web search as written.
            Deleting a watch deletes its reports; Panic Wipe and closing your
            account delete every watch.
          </li>
        )}
        {projects && (
          <li>
            Projects: each project’s name, colour, instructions, default model
            and how its new chats start, which saved chats and Symposium runs
            are in it, and which saved files are pinned to it. Its instructions
            are sent with each chat by your browser and aren’t saved with the
            chat. Off the record, Private Mode and Device only chats are never
            saved, so never listed in a project here; a Device only default and
            its chats stay in this browser, grouped by project inside its
            encrypted vault. Deleting a project keeps its chats; a pin goes when
            its saved file expires or is deleted. Closing your account or Panic
            Wipe deletes every project.
          </li>
        )}
        {characters && (
          <li>
            Characters: each character’s name, description, instructions,
            opening message, default model and picture, and which saved chats
            are with it. They’re private to your account. A character’s
            instructions are sent with each chat by your browser and aren’t saved
            with the chat; its opening message is saved as the chat’s first
            message, with no model and no charge. Off the record, Private Mode
            and Device only chats are never saved, so never listed with a
            character. Deleting a character keeps its chats. A copy link keeps
            a snapshot of the character for up to 30 days (or until you revoke
            it, or delete the character), with no chats and nothing about you.
            Closing your account, Panic Wipe and Inactivity Wipe delete every
            character and link.
          </li>
        )}
        {twoStep && (
          <li>
            Two-step sign-in: while it’s on, your authenticator key, sealed
            with the server’s app secret, and your ten recovery codes, kept only
            as one-way hashes. A sign-in waiting for its code lasts 5 minutes,
            and a session’s “confirm it’s you” 10 minutes. Your export says
            only whether it’s on. Turning it off or closing
            your account deletes the key and codes; Panic Wipe leaves it on.
          </li>
        )}
        {passkeys && (
          <li>
            Passkeys: each passkey’s public key, credential id, sign counter,
            name, dates and whether it’s synced, plus a random account handle
            the passkey stores instead of your username, email or wallet. Your
            face, fingerprint and PIN never leave your device. A sign-in or
            setup waiting for your device lasts 5 minutes. Your export lists
            each passkey’s name and dates, not its keys. Removing a passkey or
            closing your account deletes it; Panic Wipe keeps your passkeys so
            you can still sign in.
          </li>
        )}
        {recoveryKit && (
          <li>
            Recovery kit: when you made it, and each of its ten codes only as a
            one-way scrypt digest with when it was used; never the codes. A
            code that was accepted waits 15 minutes for your new password or
            passkey. Wrong codes are counted for an hour per username and per
            network address, under keys that don’t contain either. If you
            dismiss the nudge to make a kit, when you did. Your export says
            when the kit was made and how many codes are unused. Deleting the
            kit or closing your account deletes it; Panic Wipe keeps it so you
            can still get back in.
          </li>
        )}
        {inactivity && (
          <li>
            Inactivity Wipe: off until you choose 30, 90, 180 or 365 days.
            While it’s on, we keep the period, whether API and connected-app
            use counts, when you were last active (updated at most once an
            hour), the reminder’s state and when it last erased. Past the
            deadline it erases what Panic Wipe erases. A reminder email goes 7
            days before, only if email is set up and only to a verified email.
            Turning it off or closing your account deletes the setting; Panic
            Wipe keeps it.
          </li>
        )}
        {push && (
          <li>
            Push Alerts: each browser you turned alerts on in (its push
            address, the two public values alerts are encrypted to, its push
            service, its language, when you added it and when it last got an
            alert) and which kinds you want. An alert is one fixed sentence,
            never your content; waiting alerts are kept for at most 4 days.
            Your export lists each browser with its push service only.
            Removing a browser deletes it; Panic Wipe, Inactivity Wipe and
            closing your account delete all of it.
          </li>
        )}
        {alerts && (
          <li>
            Low-balance alerts: your alert level and whether you asked for
            browser notifications. Whether you dismissed the banner is kept
            only in this browser. Closing your account deletes the setting;
            Panic Wipe keeps it with your other settings.
          </li>
        )}
        {bookmarks && (
          <li>
            Bookmarks: which messages you starred and your private notes, up to
            1,000 per account, visible only to you. A bookmark stores no copy of
            the message: it goes when you remove it, when its chat is deleted or
            auto-deleted, when you leave the collab it belongs to, and when you
            wipe or close your account.
          </li>
        )}
        {gifts && (
          <li>
            Gift Links: each gift you make (its amount, note, dates and
            whether it was claimed or returned) and a fingerprint of its code,
            never the code itself. Who claimed a gift isn't kept with it and
            is never shown to you. Panic Wipe and closing your account cancel
            your unclaimed gifts, return their credits to your balance, then
            delete the list; the ledger keeps its entries.
          </li>
        )}
        {blind && (
          <li>
            Blind Compare votes: the two models compared, your vote and its
            date, for Your rankings. Never the prompt or the replies, and
            nothing about a comparison before you vote. Reset them from Your
            rankings; Panic Wipe and closing your account delete them.
          </li>
        )}
        {arena && (
          <li>
            Blind Arena: only whether you add your Blind votes to the public
            leaderboard. It's off unless you say yes. A vote you add goes into
            a count per day and model pair with no account attached, so it
            stays when you switch this off, wipe or close your account. Panic
            Wipe and closing your account delete the choice.
          </li>
        )}
        {overviews && (
          <li>
            Audio overviews: a saved overview is one audio file in your library
            plus its script (the title, the chapters and what each host says),
            never the document or chat it was made from. Deleting the file
            deletes its script; Panic Wipe and closing your account delete
            both. Off the record, nothing is kept.
          </li>
        )}
        {privacyScreen && (
          <li>
            Privacy Screen: its choices and whether the screen is locked are
            kept only in this browser. Unlocking checks your password (or an
            email code or wallet signature) on the server, which keeps nothing
            but a count of wrong attempts, under a one-way key, for up to 15
            minutes. Hiding takes your chats off the screen, not out of this
            browser’s memory.
          </li>
        )}
        {study && (
          <li>
            Study Mode: decks and review progress are kept only in this
            browser, unencrypted, and ANONYMA's servers store none of them.
            Making a deck is an off-the-record chat: the source you chose is
            sent to the model once and not saved. Panic Wipe clears the decks
            in the browser you use it in.
          </li>
        )}
        {canvas && (
          <li>
            Canvas: a canvas saved to your account keeps its title and text,
            up to 200 per account, until you delete it; your auto-delete
            default applies to new ones. Suggestions are off-the-record chats:
            only the selection and a little text around it (or the whole
            document, for whole-document actions) is sent, and nothing about
            them is saved. Canvases kept off the record stay in one browser
            tab; Device Vault canvases are encrypted in this browser. Panic
            Wipe and closing your account delete saved canvases.
          </li>
        )}
        {slides && (
          <li>
            Slides: a deck you save is kept on your account (its title, theme,
            the text on its slides and the speaker notes) until you delete it,
            and it is in your data export. Never the source it was made from or
            the model that made it: making a deck is an off-the-record chat.
            Decks made off the record or in Private Mode are kept only in this
            browser, unencrypted. Panic Wipe erases both; closing the account
            erases the saved ones.
          </li>
        )}
        {repos && (
          <li>
            Repo Reader: a repo you read is kept only in the server's memory,
            for your account, for 30 minutes (or until you forget it, or
            sooner when the server needs the memory), then dropped; it's never
            written to disk or logged. Questions are asked
            off the record, so neither they nor the answers are saved. Your
            data export lists the repos open at the time; Panic Wipe and
            closing the account forget them at once.
          </li>
        )}
        {contracts && (
          <li>
            Contract Reader: a contract you read (its live facts and public
            source) is kept only in the server's memory, for your account,
            for 30 minutes, then dropped; it's never written to disk, and the
            address is never logged. An explanation is saved as an ordinary
            conversation unless it's off the record or in Private Mode. Your
            data export lists the contracts open at the time; Panic Wipe and
            closing the account forget them at once.
          </li>
        )}
        {nyma && (
          <li>
            Pay with NYMA quotes: each quote’s NYMA amount, rate, bonus and
            your linked wallet address, until Panic Wipe or closing your
            account deletes them. A credited NYMA top-up stays as a deposit
            record with its transaction hash, sending wallet and rate, like any
            other payment.
          </li>
        )}
        {linkReader && (
          <li>
            Link Reader: a page you ask it to read is fetched by ANONYMA’s
            server with no cookies and no referrer, so the site sees our server,
            not you. The link and the page are never logged or stored on their
            own; the page’s text is kept only inside your message, like an
            attached document, when the chat is saved.
          </li>
        )}
        <li>
          Temporary API-generated media expires after 24 hours when created with
          an expiry. Access stops at expiry; background maintenance removes the
          file. This does not make unreleased API features available.
        </li>
        <li>
          Sessions expire after 30 days. Background maintenance removes expired
          sessions, challenges more than one hour past expiry and rate-limit
          email records older than 24 hours. General request counters expire at
          the end of their rate window; SQLite removes expired counters during
          later requests, and a shared Redis store expires them automatically.
          Cleanup requires the service to be running; expired authentication is
          refused immediately.
        </li>
        <li>
          Account-linked support requests, video job records and non-expiring
          content have no additional scheduled age-based deletion. A list
          showing only the latest jobs or transactions is not a retention limit.
        </li>
      </ul>
      <h3>Export your data</h3>
      <p>
        Open{" "}
        <Link to="/account/settings">
          Account → Settings → Export account data
        </Link>{" "}
        to download JSON containing your profile, full ledger and deposits,
        request receipts, video jobs, media metadata, key metadata, active
        session dates and account-linked support requests. The export includes
        conversations you can currently access and your own retained
        contributions to shared conversations. Another member’s private spending
        details are excluded.
      </p>
      {projects && (
        <p>
          The export also includes your projects: their settings, the chats
          and Symposium runs in each, and their pinned files.
        </p>
      )}
      {characters && (
        <p>
          The export also includes your characters, with their pictures, the
          chats with each, and your live copy links.
        </p>
      )}
      {routines && (
        <p>
          The export also includes your routines and their inbox runs.
        </p>
      )}
      {pageWatch && (
        <p>
          The export also includes your page watches, the copy of each page
          they keep, and their reports.
        </p>
      )}
      {alerts && (
        <p>The export also includes your low-balance alert setting.</p>
      )}
      {bookmarks && (
        <p>
          The export also lists your bookmarks: each one’s message and
          conversation ids and your note. The messages themselves are already
          in the export.
        </p>
      )}
      {nyma && <p>The export also includes your Pay with NYMA quotes.</p>}
      {gifts && (
        <p>
          The export also lists the gifts you made: amount, note, dates and
          state. Codes aren't kept, so they can't be exported.
        </p>
      )}
      {blind && (
        <p>The export also lists your Blind Compare votes: the two models, the outcome and the date.</p>
      )}
      {arena && <p>It also says whether you add your votes to the Blind Arena.</p>}
      {overviews && (
        <p>The export also lists your audio overviews’ scripts. Their audio files are listed with your media.</p>
      )}
      {canvas && <p>The export also includes your canvases saved to your account, with their text.</p>}
      {recoveryKit && (
        <p>
          The export also says when your recovery kit was made, how many of its
          codes are unused and when one was last used. Never the codes: ANONYMA
          can’t show them again.
        </p>
      )}
      {passkeys && (
        <p>
          The export also lists your passkeys: each one’s name, when it was
          added and last used, and whether it’s synced. Public keys and
          credential ids are left out: only ANONYMA’s sign-in check uses them.
        </p>
      )}
      {shares && (
        <p>
          The export also lists your live share links with their addresses,
          titles and dates. The shared text itself is a copy of the
          conversation’s own messages, which the export already includes.
        </p>
      )}
      {sealedShares && (
        <p>
          Sealed links are exported as their addresses without keys, their
          dates and the encrypted copy exactly as stored.
        </p>
      )}
      {burnLinks && (
        <p>
          Burn-after-reading links are exported as their dates only: when
          each was made, when it expires and when it was opened. Never their
          address or their copy.
        </p>
      )}
      <p>
        Exports never include passwords, password hashes, session tokens,
        API-key secrets or their hashes. Monetary units are recorded in the
        file. Media entries are links and metadata, not copies of the files:
        download the files you want to keep before deleting content or closing
        the account. Previously pruned or deleted content cannot be exported.
      </p>
      <h3>Delete content or close your account</h3>
      <p>
        Delete an individual conversation or clear personal history in the
        workspace. Delete saved media from the library when that feature is
        enabled. In shared workspaces, conversation deletion requires the
        creator or workspace owner. Clearing personal history does not delete
        shared conversations.
      </p>
      <p>
        To close your account, export first, then choose Close account in
        Account → Settings and type DELETE. Active generation holds or
        unresolved payment invoices block closure until resolved. Closing
        removes personal conversations and messages, saved media files, video
        jobs, account-linked support requests and sessions. It deletes
        workspaces you own, including their shared content; it ends membership
        in other workspaces while preserving their shared messages under the
        deleted account’s internal ID, without its profile name.
      </p>
      <p>
        Closure clears your username, password hash, email and linked wallet,
        and revokes API keys and connected apps while clearing their hashes,
        prefixes and names.
        Unused credits are forfeited. Successful deletion removes active records
        and files; a file-removal failure is reported instead of claiming
        success, so you can retry.
      </p>
      <h3>What deletion does not erase</h3>
      <p>
        Financial ledger entries, deposit records, request accounting, referral
        relationships and a deleted-account marker remain under an internal
        account ID. There is currently no automatic expiry for these records.
        Payment records can include transaction hashes and wallet addresses;
        immutable ledger descriptions may contain identifiers used at the time
        of a transaction.
      </p>
      <p>
        Exports or downloaded files already in your possession, public
        blockchain transactions, messages copied by collaborators, email already
        sent to the support inbox and data already sent to AI providers are not
        erased by account closure. Signed-out support requests are not
        automatically linked to an account; contact{" "}
        <Link to="/support">support</Link> with their reference to request
        access or deletion.
      </p>
      <p>
        Backups are separate copies. The app has no automatic backup-expiry
        schedule or deletion replay after a restore. Operator backup retention,
        restore handling, provider retention and processing locations still need
        to be published. An account deletion is not a promise of immediate
        erasure from every backup or provider.
      </p>
      <h3>Optional demo</h3>
      <p>
        The demo stores sample data in this browser. Export or reset it from
        demo account settings. Resetting the demo does not close a real account
        or delete downloaded files.
      </p>
    </div>
  );
}
