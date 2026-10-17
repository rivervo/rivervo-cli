# rivervo

Rivervo Applications from the command line: deploy, follow a build, read logs, manage
variables, roll back, open a shell in a running service. One file, no dependencies, Node.js 22 or newer.

## Install

```sh
npm install -g rivervo
# or straight from a checkout / a packed file:
npm install -g ./rivervo-1.2.0.tgz
```

## Sign in

Create a token in the panel: **Account settings → API tokens**. Choose what it may do:

| Scope    | Allows |
|----------|--------|
| `read`   | applications, deployments and their logs, runtime logs, domains, usage (if your role sees money) |
| `deploy` | read + deploy, redeploy, roll back, restart |
| `full`   | deploy + variables (a service's own and the application's shared ones), domains and `rivervo shell` |

The token is shown once. Then:

```sh
rivervo login                  # paste the token; it is checked and saved
rivervo login --token "$TOKEN" # non-interactive
```

The token is saved in `~/.config/rivervo/config.json` (or `$XDG_CONFIG_HOME/rivervo`), readable
only by you. `rivervo logout` removes it from this computer — revoke it in the panel to disable it.

In CI, skip `login` and set `RIVERVO_TOKEN`.

## Applications and services

An **application** is a group of equal services: web services, background workers, cron jobs, databases.
Name a service as `application/service` — `shop/web`, `shop/worker`, `shop/db` — with the application's
short name (or name) and the service's name, as `rivervo apps` lists them. Also accepted: a service's
id, its address (`shopx` in `shopx.rivervo.app`, as before) or its name when only one service has it.
An application's name alone (`shop`) means its only code service; when it has several, the CLI lists them.

## Use

```sh
rivervo apps                              # your applications and their services
rivervo link shop/web                     # this directory works with shop/web (saved in .rivervo)
rivervo deploy shop                       # build the latest commit and follow the deploy
rivervo deploy shop --no-build            # deploy the running version again (applies changed variables)
rivervo deploy shop --detach              # start it and return
rivervo logs shop -f                      # the app's output, following new lines
rivervo logs shop -n 500 --process w1     # the last 500 lines of the first background worker
rivervo env ls shop                       # names (values with --reveal)
rivervo env set shop API_URL=https://… DEBUG=0 [--target production]
rivervo env rm shop DEBUG
rivervo env ls --shared shop              # the application's shared variables (every code service gets them)
rivervo env set --shared shop MAIL_FROM=hi@example.com
rivervo env rm --shared shop MAIL_FROM
rivervo usage shop                        # spent this month, forecast, next payment, spending limit
rivervo usage shop --month 2026-09
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

`[app]` is a service (see above). Leave it out when the directory is linked (`rivervo link`), when you have
one application with one code service, or set `--app` / `RIVERVO_APP`. `[application]` (for `--shared` and
`usage`) is an application's short name or name, or any of its services.

`rivervo link [app]` writes `.rivervo` in the current directory: `{"project": <application id>, "service":
<service id>}` (ids, so renaming does not break it). Commands in that directory and below use it when no app is
given; an app given on the command line wins. `rivervo unlink` removes it. A file holding `{"app": <id>}` is
read as a service id.

Shared variables reach each code service with its next deploy; a service's own variable of the same name wins.

`rivervo usage` shows money, so it works for the account owner, Administrators of the application or the
account, and the account's Billing role; others get a message saying so. Amounts are without tax, for a
calendar month (UTC).

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
| `RIVERVO_APP` | the app when none is given (before the directory's link) |
| `RIVERVO_ACCOUNT` | the account to work in |
| `RIVERVO_LANG` | language of the API's messages: `en` (default), `az`, `ru` |

## The API

The CLI uses the public API, documented in OpenAPI 3.1 at
`https://api.rivervo.com/api/v1/openapi.json`. Against an API from before applications (no
`/apps/projects`), `rivervo apps` shows the older list of apps and their services. Limits: 120 requests a minute per person, of them
30 changes (the server answers 429 with `Retry-After` past them).

## Develop

```sh
npm test        # node:test against a mocked API
```
