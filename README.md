# jev-sift

Site: https://jev-sift.vercel.app

Every search Claude Code runs — grep, file globs, file reads, web search — goes through Jev before Claude sees it. Off-topic results are cut; everything relevant arrives untouched.

## Install

Inside Claude Code:

```
/plugin
```

Add the marketplace `bytelabs-oss/jev-sift`, then install **jev-sift**. You will be asked for your TypeSafe key (typesafe.ai); it is stored in your keychain.

Or from the terminal:

```
claude plugin marketplace add bytelabs-oss/jev-sift
claude plugin install jev-sift@jev-sift          # asks for the key in your next session, or add --config TYPESAFE_API_KEY=<key>
```

That is all. The status line `jev-sift on · 12 cut · 1.1k tks saved` appears from your next session (unless you already have a status line of your own, which is left alone).

- Off / on: `/plugin` → jev-sift → disable / enable
- `/jev-sift last` shows what the last call cut; `/jev-sift status` shows totals

## Develop

`npm install`, then `./build.sh` bundles `src/hook-filter.ts` into `plugins/jev-sift/hook.js`. The marketplace is `.claude-plugin/marketplace.json`; the plugin is `plugins/jev-sift/`.
