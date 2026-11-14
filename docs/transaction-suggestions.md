# Transaction suggestions

Securo can suggest a category and a payee for uncategorized transactions, and flag rows that look like a transfer between own accounts or a recurring charge. An administrator picks the engine in **Admin Settings → Transaction suggestions**. Members with write access then get a **Suggest** button on the Transactions page, for the uncategorized rows on screen, and in the dashboard's **Uncategorized transactions** panel, for all of them. Suggestions with a confidence of 80% or more start selected; nothing is applied until the user confirms.

Neither engine replaces rules. Rules run first on import and stay the deterministic, auditable path. Suggestions only cover what rules did not.

## Engines

| Engine | Where it runs | What leaves the browser or server |
|---|---|---|
| **Off** (default) | — | Nothing |
| **In the browser** | Each user's browser, on WebGPU when available, WebAssembly otherwise | Nothing about transactions. The browser downloads the model weights once from Hugging Face (about 120 MB for the default) and caches them |
| **Remote decision API** | The Securo server calls a decision model | Per transaction: description, raw payee text and the bank's counterparty name, with IBANs and long digit runs masked; direction, amount, currency; the workspace's category names and matching payee names. Never the counterparty's IBAN |

### In the browser

The browser embeds the user's latest 2,000 transactions with a small sentence-embedding model (default `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, multilingual). Only transactions with a category or payee are used. The text is the description plus the stored payee, or, when the connection stores none, the counterparty name from the bank's raw data. A neighbour paid to or from the same counterparty IBAN (or, for Pluggy, the same bank account) counts as an exact match whatever the text says, which settles rent, salary and other bank transfers. Card payments carry no counterparty account. Words that appear in a fifth or more of the user's transactions (and at least five) are treated as the bank's boilerplate and dropped first, so lines such as `VISA Debitkartenumsatz vom 14.08.2026` are compared only on what follows. A row with nothing left, typically one whose merchant the bank sent in no field at all, gets no suggestion. Each remaining uncategorized row then takes a vote from its nearest neighbours. Similarity is the better of the embedding's cosine and a character-trigram overlap. The embedding groups similar kinds of shop, which helps choose the category. The trigram overlap catches one merchant written two ways. Payees are only voted on by neighbours that look like the same merchant. The ONNX runtime is served by Securo itself and is loaded only when the dialog is opened.

Any Hugging Face sentence-embedding model with ONNX weights can be set instead (for example `onnx-community/embeddinggemma-300m-ONNX`). Quality depends on how much labelled history a user has. With none, there are no suggestions.

### Remote decision API

The server speaks TypeSafe's `/v1/systemone` decision format: one request per transaction with a `category` and a `payee` choice question plus `transfer` and `recurring` yes/no questions, answered with probabilities. The API key is encrypted like the [provider credentials](provider-settings.md) and is never returned. Presets:

| Preset | URL | Model |
|---|---|---|
| TypeSafe (Jev) | `https://api.typesafe.ai/v1/systemone` | `jev-1.13.0` |
| OpenRouter (Jev) | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` |
| Ollaya, self-hosted | `http://ollaya:11435/v1/systemone` | `kev:0.8b` (also `laya`, `clef`, …) |

[Ollaya](https://github.com/ollaya-dev/ollaya) serves open decision models on your own hardware with the same API, so the data stays on your network. The URL must be reachable from the backend container. Any other service with the same wire format works with **Custom**. Small open models are much weaker than hosted ones out of the box, so check their suggestions before raising trust in them.
