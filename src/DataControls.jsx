import { Link } from "react-router-dom";
import { useApp } from "./context.jsx";
import { isReleased } from "./lib.js";

export default function DataControls() {
  const { config } = useApp() || {};
  // Share a Chat is described only once it's live.
  const shares = !!config && isReleased(config, "sharelinks");
  // So are Routines.
  const routines = !!config && isReleased(config, "routines");
  // And Sealed Share, which builds on Share a Chat.
  const sealedShares = shares && isReleased(config, "sealedshare");
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
  // And Link Reader, which needs Documents.
  const linkReader =
    !!config && isReleased(config, "linkreader") && isReleased(config, "documents");
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
        <li>
          Device Vault keeps device-only chats encrypted in this browser with your passphrase; ANONYMA's servers store none of them, and they can't be recovered without the passphrase.
        </li>
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
      {routines && (
        <p>
          The export also includes your routines and their inbox runs.
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
