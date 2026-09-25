![Anonyma — One workspace. Many models.](docs/assets/anonyma-header.png)

# Anonyma

Anonyma is a web workspace for using AI models through a shared account and
prepaid credit balance. This repository contains the React client, Node.js API,
SQLite accounting and conversation storage, model gateway integration, CLI,
and application tests.

The hosted app includes chat, Code & Build, Live Web Search, Veil, Uncensored Models, a small model selection, dashboard,
account and credits. The source also includes image, audio, video, collaboration,
and developer features whose availability is controlled by release gates.
Source availability does not mean every feature is enabled on the hosted app.

## Contract address

```
0x968be0c1a394bf1ce239e3b40909ec0f9d4f5583
```

## Featured releases

[Code & Build](docs/releases/code-and-build.md): a dedicated code workspace,
generated files beside the chat and ZIP export. Code & Build is now enabled on
[askanonyma.com](https://askanonyma.com/workspace/code). Includes its launch film.

[Live Web Search](docs/releases/live-web-search.md): turn on Web in chat to
request current web information and follow cited sources. Includes its launch film.

[Veil](docs/releases/veil.md): masks emails, card numbers, phone numbers, keys
and other private details in your browser before a prompt is sent, then restores
them on screen. Enabled on [askanonyma.com](https://askanonyma.com/workspace/chat). Includes its launch film.

[Uncensored Models](docs/releases/uncensored-models.md): a dedicated section and
curated model picker, using the same prepaid balance. Includes its launch film.

[Private Mode](docs/releases/private-mode.md): one switch for zero-data-retention
models only, nothing saved and Veil on, in Chat and Uncensored. Ships with
Ephemeral Chats. Includes its launch film.

## How it works

1. Create an account and choose an available model.
2. Send a request. The backend reserves credits and routes it to a configured
   model provider; chat responses can stream back to the client.
3. The backend records usage, settles the credit reservation, and stores the
   conversation. Real generation requires separately configured provider access.

## Run locally

Use Node.js 22.13 or newer and npm. From a clone of this repository:

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5175. The example configuration enables **local test mode**
and stores disposable state in `runtime/local-test/`. Register a local account
to receive synthetic test credits. Test responses and payments are simulations;
they do not establish that a provider or payment service works in production.

`npm ci` configures this clone's Git identity and hooks through its `prepare`
script. If install scripts were disabled, run `npm run identity:setup` manually.
Global Git settings are unchanged.

```sh
npm test
npm run build
```

The build produces the client in `dist/client/`. The API starts with `npm start`.
Live provider requests require your own credentials and account funding. Keep
credentials in an untracked local environment file. Do not expose test mode to
the internet or use its synthetic balances as real credit.

## Deliberately absent

This is an allowlisted mirror. Production deployment scripts, infrastructure
configuration, hosted-service settings, credentials, customer data, database
exports, private operational instructions, internal campaign materials and
unreviewed third-party assets are not included. API contracts are represented
in `server/openapi.js`; there are no standalone deployed smart-contract sources
in this repository.

## Limitations

- Model availability, pricing and capabilities depend on external providers.
- Local test mode demonstrates application behavior using fixtures; it does
  not perform real inference or transfer money.
- Wallet payments, email delivery and optional services require their own
  configuration and independent verification. This repository is not a turnkey
  production deployment or a security audit certification.
- Historical commits are filtered and may not run independently. See
  [HISTORY.md](HISTORY.md) for the transformation and provenance disclosure.
- Generated output can be incorrect. No end-to-end anonymity guarantee is made;
  external providers and hosting infrastructure have their own data handling.

## License

Original code: **PolyForm Noncommercial 1.0.0**. Original docs and art:
**CC BY-NC 4.0**. This is noncommercial source-available software. Third-party
components retain their own licenses. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Release checks and recovery

Run `npm run release:check` from a clean checkout before release. Install Gitleaks 8.30.1, Redis and redis-cli first; missing required checks fail. The check verifies contributor identity, static code, dependencies, secrets, the production build and tests. See [deployment and recovery](docs/operations/deployment.md) and [private security reporting](SECURITY.md).
