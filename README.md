# rivervo

Rivervo Applications from the command line: deploy, follow a build, read logs, manage
variables, roll back, open a shell in a running service. One file, no dependencies, Node.js 22 or newer.

## Install

```sh
npm install -g rivervo
# or straight from a checkout / a packed file:
npm install -g ./rivervo-1.3.0.tgz
```

## Sign in

Create a token in the panel: **Account settings → API tokens**. Choose what it may do:

| Scope    | Allows |
|----------|--------|
| `read`   | applications, deployments and their logs, runtime logs, domains, usage (if your role sees money) |
| `deploy` | read + deploy, redeploy, roll back, restart |
| `full`   | deploy + variables (a service's own and the application's shared ones), domains, a public address on or off, adding a service and `rivervo shell` |

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
rivervo apps                              # your applications and their services (rivervo services: the same)
rivervo services info shop/api            # a service: status, public and internal address, repository, resources
rivervo services set-public shop/api off  # internal only: no public address (asks first; --yes / -y does not)
rivervo services set-public shop/api on   # a public address again (on|off, true|false, public|internal)
rivervo services add shop                 # add a service: asks what it is, shows the price, adds it once confirmed
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
rivervo open shop                         # open it in the browser (an internal-only service has no address to open)
rivervo shell shop                        # an interactive shell in the running app (tinker, psql, Tab, arrows)
rivervo shell shop --process w1           # … in its first background worker (i2: its second instance)
echo 'php artisan about' | rivervo shell shop   # input from a pipe: the shell ends with it
```

`rivervo shell` connects to the server the service runs on, over `wss://`, with a one-time ticket; both the
address and the ticket come from the API. Your terminal is raw while it lasts, and the command exits with the
shell's exit code. It closes after 30 minutes without activity and after 4 hours at most; at most 2 can be open
to a service at once.
Opening one is noted in the account's activity; what you type is not recorded. Needs a `full` token.

### Public address or internal only

A web service has a public address (`https://<slug>.rivervo.app`, and its custom domains) or is **internal
only**: it has no public address, no domains and no previews, and only the other services of its application
reach it, inside their private network. The other code services of the application get its address there,
public or not, in a variable `RIVERVO_<NAME>_URL` named after it (`RIVERVO_BACKEND_URL=http://backend:8080`);
`rivervo apps` and `rivervo services info` show it as the internal address.

`rivervo services set-public [app] on|off` switches it; nothing restarts. Turning it off asks first in a
terminal (Enter means no); in a script, pass `--yes`. A service with custom domains or previews is refused
until they are removed or turned off, and so is any switch while a deploy is running. It needs a `full` token
and the Administrator role in the application (or the account owner). `rivervo open` on an internal-only
service shows its internal address instead of opening a browser.

New applications are created in the panel; services are added to one with `rivervo services add`
(below), as public or internal only.

### Adding a service

`rivervo services add [application]` adds a web service, a background worker, a cron job, or a PostgreSQL,
MySQL or Valkey (`redis`) database to an existing application. In a terminal it asks for what the flags leave
out, step by step: the type, the name, for a web service a public address or internal only (no default: one
has to be chosen), where the code comes from (`project` — the code of one of the application's services, run
with another command; `repo` — a GitHub repository; `image` — a Docker image), and the resources, with the
defaults for its kind. **The price comes first**: what the service adds to the application's monthly bill and
what is charged now (amounts without tax, from the same calculation as the panel's), and the service is added
only once you confirm it (`[y/N]`, Enter is no). If the price changes before that, the new one is shown and
asked about again.

Without a terminal give everything as flags and `--yes`; a missing one is named and nothing is added, and
without `--yes` only the price is printed (exit 1). It needs a `full` token and the Administrator role in the
application; a service from another repository can be added only by the account owner.

```sh
rivervo services add shop                 # asked step by step
rivervo services add shop --type web --name api --internal --source image --image nginx:1.27 --port 80 --yes
rivervo services add shop --type worker --name jobs --source project --from web --command 'php artisan queue:work' --yes
rivervo services add shop --type cron --name nightly --command 'php artisan backup' --schedule '0 3 * * *' --yes
rivervo services add shop --type postgres --name db --memory 2048 --yes
rivervo services add shop --type web --name site --public --source repo --repo acme/site --branch main \
  --var APP_ENV=production --yes
```

`--from` is the service whose code it runs (default: the application's first one); `--registry-user` and
`--registry-password` reach a private image; `--memory` (MB), `--cpus`, `--disk` (GB) and repeated
`--var KEY=value` are optional. `--json` prints the added service (or, without `--yes`, the quote).

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
