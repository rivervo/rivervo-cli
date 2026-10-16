# rivervo

Rivervo Applications from the command line: deploy, follow a build, read logs, manage
variables, roll back, open a shell in a running service. One file, no dependencies, Node.js 22 or newer.

## Install

```sh
npm install -g rivervo          # once the package is published
# or straight from a checkout / a packed file:
npm install -g ./rivervo-1.1.0.tgz
```

## Sign in

Create a token in the panel: **Account settings → API tokens**. Choose what it may do:

| Scope    | Allows |
|----------|--------|
| `read`   | apps, deployments and their logs, runtime logs, domains |
| `deploy` | read + deploy, redeploy, roll back, restart |
| `full`   | deploy + variables (read and change), domains and `rivervo shell` |

The token is shown once. Then:

```sh
rivervo login                  # paste the token; it is checked and saved
rivervo login --token "$TOKEN" # non-interactive
```

The token is saved in `~/.config/rivervo/config.json` (or `$XDG_CONFIG_HOME/rivervo`), readable
only by you. `rivervo logout` removes it from this computer — revoke it in the panel to disable it.

In CI, skip `login` and set `RIVERVO_TOKEN`.

## Use

```sh
rivervo apps                              # your apps and their services
rivervo deploy shop                       # build the latest commit and follow the deploy
rivervo deploy shop --no-build            # deploy the running version again (applies changed variables)
rivervo deploy shop --detach              # start it and return
rivervo logs shop -f                      # the app's output, following new lines
rivervo logs shop -n 500 --process w1     # the last 500 lines of the first background worker
rivervo env ls shop                       # names (values with --reveal)
rivervo env set shop API_URL=https://… DEBUG=0 [--target production]
rivervo env rm shop DEBUG
rivervo rollback shop                     # back to the previous version
rivervo rollback shop 1234                # back to deployment 1234
rivervo open shop                         # open it in the browser
rivervo shell shop                        # an interactive shell in the running app (tinker, psql, Tab, arrows)
rivervo shell shop --process w1           # … in its first background worker (i2: its second instance)
echo 'php artisan about' | rivervo shell shop   # input from a pipe: the shell ends with it
```

`rivervo shell` connects straight to the app's own address (`wss://<slug>.rivervo.app`) with a one-time ticket
from the API; your terminal is raw while it lasts, and the command exits with the shell's exit code. It closes
after 30 minutes without activity and after 4 hours at most; at most 2 can be open to a service at once.
Opening one is noted in the account's activity; what you type is not recorded. Needs a `full` token.

`[app]` is an app's id, address (`shop` in `shop.rivervo.app`) or name, or the id of a service
(a worker, a database). Leave it out when you have one app, or set `--app` / `RIVERVO_APP`.

Variables reach the app with its next deploy: after `env set`/`env rm`, run
`rivervo deploy <app> --no-build`.

`deploy` and `rollback` exit with 0 when the new version is live and 1 when it did not finish,
so they can gate a CI job. Add `--json` to any command for the API's JSON.

### Team accounts

If you are a member of someone else's account, add `--account <their customer ID>` (or set
`RIVERVO_ACCOUNT`). Your role there applies, exactly as in the panel; the token's scope applies on
top of it.

### Environment

| Variable | |
|---|---|
| `RIVERVO_TOKEN` | a token to use instead of the saved one |
| `RIVERVO_API_URL` | the API, default `https://api.rivervo.com/api/v1` |
| `RIVERVO_APP` | the app when none is given |
| `RIVERVO_ACCOUNT` | the account to work in |
| `RIVERVO_LANG` | language of the API's messages: `en` (default), `az`, `ru` |

## The API

The CLI uses the public API, documented in OpenAPI 3.1 at
`https://api.rivervo.com/api/v1/openapi.json`. Limits: 120 requests a minute per person, of them
30 changes (the server answers 429 with `Retry-After` past them).

## Develop

```sh
npm test        # node:test against a mocked API
```
